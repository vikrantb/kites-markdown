// The desktop bridge (js/host.js), checked in a browser.
//
// In a browser the bridge must change nothing. For the desktop behaviour, a stand-in for the shell
// provides just enough of Tauri's injected API (window.__TAURI__ and window.__TAURI_INTERNALS__) and
// records every command the page sends, so the tests assert on what the page asked the shell to do. The
// page is served with the app's own Content Security Policy (from tauri.conf.json), so a control that the
// app's CSP disables is disabled here too.
// The real shell is tested by the app's own self-test (desktop/scripts/run-self-test.mjs), on macOS and
// Windows in CI.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const FIXTURE_DIR = '/desktop/tests/fixtures/linked';
const FIXTURE = readFileSync(repo('desktop/tests/fixtures/linked/doc.md'), 'utf8');
const APP_CSP = Object.entries(JSON.parse(readFileSync(repo('desktop/src-tauri/tauri.conf.json'), 'utf8')).app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`)
  .join('; ');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function longDocument(extra = '') {
  const sections = [];
  for (let i = 1; i <= 12; i++) {
    const paragraphs = Array.from({ length: 4 }, (_, j) => `Paragraph ${j + 1} of section ${i}. ` + 'Words to read. '.repeat(24)).join('\n\n');
    sections.push(`## Section ${i}\n\n${i === 1 ? extra : ''}${paragraphs}`);
  }
  return `# A long document\n\n${sections.join('\n\n')}\n`;
}

// Installs the stand-in shell before any page script runs.
//   doc            the window's document (null: the welcome screen)
//   disk           other files the shell can read, by path
//   csp            serve the page with the app's CSP (default true); false removes every policy, the
//                  page's own <meta> one included
//   holdInitial    the page's request for its document waits for __shell.releaseInitial()
//   initialError   the page's request for its document fails with this {code, message}
//   refuseSaves    every save is refused as a conflict with this {currentMtimeMs, currentVersion}
async function withShell(page, { doc = null, disk = {}, theme = 'light', selfTest = false, csp = true, holdInitial = false, initialError = null, refuseSaves = null } = {}) {
  if (csp) {
    await page.route('**/markdown-viewer.html', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: Object.assign({}, response.headers(), { 'content-security-policy': APP_CSP }) });
    });
  } else {
    // No CSP at all: the page also carries its own policy in a <meta> tag, which would still block the
    // inline handler a positive control needs to see run.
    await page.route('**/markdown-viewer.html', async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
      await route.fulfill({ response, body: html });
    });
  }
  await page.addInitScript(({ doc, disk, theme, selfTest, holdInitial, initialError, refuseSaves }) => {
    try { localStorage.setItem('mdv-theme', theme); } catch (_) { /* default theme */ }
    const calls = [];
    const listeners = {};
    let release = null;
    let savedVersions = 0;
    const refuse = (code, message) => Promise.reject({ code, message });
    const files = Object.assign({}, disk);
    if (doc) files[doc.path] = doc;
    window.__shell = {
      calls,
      disk: files,
      report: null,
      holdSaves: false,
      releaseSave: () => release && release(),
      releaseInitial: null,
      emit(event, payload) { for (const h of listeners[event] || []) h({ event, payload }); },
      commands: () => calls.map((c) => c.cmd),
    };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path.split('/').map(encodeURIComponent).join('/'),
        async invoke(cmd, args) {
          calls.push({ cmd, args: args || {} });
          switch (cmd) {
            case 'mdv_initial_document':
              if (initialError) return Promise.reject(initialError);
              if (holdInitial) return new Promise((resolve) => { window.__shell.releaseInitial = () => resolve(doc); });
              return doc;
            case 'mdv_self_test_requested': return selfTest;
            case 'mdv_self_test_options': return selfTest ? { saveProbe: false, dialogProbe: false } : null;
            case 'mdv_self_test_report': window.__shell.report = args.stats; return null;
            case 'mdv_read_document':
              if (files[args.path]) return Object.assign({}, files[args.path], { reason: 'reload' });
              return refuse('not-markdown', 'not a Markdown file');
            case 'mdv_save_document':
              if (!doc || args.path !== doc.path) return { ok: false, reason: 'not-allowed', message: 'A window saves only into the file it opened.' };
              if (window.__shell.holdSaves) await new Promise((r) => { release = r; });
              if (refuseSaves) return Object.assign({ ok: false, reason: 'conflict', message: 'The file changed on disk.' }, refuseSaves);
              savedVersions++;
              return { ok: true, mtimeMs: 1000 + savedVersions * 1000, version: `v-saved-${savedVersions}` };
            case 'mdv_open_path':
              return /\.(md|markdown)$/i.test(args.path) ? null : refuse('not-markdown', 'not a Markdown file');
            case 'mdv_open_external':
              return /^(https?|mailto):/i.test(args.url) ? null : refuse('not-allowed', 'links of that kind are not opened');
            case 'mdv_make_default': return { ok: true, message: 'Markdown files now open in Kites Markdown.' };
            default: return null;
          }
        },
      },
      event: {
        async listen(event, handler, options) {
          (listeners[event] = listeners[event] || []).push(handler);
          calls.push({ cmd: 'listen', args: { event, target: options && options.target } });
          return () => {};
        },
      },
    };
  }, { doc, disk, theme, selfTest, holdInitial, initialError, refuseSaves });
}

