// Shared by the folder specs (folder*.spec.mjs) and live.spec.mjs: the fixture folder, the browser's origin-private
// folder and its picker, and a stand-in for the desktop shell.
//
// Browser: the folder is tests/fixtures/folder, written into the origin-private file system (OPFS), whose handles
// are real FileSystemDirectoryHandles (listing, reading, resolve(), isSameEntry(), IndexedDB), and the folder picker
// is replaced by one that returns it. Desktop: a stand-in for the shell answers the bridge's commands (as
// desktop.spec.mjs does) and records them; the shell's own walk is tested by its unit tests
// (desktop/src-tauri/src/folders.rs) and by the app's self-test (--expect folder).
//
// Documents are shown by the viewer's own load seam (mdvOpenDocument, js/files.js); a recorder wraps it
// (window.__opened) so a test can tell which opens reached it.
import { expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { collectProblems } from './support/viewer.mjs';

export const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const FIXTURE = repo('tests/fixtures/folder');
export const EXPECTED = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));
export const APP_CSP = Object.entries(JSON.parse(readFileSync(repo('desktop/src-tauri/tauri.conf.json'), 'utf8')).app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`).join('; ');

function readTree(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, readTree(full));
    else out[relative(FIXTURE, full).split(sep).join('/')] = readFileSync(full, 'utf8');
  }
  return out;
}
export const FILES = Object.assign(readTree(FIXTURE), EXPECTED.addedAtRunTime);

// ------- The browser: an OPFS folder and the picker -------
// permission: what queryPermission says until the page asks (requestPermission then grants), for a browser that
// asks again after a reload. A slow disk: window.__slowNames (file names) or window.__slowAll, set by a test, make
// those reads take 900 ms; holdReads (below) makes a file's reads wait until the test lets them go.
export async function browserSetup(page, { permission = 'granted', folder = 'notes' } = {}) {
  await page.addInitScript(({ permission, folder }) => {
    window.__opened = [];
    window.__pickerCalls = 0;
    window.__permissionRequests = 0;
    window.__slowNames = [];
    // The picker returns the folder named by window.__pickFolder (a test sets it to choose another), else `folder`.
    window.showDirectoryPicker = async () => {
      window.__pickerCalls++;
      let dir = await navigator.storage.getDirectory();
      for (const part of (window.__pickFolder || folder).split('/')) dir = await dir.getDirectoryHandle(part);
      return dir;
    };
    // A remembered folder whose permission the browser dropped: it must be asked for again, from a click.
    if (permission !== 'granted') {
      const proto = FileSystemHandle.prototype;
      let granted = false;
      proto.queryPermission = async function () { return granted ? 'granted' : permission; };
      proto.requestPermission = async function () { window.__permissionRequests++; granted = true; return 'granted'; };
    }
    // A slow disk for the files named in window.__slowNames (or every file with window.__slowAll), and reads held
    // until the test lets them go (window.__held: file name → a promise).
    window.__held = {};
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = async function () {
      if (window.__slowAll || window.__slowNames.includes(this.name)) await new Promise((r) => setTimeout(r, 900));
      if (window.__held[this.name]) await window.__held[this.name].promise;
      return getFile.call(this);
    };
    document.addEventListener('DOMContentLoaded', () => {
      const open = window.mdvOpenDocument;
      window.mdvOpenDocument = (doc, opts) => {
        window.__opened.push({ path: doc.path, name: doc.name, push: !!(opts && opts.push), handle: !!doc.handle, text: typeof doc.text === 'string', position: !!(opts && opts.position) });
        return open(doc, opts);
      };
    });
  }, { permission, folder });
}

export async function seed(page, files = FILES, folder = 'notes') {
  await page.evaluate(async ({ files, folder }) => {
    let root = await navigator.storage.getDirectory();
    for (const part of folder.split('/')) root = await root.getDirectoryHandle(part, { create: true });
    for (const [rel, text] of Object.entries(files)) {
      const parts = rel.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await file.createWritable();
      await w.write(text);
      await w.close();
    }
  }, { files, folder });
}

// Every read of the file named `name` (in the desktop app: the file at that path) waits until letGo(page, name): a
// read that takes as long as the test needs.
export const holdReads = (page, name) => page.evaluate((name) => {
  let release;
  const promise = new Promise((r) => { release = r; });
  window.__held[name] = { promise, release };
}, name);
export const letGo = (page, name) => page.evaluate((name) => {
  const held = window.__held[name];
  delete window.__held[name];
  if (held) held.release();
}, name);

export async function removeFile(page, rel, folder = 'notes') {
  await page.evaluate(async ({ rel, folder }) => {
    let dir = await navigator.storage.getDirectory();
    for (const part of folder.split('/')) dir = await dir.getDirectoryHandle(part);
    const parts = rel.split('/');
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    await dir.removeEntry(parts[parts.length - 1]);
  }, { rel, folder });
}

export async function openFolder(page) {
  await page.click('#mdvFolderBtn');
  await expect(page.locator('#mdvFolderTree [data-path]').first()).toBeVisible();
}

export const listedPaths = (page) => page.locator('#mdvFolderTree [data-path]').evaluateAll((els) => els.map((e) => e.dataset.path));
// A heading's own words (its aria-label), without the fold toggle and the '#' permalink the viewer adds.
export const heading = (page) => page.locator('#mdBody h1').first();
export const expectTitle = (page, text) => expect(heading(page)).toHaveAttribute('aria-label', text);
export const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));

export async function start(page, options) {
  const problems = collectProblems(page);
  await browserSetup(page, options);
  await page.goto('markdown-viewer.html');
  await seed(page);
  return problems;
}

// Opens a file of the open folder from the sidebar and waits for its first heading.
export async function openInTree(page, path, title) {
  await page.locator(`#mdvFolderTree [data-path="${path}"]`).click();
  await expectTitle(page, title);
}

