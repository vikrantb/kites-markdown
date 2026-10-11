// Runs the built app's self-test on a document and checks its report. Used locally and by CI.
//
//   node scripts/run-self-test.mjs --doc <file.md> --expect <check>[,<check>…] [options]
//   node scripts/run-self-test.mjs --report <result.json> --expect <check>[,…]     (check a saved report)
//
// The document is first copied (with its folder) to a scratch folder, because the save probe writes to it.
//
// Options:
//   --app <path>     the app: a .app bundle, or the program itself (.exe / binary). Default: the newest
//                    macOS bundle under src-tauri/target, or src-tauri/target/release/kites-markdown(.exe).
//   --save-probe     also check saving, conflict detection and live reload (writes to the scratch copy)
//   --launch <how>   args (default): pass --self-test on the command line;
//                    open (macOS): `open -a <app>` with the file, the path Finder takes for Open With;
//                    default (macOS): `open` with the file and no app named, so macOS picks the app exactly
//                    as for a Finder double-click. It first checks that the app macOS picks IS --app, and
//                    fails at once otherwise. For an installed app that has been made the default.
//                    registry (Windows): the open command the installer registered for .md files, the
//                    command Explorer runs on a double-click.
//   --out <json>     where to keep the report (default: a file in the system temp folder)
//   --keep-registration   macOS: leave a build that is not in /Applications registered with Launch
//                    Services. By default it is unregistered after the run: macOS makes a newly launched
//                    app the automatic handler for a type nobody chose a default for, so a build folder
//                    would otherwise start opening the person's .md files.
//
// Checks (--expect): render (no errors, every diagram drawn, the bridge refused what it must, on macOS
// confirm() reached a dialog, and what the app remembers between launches was left as it was), kitchen-sink (the sample's features all rendered), assets (images in the
// document's folder load, one in a dot-folder included; one outside the folder does not), save (the save
// probe passed), no-inline-handlers (none left for the app's CSP to block), types (macOS: every extension
// the app claims resolves to a Markdown type, not an anonymous dyn.* type that no app claims, and the app
// is among the apps that can open that type; launch with open or default, so Launch Services has
// registered the build); folder (the document's folder, with a .git and a node_modules folder added to the scratch
// copy, is listed by mdv_list_directory exactly as tests/fixtures/folder/expected.json says, a file is refused as
// not a folder, and the sidebar draws the listing with the document marked; use it with
// --doc tests/fixtures/folder/README.md).
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);

const checks = (opt('--expect') || 'render').split(',').map((s) => s.trim()).filter(Boolean);
const launch = opt('--launch') || 'args';

function findApp() {
  const target = join(desktop, 'src-tauri', 'target');
  const bundles = [];
  for (const dir of existsSync(target) ? readdirSync(target) : []) {
    for (const base of [join(target, dir, 'release', 'bundle', 'macos'), join(target, 'release', 'bundle', 'macos')]) {
      const app = join(base, 'Kites Markdown.app');
      if (existsSync(app)) bundles.push(app);
    }
  }
  if (bundles.length) return bundles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const exe = join(target, 'release', process.platform === 'win32' ? 'kites-markdown.exe' : 'kites-markdown');
  return existsSync(exe) ? exe : null;
}

// The folder fixture's expectations, shared with the browser tests (tests/e2e/folder.spec.mjs).
const FOLDER_EXPECTED = JSON.parse(readFileSync(join(desktop, '..', 'tests', 'fixtures', 'folder', 'expected.json'), 'utf8'));
const SIBLING = 'kites-self-test-sibling.md';

function programOf(app) {
  return app.endsWith('.app') ? join(app, 'Contents', 'MacOS', 'kites-markdown') : app;
}

// Copies the document's folder to a scratch place; the linked fixture also needs its parent's outside.png.
// A sibling Markdown file is added for the bridge probe, which must fail to save into it.
function scratchCopy(doc) {
  const scratch = mkdtempSync(join(tmpdir(), 'kites-self-test-'));
  const folder = dirname(doc);
  const parent = dirname(folder);
  const outside = join(parent, 'outside.png');
  const copyFolder = join(scratch, 'work', basename(folder));
  mkdirSync(copyFolder, { recursive: true });
  if (basename(folder) === 'samples') cpSync(doc, join(copyFolder, basename(doc)));
  else cpSync(folder, copyFolder, { recursive: true });
  if (existsSync(outside)) cpSync(outside, join(scratch, 'work', 'outside.png'));
  writeFileSync(join(copyFolder, SIBLING), '# A sibling of the document\n\nThe self-test must not be able to save into this file.\n');
  // Folders the sidebar must skip, which git cannot hold (.git) or ignores (node_modules).
  if (checks.includes('folder')) {
    for (const [rel, text] of Object.entries(FOLDER_EXPECTED.addedAtRunTime)) {
      mkdirSync(dirname(join(copyFolder, rel)), { recursive: true });
      writeFileSync(join(copyFolder, rel), text);
    }
  }
  return { scratch, doc: join(copyFolder, basename(doc)) };
}