const fixtureDoc = { path: `${FIXTURE_DIR}/doc.md`, name: 'doc.md', text: FIXTURE, mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial' };

async function openApp(page, options) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await withShell(page, options);
  await page.goto('markdown-viewer.html');
  return errors;
}

const callsTo = (page, cmd) => page.evaluate((c) => window.__shell.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);
const changed = (page, payload) => page.evaluate((p) => window.__shell.emit('mdv://document-changed', p), payload);
// Tags the rendered heading, so a test can tell whether the document was rendered again.
const tagHeading = (page) => page.evaluate(() => { document.querySelector('#mdBody h1').dataset.probe = 'kept'; });
const headingKept = (page) => page.evaluate(() => document.querySelector('#mdBody h1').dataset.probe === 'kept');

async function paste(page, text) {
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, text);
}

test.describe('in a browser', () => {
  test('the bridge is a no-op and the viewer is unchanged', async ({ page }) => {
    await page.goto('markdown-viewer.html');
    const h = await page.evaluate(async () => ({
      kind: mdvHost.kind,
      path: mdvHost.currentPath,
      version: mdvHost.currentVersion,
      initial: await mdvHost.initialDocument(),
      save: await mdvHost.saveDocument('/a.md', 'x', 1),
      resource: mdvHost.resourceUrl('/a.png'),
      selfTest: await mdvHost.selfTestRequested(),
      pickers: 'showOpenFilePicker' in window,
    }));
    expect(h).toEqual({ kind: 'browser', path: null, version: null, initial: null, save: null, resource: null, selfTest: null, pickers: true });
    await expect(page.locator('#mdvOpenBtn')).toBeVisible();
    // The Open button still opens the browser's own file chooser.
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.locator('#dropZone .drop-btn').click();
    await chooser;
  });

  test('a bridge installed before the page scripts is kept (the comment tests stand in for the app this way)', async ({ page }) => {
    await page.addInitScript(() => { window.mdvHost = { kind: 'desktop', currentPath: '/docs/plan.md', currentMtimeMs: 5, stand: 'in' }; });
    await page.goto('markdown-viewer.html');
    expect(await page.evaluate(() => [mdvHost.kind, mdvHost.stand, mdvHost.currentPath])).toEqual(['desktop', 'in', '/docs/plan.md']);
  });
});