// The listing is older than the few seconds after which quick open, search in files and a window focus list the
// folder again (MDV_FOLDER_STALE_MS), as it is once the reader has been reading for a while.
export const ageListing = (page) => page.evaluate(() => { mdvFolderState.listedAt -= MDV_FOLDER_STALE_MS + 1000; });

// ------- The desktop app: a stand-in shell -------
export const ROOT = '/work/notes';
export const abs = (rel) => `${ROOT}/${rel}`;
export const desktopDoc = (rel) => ({ path: abs(rel), name: rel.split('/').pop(), text: FILES[rel], mtimeMs: 1000, version: `v-${rel}`, readOnly: null, reason: 'initial' });
export const LISTING = {
  root: ROOT, name: 'notes', truncated: false, unreadable: 0,
  entries: EXPECTED.listed.map((rel) => ({ path: abs(rel), rel, name: rel.split('/').pop(), depth: rel.split('/').length - 1, size: FILES[rel].length, mtimeMs: 1000 })),
};

export async function desktopSetup(page, { doc = desktopDoc('README.md'), storage = {} } = {}) {
  await page.route('**/markdown-viewer.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: Object.assign({}, response.headers(), { 'content-security-policy': APP_CSP }) });
  });
  const disk = {};
  for (const rel of Object.keys(FILES)) disk[abs(rel)] = desktopDoc(rel);
  await page.addInitScript(({ doc, disk, listing, storage }) => {
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    const calls = [];
    window.__shell = { calls, disk, listing };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path,
        async invoke(cmd, args) {
          calls.push({ cmd, args: args || {} });
          switch (cmd) {
            case 'mdv_initial_document': return doc;
            case 'mdv_read_document':
              if (window.__held[args.path]) await window.__held[args.path].promise;
              if (disk[args.path]) return Object.assign({}, disk[args.path], { reason: 'reload' });
              return Promise.reject({ code: 'not-found', message: `${args.path} does not exist.` });
            case 'mdv_list_directory':
              if (args.root === listing.root) return listing;
              return Promise.reject({ code: 'not-found', message: `${args.root} does not exist.` });
            case 'mdv_choose_folder': return listing.root;
            case 'mdv_open_path': return null;
            case 'mdv_self_test_requested': return false;
            default: return null;
          }
        },
      },
      event: { async listen() { return () => {}; } },
    };
    window.__opened = [];
    window.__held = {};
    document.addEventListener('DOMContentLoaded', () => {
      const open = window.mdvOpenDocument;
      window.mdvOpenDocument = (d, opts) => { window.__opened.push({ path: d.path, push: !!(opts && opts.push), handle: d.handle }); return open(d, opts); };
    });
  }, { doc, disk, listing: LISTING, storage });
}

export const shellCalls = (page, cmd) => page.evaluate((c) => window.__shell.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

// Dialogs, menus and the card fade in; a screenshot waits until nothing on the page is animating.
export async function settled(page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  await page.waitForTimeout(60);
}

export { collectProblems };