function run(command, commandArgs, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { env: Object.assign({}, process.env, env), stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); resolvePromise({ code: null, timedOut: true }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise({ code, timedOut: false }); });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ code: null, error: e.message }); });
  });
}

function registeredCommand() {
  const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\KitesMarkdown.Document\\shell\\open\\command', '/ve'], { encoding: 'utf8' });
  const line = out.split(/\r?\n/).find((l) => /REG_SZ/.test(l));
  if (!line) throw new Error('no open command is registered for KitesMarkdown.Document');
  const command = line.split('REG_SZ').pop().trim();
  const exe = /^"([^"]+)"/.exec(command);
  if (!exe || !/"%1"$/.test(command)) throw new Error(`unexpected open command: ${command}`);
  return { command, exe: exe[1] };
}

async function selfTest() {
  // Absolute, because `open -a` reads a relative path as the name of an installed app.
  const app = opt('--app') ? resolve(opt('--app')) : findApp();
  if (!app || !existsSync(app)) throw new Error(`no built app found (${app || 'src-tauri/target'}); build it with: pnpm build`);
  const docArg = opt('--doc');
  if (!docArg) throw new Error('--doc <file.md> is required');
  const { scratch, doc } = scratchCopy(resolve(docArg));
  const out = resolve(opt('--out') || join(tmpdir(), `kites-self-test-${Date.now()}.json`));
  mkdirSync(dirname(out), { recursive: true });
  // A report left by an earlier run must never pass for this one.
  rmSync(out, { force: true });
  const probe = flag('--save-probe');
  console.log(`app:      ${app}\ndocument: ${doc}\nlaunch:   ${launch}${probe ? ' (with the save probe)' : ''}`);
  let result;
  if (launch === 'open' || launch === 'default') {
    if (!app.endsWith('.app')) throw new Error(`--launch ${launch} needs a .app bundle`);
    const env = [`--env`, `KITES_MARKDOWN_SELF_TEST_OUT=${out}`].concat(probe ? ['--env', 'KITES_MARKDOWN_SELF_TEST_SAVE_PROBE=1'] : []);
    if (launch === 'default') {
      const opener = appMacOSOpens(doc);
      if (resolve(opener || '/') !== resolve(app)) {
        rmSync(scratch, { recursive: true, force: true });
        throw new Error(`a double-click on ${basename(doc)} opens ${opener || 'nothing'}, not ${app}: make it the default first`);
      }
    }
    result = await run('open', ['-W', '-n', ...(launch === 'open' ? ['-a', app] : []), ...env, doc], {}, 120_000);
  } else if (launch === 'registry') {
    const { command, exe } = registeredCommand();
    console.log(`registered command: ${command}`);
    const env = { KITES_MARKDOWN_SELF_TEST_OUT: out };
    if (probe) env.KITES_MARKDOWN_SELF_TEST_SAVE_PROBE = '1';
    result = await run(exe, [doc], env, 120_000);
  } else {
    const extra = probe ? ['--self-test-save-probe'] : [];
    result = await run(programOf(app), ['--self-test', doc, '--self-test-out', out, ...extra], {}, 120_000);
  }
  rmSync(scratch, { recursive: true, force: true });
  forgetBuild(app);
  if (result.timedOut) throw new Error('the app did not exit within 120 s');
  if (result.error) throw new Error(`could not start the app: ${result.error}`);
  if (!existsSync(out)) throw new Error(`the app exited (${result.code}) without writing ${out}`);
  return { report: JSON.parse(readFileSync(out, 'utf8')), exitCode: result.code, out };
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// The app macOS opens this file with (what a Finder double-click opens), as a path.
function appMacOSOpens(file) {
  const script = `ObjC.import('AppKit'); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(${JSON.stringify(file)})); u.isNil() ? '' : u.path.js`;
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).trim();
}

// Running a .app registers it with Launch Services. A build outside /Applications is unregistered again.
function forgetBuild(app) {
  if (process.platform !== 'darwin' || !app.endsWith('.app') || flag('--keep-registration')) return;
  if (resolve(app).startsWith('/Applications/')) return;
  try {
    execFileSync(LSREGISTER, ['-u', resolve(app)]);
    console.log('unregistered the build from Launch Services (keep it with --keep-registration)');
  } catch (e) {
    console.warn(`could not unregister ${app}: ${e.message}`);
  }
}