test.describe('in the desktop app (stand-in shell)', () => {
  test("the stand-in serves the app's CSP: an inline handler does not run", async ({ page }) => {
    // The control for every test below: without it, a control the app's CSP disables would pass here.
    await openApp(page, { doc: null });
    const r = await page.evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective || e.effectiveDirective));
      window.__inlineRan = false;
      const box = document.createElement('div');
      box.innerHTML = '<button id="cspProbe" onclick="window.__inlineRan = true">probe</button>';
      document.body.appendChild(box);
      box.querySelector('button').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ran: window.__inlineRan, violations };
    });
    expect(r.ran).toBe(false);
    expect(r.violations.join(' ')).toMatch(/script-src/);
  });

  test("the window's document renders at start, with the app's controls", async ({ page }) => {
    const errors = await openApp(page, { doc: fixtureDoc });
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    const state = await page.evaluate(() => ({
      kind: mdvHost.kind, path: mdvHost.currentPath, mtime: mdvHost.currentMtimeMs, version: mdvHost.currentVersion, title: document.title,
      raw: rawMarkdown.length, file: currentFileName, pickers: 'showOpenFilePicker' in window || 'showSaveFilePicker' in window,
    }));
    expect(state).toMatchObject({ kind: 'desktop', path: fixtureDoc.path, mtime: 1000, version: 'v-1000', title: 'doc.md', raw: FIXTURE.length, file: 'doc.md', pickers: false });
    await expect(page.locator('#mdvOpenBtn')).toBeHidden();
    await expect(page.locator('#mdvWorkspaceBtn')).toBeHidden();
    // Every event listener is scoped to this window.
    const listens = await callsTo(page, 'listen');
    expect(listens.map((l) => l.event)).toEqual(expect.arrayContaining(['mdv://document-changed', 'mdv://open-document', 'mdv://notice']));
    expect(listens.every((l) => l.target === 'doc-1')).toBe(true);
    // A window that shows a file is never reported as holding pasted text.
    expect(await callsTo(page, 'mdv_window_holds_text')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("images in the document's folder load through the asset protocol; others are not asked for", async ({ page }, info) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForFunction(() => [...document.querySelectorAll('#mdBody img')].every((i) => i.complete));
    const imgs = await page.evaluate(() => [...document.querySelectorAll('#mdBody img')].map((i) => ({
      original: i.dataset.mdvSrc || null, src: i.getAttribute('src'), loaded: i.naturalWidth > 0,
    })));
    expect(imgs).toEqual([
      { original: 'images/figure.png', src: expect.stringMatching(/\/desktop\/tests\/fixtures\/linked\/images\/figure\.png$/), loaded: true },
      { original: 'figure.svg', src: expect.stringMatching(/\/desktop\/tests\/fixtures\/linked\/figure\.svg$/), loaded: true },
      { original: '.gitbook/assets/figure.png', src: expect.stringMatching(/\/desktop\/tests\/fixtures\/linked\/\.gitbook\/assets\/figure\.png$/), loaded: true },
      // Outside the folder: left as written, so the shell never looks at that path.
      { original: null, src: '../outside.png', loaded: false },
    ]);
    await page.screenshot({ path: info.outputPath('desktop-document-light.png'), fullPage: true });
  });

  test('links open the right way, and the page never navigates away', async ({ page, context }) => {
    const doc = Object.assign({}, fixtureDoc, {
      text: FIXTURE + '\n<a href="ftp://example.com/file.md">An FTP link</a>\n\n[A card for a file](notes/plan.md)\n',
    });
    await openApp(page, { doc });
    const popups = [];
    context.on('page', (p) => popups.push(p.url()));
    const start = new URL(page.url());
    const link = (text) => page.locator('#mdBody a', { hasText: text }).first();

    await link('Another Markdown file').click();
    await link('A web page').click();
    await link('An email address').click();
    await link('A web page').click({ modifiers: ['Meta'] });
    await link('A web page').click({ button: 'middle' });
    await link('A file that is not Markdown').click();
    await expect(page.locator('#mdvHostNotices')).toContainText('opens only Markdown files, so notes.txt');
    await link('An FTP link').click();
    await expect(page.locator('#mdvHostNotices')).toContainText('ftp: links are not opened');
    await link('The same file, at a heading').click();
    await link('A heading on this page').click();

    expect(await callsTo(page, 'mdv_open_path')).toEqual([{ path: `${FIXTURE_DIR}/other.md` }]);
    expect(await callsTo(page, 'mdv_open_external')).toEqual([
      { url: 'https://example.com/' },
      { url: 'mailto:someone@example.com' },
      { url: 'https://example.com/' },
      { url: 'https://example.com/' },
    ]);
    const now = new URL(page.url());
    expect(now.origin + now.pathname).toBe(start.origin + start.pathname);
    expect(popups).toEqual([]);
    // The in-page links scrolled (smoothly) until the heading is in view; the fixture is short, so it
    // cannot reach the very top.
    await expect.poll(() => page.evaluate(() => {
      const top = document.getElementById('section-two').getBoundingClientRect().top;
      return top >= 0 && top < window.innerHeight;
    })).toBe(true);
    // A standalone link becomes a card; for a file it shows the path as written.
    await expect(page.locator('#mdBody a.link-chip', { hasText: 'A card for a file' }).locator('.link-chip-url')).toHaveText('notes/plan.md');
  });

  test('Cmd/Ctrl+O opens the native Open panel, never the browser file chooser', async ({ page }) => {
    await openApp(page, { doc: null });
    let chooserOpened = false;
    page.on('filechooser', () => { chooserOpened = true; });
    await page.keyboard.press(`${MOD}+o`);
    await expect.poll(() => callsTo(page, 'mdv_open_dialog').then((c) => c.length)).toBe(1);
    expect(chooserOpened).toBe(false);
  });

  test("the welcome screen's Open button opens the native Open panel", async ({ page }) => {
    await openApp(page, { doc: null });
    // The app's CSP blocks inline handlers, so while this button keeps its onclick (until stream S moves it
    // to data-action) it does nothing in the app: this test is then expected to fail, and it turns red the
    // day it passes with the handler still inline.
    const inline = await page.locator('#dropZone .drop-btn').evaluate((b) => b.hasAttribute('onclick'));
    test.fail(inline, "the button's inline onclick is blocked by the app's CSP until stream S replaces it");
    let chooserOpened = false;
    page.on('filechooser', () => { chooserOpened = true; });
    await page.locator('#dropZone .drop-btn').click();
    await expect.poll(() => callsTo(page, 'mdv_open_dialog').then((c) => c.length), { timeout: 3000 }).toBe(1);
    expect(chooserOpened).toBe(false);
  });

  test('the shell can give an empty window its document', async ({ page }) => {
    await openApp(page, { doc: null });
    await expect(page.locator('#dropZone')).toBeVisible();
    await page.waitForFunction(() => window.__shell.commands().includes('mdv_initial_document'));
    // File → Open…, a dropped file, or a later launch: the shell sends the document as an event.
    await page.evaluate((d) => window.__shell.emit('mdv://open-document', d), Object.assign({}, fixtureDoc, { reason: 'opened' }));
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    expect(await page.evaluate(() => ({ path: mdvHost.currentPath, version: mdvHost.currentVersion, title: document.title })))
      .toEqual({ path: fixtureDoc.path, version: 'v-1000', title: 'doc.md' });
    // A document for another window's file is not this window's business.
    await tagHeading(page);
    await page.evaluate(() => window.__shell.emit('mdv://open-document', { path: '/elsewhere/other.md', name: 'other.md', text: '# Not this one', mtimeMs: 5, version: 'v-5', reason: 'opened' }));
    await page.waitForTimeout(250);
    expect(await headingKept(page)).toBe(true);
    expect(await page.evaluate(() => mdvHost.currentPath)).toBe(fixtureDoc.path);
  });

  test('a document that arrives both as an event and as the answer to the page is shown once', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc, holdInitial: true });
    // The page has asked for its document; the shell hands it over as an event before answering.
    await page.waitForFunction(() => typeof window.__shell.releaseInitial === 'function');
    await page.evaluate((d) => window.__shell.emit('mdv://open-document', d), Object.assign({}, fixtureDoc, { reason: 'opened' }));
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    await tagHeading(page);
    await page.evaluate(() => window.__shell.releaseInitial());
    await page.waitForTimeout(250);
    expect(await headingKept(page)).toBe(true);
    // The other order: the event after the page has the document changes nothing either.
    await page.evaluate((d) => window.__shell.emit('mdv://open-document', d), Object.assign({}, fixtureDoc, { reason: 'opened' }));
    await page.waitForTimeout(250);
    expect(await headingKept(page)).toBe(true);
  });

  test('a file the shell cannot read says why instead of showing a blank window', async ({ page }) => {
    await openApp(page, { initialError: { code: 'too-large', message: 'big.md is 40 MB; the limit is 32 MB.' } });
    await expect(page.locator('#mdvHostNotices')).toContainText('big.md is 40 MB; the limit is 32 MB.');
  });

  test('a live reload keeps the reading position', async ({ page }) => {
    const doc = { path: '/notes/long.md', name: 'long.md', text: longDocument(), mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial' };
    await openApp(page, { doc });
    await page.waitForSelector('#section-6');
    await page.evaluate(() => {
      const h = document.getElementById('section-6');
      window.scrollTo({ top: window.scrollY + h.getBoundingClientRect().top - 120, behavior: 'instant' });
    });
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => document.getElementById('section-6').getBoundingClientRect().top);
    // Another program inserts text near the top, pushing section 6 down the page.
    const text = longDocument('A paragraph added by another program. '.repeat(40) + '\n\n');
    await changed(page, { path: '/notes/long.md', name: 'long.md', text, mtimeMs: 2000, version: 'v-2000', readOnly: null, reason: 'changed' });
    await expect(page.locator('#mdBody')).toContainText('A paragraph added by another program.');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ top: document.getElementById('section-6').getBoundingClientRect().top, mtime: mdvHost.currentMtimeMs, version: mdvHost.currentVersion, raw: rawMarkdown.length }));
    expect(Math.abs(after.top - before)).toBeLessThan(4);
    expect(after).toMatchObject({ mtime: 2000, version: 'v-2000', raw: text.length });
  });

  test("a change to another window's file is ignored", async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    await tagHeading(page);
    await changed(page, { path: '/elsewhere/doc.md', name: 'doc.md', text: '# Not this one', mtimeMs: 5000, version: 'v-5000', reason: 'changed' });
    await page.waitForTimeout(250);
    expect(await headingKept(page)).toBe(true);
    expect(await page.evaluate(() => ({ path: mdvHost.currentPath, raw: rawMarkdown, mtime: mdvHost.currentMtimeMs, version: mdvHost.currentVersion })))
      .toEqual({ path: fixtureDoc.path, raw: FIXTURE, mtime: 1000, version: 'v-1000' });
  });

  test('a change that keeps the text moves the version forward without rendering again', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    await tagHeading(page);
    await changed(page, { path: fixtureDoc.path, name: 'doc.md', text: FIXTURE, mtimeMs: 3000, version: 'v-3000', reason: 'changed' });
    await expect.poll(() => page.evaluate(() => mdvHost.currentMtimeMs)).toBe(3000);
    expect(await page.evaluate(() => mdvHost.currentVersion)).toBe('v-3000');
    expect(await headingKept(page)).toBe(true);
  });

  test('a change that arrives during a save waits for the person', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    await page.evaluate(() => { window.__shell.holdSaves = true; window.__pending = mdvHost.saveDocument(mdvHost.currentPath, rawMarkdown, mdvHost.currentMtimeMs); });
    await changed(page, { path: fixtureDoc.path, name: 'doc.md', text: '# Edited elsewhere\n', mtimeMs: 4000, version: 'v-4000', reason: 'changed' });
    const notices = page.locator('#mdvHostNotices');
    await expect(notices).toContainText('doc.md changed on disk.');
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    await page.evaluate(() => { window.__shell.releaseSave(); return window.__pending; });
    await notices.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('#mdBody h1')).toHaveText(/Edited elsewhere/);
    expect(await page.evaluate(() => [mdvHost.currentMtimeMs, mdvHost.currentVersion])).toEqual([4000, 'v-4000']);
  });

  test('a reply the save did not write survives the next change on disk', async ({ page }) => {
    // The reviewers' repro: a reply is saved, the save does not reach the file (the app has no file
    // handle for the browser's save path; with the comment save seam, the shell refuses it), and then
    // another program writes the file again.
    const text = readFileSync(repo('samples/commented.md'), 'utf8');
    const doc = { path: '/samples/commented.md', name: 'commented.md', text, mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial' };
    await openApp(page, { doc, refuseSaves: { currentMtimeMs: 7000, currentVersion: 'v-7000' } });
    await page.waitForFunction(() => Array.isArray(mdvComments) && mdvComments.some((c) => !c.parent_id));
    await page.evaluate(() => mdvPostReply(mdvComments.find((c) => !c.parent_id).id, { value: 'A reply that must not be lost' }));
    // Wait until the save has run and finished, whichever save path the comment code takes.
    await page.waitForFunction(() => (typeof mdvSaveTimer === 'undefined' || !mdvSaveTimer)
      && (typeof mdvWritesQueued === 'undefined' || mdvWritesQueued === 0), null, { timeout: 10_000 });
    const reply = () => page.evaluate(() => mdvComments.some((c) => c.body_md === 'A reply that must not be lost'));
    expect(await page.evaluate(() => mdvDirty)).toBe(true);
    expect(await reply()).toBe(true);
    await changed(page, { path: doc.path, name: doc.name, text: text + '\nA line added by another program.\n', mtimeMs: 2000, version: 'v-2000', readOnly: null, reason: 'changed' });
    const notices = page.locator('#mdvHostNotices');
    await expect(notices).toContainText('commented.md changed on disk.');
    expect(await reply()).toBe(true);
    expect(await page.evaluate(() => rawMarkdown.includes('A line added by another program.'))).toBe(false);
    // Loading the new version is the person's choice.
    await notices.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('#mdBody')).toContainText('A line added by another program.');
  });

  test('View → Reload asks first when comment changes are not in the file, and not otherwise', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    const reload = (extra, mtimeMs) => changed(page, { path: fixtureDoc.path, name: 'doc.md', text: FIXTURE + extra, mtimeMs, version: `v-${mtimeMs}`, reason: 'reload' });
    // Nothing unsaved: the reload happens at once.
    await reload('\nFirst reload.\n', 2000);
    await expect(page.locator('#mdBody')).toContainText('First reload.');
    // A comment change the file does not have yet: the reload waits for the person.
    await page.evaluate(() => { mdvDirty = true; });
    await reload('\nSecond reload.\n', 3000);
    const notices = page.locator('#mdvHostNotices');
    await expect(notices).toContainText('Reloading shows doc.md as it is on disk');
    await expect(page.locator('#mdBody')).not.toContainText('Second reload.');
    expect(await page.evaluate(() => mdvHost.currentVersion)).toBe('v-2000');
    await notices.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('#mdBody')).toContainText('Second reload.');
    expect(await page.evaluate(() => mdvHost.currentVersion)).toBe('v-3000');
  });

  test("a paste does not replace the window's document", async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    await paste(page, '# Pasted over the file\n\nThis must not replace the window\'s document.');
    await expect(page.locator('#mdvHostNotices')).toContainText('To read pasted Markdown, open a new window');
    await expect(page.locator('#mdBody h1')).toHaveText(/Linked document/);
    expect(await page.evaluate(() => mdvHost.currentPath)).toBe(fixtureDoc.path);
  });

  test('pasted text keeps its window: the shell is told once, so the next file opens elsewhere', async ({ page }) => {
    await openApp(page, { doc: null });
    await page.waitForFunction(() => window.__shell.commands().includes('mdv_initial_document'));
    expect(await callsTo(page, 'mdv_window_holds_text')).toEqual([]);
    await paste(page, '# My pasted notes\n\nSome text worth keeping.');
    await expect(page.locator('#mdBody h1')).toHaveText(/My pasted notes/);
    await paste(page, '# More pasted notes\n\nAnd more text.');
    await expect(page.locator('#mdBody h1')).toHaveText(/More pasted notes/);
    expect((await callsTo(page, 'mdv_window_holds_text')).length).toBe(1);
  });

  test('a save names the version its text was made from, and moves it forward', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    const results = await page.evaluate(async () => [
      await mdvHost.saveDocument(mdvHost.currentPath, rawMarkdown + '\n', mdvHost.currentMtimeMs),
      [mdvHost.currentMtimeMs, mdvHost.currentVersion],
      await mdvHost.saveDocument('/somewhere/else.md', 'x', 1),
      [mdvHost.currentMtimeMs, mdvHost.currentVersion],
    ]);
    expect(results).toEqual([
      { ok: true, mtimeMs: 2000, version: 'v-saved-1' },
      [2000, 'v-saved-1'],
      { ok: false, reason: 'not-allowed', message: 'A window saves only into the file it opened.' },
      [2000, 'v-saved-1'],
    ]);
    expect(await callsTo(page, 'mdv_save_document')).toEqual([
      { path: fixtureDoc.path, text: FIXTURE + '\n', version: 'v-1000' },
      { path: '/somewhere/else.md', text: 'x', version: null },
    ]);
  });

  test('a save after a conflict names exactly the version the conflict reported, and nothing for an unknown time', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc, refuseSaves: { currentMtimeMs: 7000, currentVersion: 'v-7000' } });
    await page.waitForSelector('#mdBody h1');
    const r = await page.evaluate(async () => {
      const first = await mdvHost.saveDocument(mdvHost.currentPath, 'mine', mdvHost.currentMtimeMs);
      // "Replace the file with my version": the comment code passes the time the conflict reported.
      await mdvHost.saveDocument(mdvHost.currentPath, 'mine', first.currentMtimeMs);
      await mdvHost.saveDocument(mdvHost.currentPath, 'mine', 123456);
      return first;
    });
    expect(r).toMatchObject({ ok: false, reason: 'conflict', currentMtimeMs: 7000, currentVersion: 'v-7000' });
    expect((await callsTo(page, 'mdv_save_document')).map((a) => a.version)).toEqual(['v-1000', 'v-7000', null]);
  });

  test('when the comment code re-reads the file itself, the version follows the time it sets', async ({ page }) => {
    await openApp(page, { doc: fixtureDoc });
    await page.waitForSelector('#mdBody h1');
    const version = await page.evaluate(async () => {
      window.__shell.disk[mdvHost.currentPath] = Object.assign({}, window.__shell.disk[mdvHost.currentPath], { text: '# Changed\n', mtimeMs: 9000, version: 'v-9000' });
      // What the comment code's "show the version on disk" does: read, then set the time.
      const doc = await mdvHost.readDocument(mdvHost.currentPath);
      mdvHost.currentMtimeMs = doc.mtimeMs;
      await mdvHost.saveDocument(mdvHost.currentPath, '# Changed\n\nA comment.\n', mdvHost.currentMtimeMs);
      return mdvHost.currentVersion;
    });
    expect(version).toBe('v-saved-1');
    expect((await callsTo(page, 'mdv_save_document')).map((a) => a.version)).toEqual(['v-9000']);
  });

  test('paths resolve for POSIX and Windows documents', async ({ page }) => {
    await openApp(page, { doc: null });
    const r = await page.evaluate(() => {
      const at = (base, target) => { mdvHost.currentPath = base; return mdvHost.resolvePath(target); };
      return [
        at('/home/reader/notes/today.md', 'img/x.png'),
        at('/home/reader/notes/today.md', '../other.md'),
        at('/home/reader/notes/today.md', './deep/../same.md'),
        at('/home/reader/notes/today.md', '../../../../../top.md'),
        at('/home/reader/notes/today.md', '/etc/abs.md'),
        at('C:\\Users\\a\\notes\\today.md', 'img/x.png'),
        at('C:\\Users\\a\\notes\\today.md', '..\\other.md'),
        at('C:\\Users\\a\\notes\\today.md', '/root.md'),
        at('C:\\Users\\a\\notes\\today.md', 'D:/elsewhere/x.md'),
        at('\\\\server\\share\\docs\\a.md', '../b.md'),
        at(null, 'img/x.png'),
      ];
    });
    expect(r).toEqual([
      '/home/reader/notes/img/x.png',
      '/home/reader/other.md',
      '/home/reader/notes/same.md',
      '/top.md',
      '/etc/abs.md',
      'C:\\Users\\a\\notes\\img\\x.png',
      'C:\\Users\\a\\other.md',
      'C:\\root.md',
      'D:\\elsewhere\\x.md',
      '\\\\server\\share\\b.md',
      null,
    ]);
  });

  for (const theme of ['light', 'dark']) {
    test(`the welcome screen offers to become the default app (${theme})`, async ({ page }, info) => {
      await openApp(page, { doc: null, theme });
      await expect(page.locator('#dropZone .drop-zone-sub')).toHaveText('Drag a Markdown file here, or choose one.');
      await expect(page.locator('#titleText')).toHaveText('Kites Markdown');
      const mac = await page.evaluate(() => /Mac/i.test(navigator.platform));
      await expect(page.locator('#dropZone .paste-hint kbd').first()).toHaveText(mac ? '⌘' : 'Ctrl');
      await expect(page.locator('#dropZone .drop-btn')).toContainText('Open a file…');
      const offer = page.locator('#mdvDefaultApp button');
      await expect(offer).toHaveText('Make Kites Markdown the default');
      await page.screenshot({ path: info.outputPath(`desktop-welcome-${theme}.png`) });
      await offer.click();
      await expect(page.locator('#mdvHostNotices')).toContainText('Markdown files now open in Kites Markdown.');
      expect((await callsTo(page, 'mdv_make_default')).length).toBe(1);
      await page.screenshot({ path: info.outputPath(`desktop-welcome-notice-${theme}.png`) });
    });
  }

  test('the self-test detects script that runs (its positive control)', async ({ page }) => {
    // Without the app's CSP (this page is served without it on purpose), the probe's inline handler runs,
    // and the self-test must say so. In the app the same probe must report that nothing ran.
    const text = readFileSync(repo('samples/kitchen-sink.md'), 'utf8');
    const sibling = { path: '/samples/kites-self-test-sibling.md', name: 'kites-self-test-sibling.md', text: '# A sibling\n', mtimeMs: 5, version: 'v-sibling', readOnly: null, reason: 'reload' };
    await page.addInitScript({ path: repo('desktop/src-tauri/src/self-test.js') });
    await openApp(page, {
      csp: false,
      doc: { path: '/samples/kitchen-sink.md', name: 'kitchen-sink.md', text, mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial' },
      disk: { [sibling.path]: sibling },
      selfTest: true,
    });
    const report = await page.waitForFunction(() => window.__shell && window.__shell.report, null, { timeout: 60_000 }).then((h) => h.jsonValue());
    const fences = (text.match(/^```mermaid\s*$/gm) || []).length;
    expect(report.counts.mermaidBlocks).toBe(fences);
    expect(report.counts.mermaidSvgs).toBe(fences);
    expect(report.counts.h2).toBeGreaterThan(5);
    expect(report.sanitization.rawErrorFired).toBe(true);
    expect(report.sanitization.viaRawHtml).toBeGreaterThan(0);
    expect(report.sanitization.executed).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.failures).toContain('script in a document ran');
    // Every bridge probe was refused for its own reason; the sibling probe read the sibling and left it alone.
    expect(report.bridge.allRefused).toBe(true);
    expect(report.bridge.saveOtherFile).toMatchObject({ refused: true, code: 'not-allowed', siblingUnchanged: true });
    expect(await callsTo(page, 'mdv_save_document')).toEqual([{ path: sibling.path, text: 'kites-self-test: written by the probe\n', version: 'v-sibling' }]);
  });

  // The probe's own controls: a shell that saves anywhere, and one that refuses for another reason (the
  // probe used to accept any refusal, so a conflict from a missing version passed for the guard).
  for (const [shell, answer] of [
    ['saves into another file', { ok: true, mtimeMs: 6, version: 'v-6' }],
    ['refuses it for another reason', { ok: false, reason: 'conflict', message: 'The file changed on disk.' }],
  ]) {
    test(`the self-test's save-guard probe fails when the shell ${shell}`, async ({ page }) => {
      const text = '# A document\n\nWith a paragraph.\n';
      const sibling = { path: '/notes/kites-self-test-sibling.md', name: 'kites-self-test-sibling.md', text: '# A sibling\n', mtimeMs: 5, version: 'v-sibling', readOnly: null, reason: 'reload' };
      await withShell(page, {
        doc: { path: '/notes/doc.md', name: 'doc.md', text, mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial' },
        disk: { [sibling.path]: sibling },
        selfTest: true,
      });
      await page.addInitScript((a) => {
        const inner = window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke = (cmd, args) => (cmd === 'mdv_save_document' ? Promise.resolve(a) : inner(cmd, args));
      }, answer);
      await page.addInitScript({ path: repo('desktop/src-tauri/src/self-test.js') });
      await page.goto('markdown-viewer.html');
      const report = await page.waitForFunction(() => window.__shell && window.__shell.report, null, { timeout: 60_000 }).then((h) => h.jsonValue());
      expect(report.bridge.saveOtherFile.refused).toBe(false);
      expect(report.bridge.allRefused).toBe(false);
      expect(report.failures.join(' ')).toMatch(/saveOtherFile/);
    });
  }
});