function mermaidFences(file) {
  return (readFileSync(file, 'utf8').match(/^```mermaid\s*$/gm) || []).length;
}

function verify(report, exitCode) {
  const problems = [];
  const v = report.viewer || {};
  const c = v.counts || {};
  const want = (ok, message) => { if (!ok) problems.push(message); };
  for (const check of checks) {
    if (check === 'render') {
      want(report.ok === true, `the app reported a failure: ${report.reason || ''} ${(v.failures || []).join('; ')}`);
      want(exitCode === undefined || exitCode === 0, `the app exited with ${exitCode}`);
      want(v.kind === 'desktop', `mdvHost.kind was ${v.kind}`);
      want(c.mermaidSvgs === c.mermaidBlocks, `${c.mermaidSvgs} of ${c.mermaidBlocks} diagrams drawn`);
      want(v.sanitization && v.sanitization.executed === false && v.sanitization.rawErrorFired === true, 'the script probe did not prove that document script is blocked');
      want(v.bridge && v.bridge.allRefused === true, 'the bridge did not refuse a request as it must');
      if (report.app && report.app.os === 'macos') {
        want(v.dialogs && v.dialogs.probed === true && v.dialogs.confirmReturned === true && report.dialogs && report.dialogs.ok === true, "confirm() did not reach the shell's dialog");
      }
      want(report.document && report.document.windowTitle === report.document.expectedTitle, 'the window title is not the file name');
      want(v.remembered && v.remembered.untouched === true, `the run changed what the app remembers between launches (recent documents, folder): ${JSON.stringify(v.remembered)}`);
      const scope = (report.document && report.document.assetScope) || {};
      want(scope.documentFolder === true && scope.dotFolder === true && scope.parentFolder === false, `the asset scope is not exactly the document folder and below: ${JSON.stringify(scope)}`);
    } else if (check === 'kitchen-sink') {
      const fences = mermaidFences(join(desktop, '..', 'samples', 'kitchen-sink.md'));
      want(c.mermaidBlocks === fences, `expected ${fences} diagrams, found ${c.mermaidBlocks}`);
      for (const k of ['h1', 'h2', 'tables', 'codeBlocks', 'katex', 'callouts', 'taskItems', 'footnotes']) want(c[k] > 0, `no ${k} rendered`);
      want(c.katexErrors === 0, `${c.katexErrors} math errors`);
    } else if (check === 'assets') {
      const i = v.images || {};
      want(i.total === 4, `expected the fixture's 4 images, found ${i.total}`);
      want(i.viaAssetProtocol === 3, `expected the 3 images in the document's folder to go through the asset protocol, ${i.viaAssetProtocol} did`);
      want(i.loaded === 3, `expected those 3 images to load, ${i.loaded} did`);
      want((i.loadedSources || []).some((s) => s.startsWith('.gitbook/')), 'the image in a dot-folder (.gitbook/) did not load');
      want((i.broken || []).some((s) => s.includes('../outside.png')), 'the image outside the document folder loaded; the asset scope is too wide');
    } else if (check === 'save') {
      want(v.save && v.save.ok === true, `the save probe failed: ${JSON.stringify(v.save && v.save.checks)}`);
    } else if (check === 'types') {
      const conf = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
      const claimed = (conf.bundle.fileAssociations || []).flatMap((a) => a.ext);
      const types = report.fileTypes;
      want(Array.isArray(types), 'the report has no file types (the types check is macOS-only)');
      if (Array.isArray(types)) {
        want(types.map((t) => t.ext).join() === claimed.join(), `the app checked ${types.map((t) => t.ext).join(', ')}, the config claims ${claimed.join(', ')}`);
        const wrong = types.filter((t) => !t.markdown).map((t) => `.${t.ext} → ${t.type || 'no type'}`);
        want(wrong.length === 0, `extensions that do not resolve to Markdown, so a double-click never opens them here: ${wrong.join(', ')}`);
        const unclaimed = types.filter((t) => t.claimed === false).map((t) => `.${t.ext} (${t.type})`);
        want(unclaimed.length === 0, `extensions whose type the app does not claim, so it is not offered for them: ${unclaimed.join(', ')}`);
      }
    } else if (check === 'folder') {
      const f = v.folder || {};
      const expected = FOLDER_EXPECTED.listed.concat(SIBLING).sort();
      const listed = Array.isArray(f.listed) ? f.listed.slice().sort() : null;
      want(!f.error, `mdv_list_directory failed: ${f.error}`);
      want(!!listed && listed.join('\n') === expected.join('\n'), `the folder listed ${JSON.stringify(f.listed)}, expected ${JSON.stringify(expected)}`);
      want(f.truncated === false && f.unreadable === 0, `the listing was cut short (truncated ${f.truncated}) or missed folders (unreadable ${f.unreadable})`);
      want(f.fileRefused && f.fileRefused.refused === true, `listing a file instead of a folder was not refused as not-a-directory (${f.fileRefused && f.fileRefused.code})`);
      want(f.sidebar && f.sidebar.files === expected.length, `the sidebar drew ${f.sidebar && f.sidebar.files} files, expected ${expected.length}`);
      const caseless = (p) => (report.app && report.app.os !== 'linux' ? String(p).toLowerCase() : String(p));
      want(f.sidebar && typeof f.sidebar.current === 'string' && caseless(f.sidebar.current) === caseless(v.path), `the sidebar did not mark the document: ${f.sidebar && f.sidebar.current} (document ${v.path})`);
    } else if (check === 'no-inline-handlers') {
      const h = v.inlineHandlers || {};
      want(h.count === 0, `${h.count} inline event handlers remain, and the app's CSP blocks them: ${(h.examples || []).join(', ')}`);
    } else {
      problems.push(`unknown check: ${check}`);
    }
  }
  return problems;
}

function summary(report) {
  const v = report.viewer || {};
  const c = v.counts || {};
  return [
    `ok: ${report.ok}  (${report.app ? `${report.app.os}/${report.app.arch}, launched by ${report.app.launchedBy}` : 'no app info'}, ${report.elapsedMs} ms)`,
    `rendered: h1 ${c.h1}, h2 ${c.h2}, tables ${c.tables}, diagrams ${c.mermaidSvgs}/${c.mermaidBlocks}, math ${c.katex} (errors ${c.katexErrors}), callouts ${c.callouts}, code ${c.codeBlocks}, threads ${c.commentThreads}`,
    `images: ${v.images ? `${v.images.loaded}/${v.images.total} loaded, ${v.images.viaAssetProtocol} via the asset protocol` : '-'}`,
    `script probe: ran ${v.sanitization ? v.sanitization.viaRawHtml + v.sanitization.viaRender : '?'} times (raw ${v.sanitization && v.sanitization.viaRawHtml}, render ${v.sanitization && v.sanitization.viaRender}); CSP violations during probes ${(v.cspViolationsDuringProbes || []).length}`,
    `bridge refusals: ${v.bridge ? Object.entries(v.bridge).filter(([k]) => k !== 'allRefused').map(([k, r]) => `${k}=${r.refused ? r.code : `WRONG (${r.missing || r.code || 'accepted'}, expected ${r.expected})`}`).join(', ') : '-'}`,
    `dialogs: ${v.dialogs && v.dialogs.probed ? `confirm() returned ${v.dialogs.confirmReturned}; the shell answered ${(report.dialogs && report.dialogs.answeredByShell || []).length}` : 'not probed on this platform'}`,
    `save probe: ${v.save ? JSON.stringify(v.save.checks) : 'not run'}`,
    `inline handlers left: ${v.inlineHandlers ? v.inlineHandlers.count : '?'}`,
    `remembered keys: ${v.remembered ? `real store untouched ${v.remembered.untouched}; the page's writes kept in memory: ${(v.remembered.keptInMemory || []).join(', ') || 'none'}` : 'not reported'}`,
    `folder: ${v.folder ? (v.folder.error ? `error: ${v.folder.error}` : `listed ${(v.folder.listed || []).length} (truncated ${v.folder.truncated}), a file refused as ${v.folder.fileRefused && v.folder.fileRefused.code}, sidebar ${v.folder.sidebar ? `${v.folder.sidebar.files} files, current ${v.folder.sidebar.current}` : 'not drawn'}`) : 'not probed'}`,
    `console errors ${(v.log && v.log.consoleErrors.length) ?? '?'}, page errors ${(v.log && v.log.pageErrors.length) ?? '?'}, CSP violations while rendering ${(v.log && v.log.cspViolations.length) ?? '?'}`,
    `window title: ${report.document && report.document.windowTitle}; default handler: ${report.defaultHandler || 'n/a'}`,
    `file types: ${Array.isArray(report.fileTypes) ? report.fileTypes.map((t) => `.${t.ext} ${t.markdown && t.claimed !== false ? '✓' : '✗'} ${t.type}${t.claimed === false ? ' (not claimed)' : ''}`).join(', ') : 'n/a'}`,
  ].join('\n');
}

try {
  let report;
  let exitCode;
  if (opt('--report')) {
    report = JSON.parse(readFileSync(resolve(opt('--report')), 'utf8'));
  } else {
    const r = await selfTest();
    report = r.report;
    exitCode = r.exitCode;
    console.log(`report:   ${r.out}`);
  }
  console.log(summary(report));
  const problems = verify(report, exitCode);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL  ${p}`);
    process.exit(1);
  }
  console.log(`PASS  ${checks.join(', ')}`);
} catch (e) {
  console.error(`FAIL  ${e.message}`);
  process.exit(1);
}
