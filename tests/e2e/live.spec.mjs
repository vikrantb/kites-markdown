// Live reload, Back/Forward between documents, and links that open in the viewer (js/live-reload.js,
// js/history.js, and the load seam mdvOpenDocument in js/files.js).
//
// Files "on disk" are real files: each test writes its documents into its own output folder, which the test
// server serves, and edits them there, as another program would. The File System Access path uses the browser's
// private file system (OPFS), so its handles and time stamps are real too. The desktop app is the stand-in shell
// that desktop.spec.mjs uses (Tauri's injected API, with the app's own Content Security Policy). The folder
// sidebar's window.mdvFolder belongs to the folder stream; until it merges, its test here uses a stand-in.
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForLayoutSettled } from './support/viewer.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const ALT_LEFT = process.platform === 'darwin' ? '⌥←' : 'Alt+←';
const KNOWN_NOISE = [/favicon\.ico/i, /fonts\.(googleapis|gstatic)\.com/i];
const APP_CSP = Object.entries(JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`)
  .join('; ');

function collectErrors(page, allow = []) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = `${m.text()} ${(m.location() && m.location().url) || ''}`;
    if (![...KNOWN_NOISE, ...allow].some((r) => r.test(where))) errors.push(`console: ${where.trim()}`);
  });
  return errors;
}

// A document the test server serves from this test's own output folder. `path` is its ?file= value; write()
// changes it on disk, as another program saving it would.
function servedFile(info, name, text) {
  const file = info.outputPath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return { file, path: relative(ROOT, file).split(sep).join('/'), write: (t) => writeFileSync(file, t) };
}

// Twelve sections of four paragraphs; `extra` goes at the top of section 1, `links[n]` at the top of section n
function longDocument(title, extra = '', links = {}) {
  const sections = [];
  for (let i = 1; i <= 12; i++) {
    const paragraphs = Array.from({ length: 4 }, (_, j) => `Paragraph ${j + 1} of section ${i}. ` + 'Words to read. '.repeat(24)).join('\n\n');
    sections.push(`## Section ${i}\n\n${links[i] || ''}${i === 1 ? extra : ''}${paragraphs}`);
  }
  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}

const ADDED = 'A paragraph that another program added near the top. '.repeat(30) + '\n\n';

async function scrollHeadingTo(page, id, y) {
  await page.evaluate(([id, y]) => {
    const h = document.getElementById(id);
    window.scrollTo({ top: window.scrollY + h.getBoundingClientRect().top - y, behavior: 'instant' });
  }, [id, y]);
  await page.waitForTimeout(150);
  return headingTop(page, id);
}
const headingTop = (page, id) => page.evaluate((id) => document.getElementById(id).getBoundingClientRect().top, id);
async function expectHeadingAt(page, id, top) {
  await expect.poll(async () => Math.round(Math.abs((await headingTop(page, id)) - top)), { timeout: 5000 }).toBeLessThan(4);
}

// The page's own record of what it showed, and how (first, open, reload, history)
async function recordOpens(page) {
  await page.addInitScript(() => {
    window.__opens = [];
    document.addEventListener('DOMContentLoaded', () => mdvOnDocumentOpened((e) => window.__opens.push({ kind: e.kind, name: e.doc.name, length: e.doc.text.length })));
  });
}

async function setVisibility(page, state) {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

// ---------------------------------------------------------------------------------------------------------------
// Live reload in the browser
// ---------------------------------------------------------------------------------------------------------------

test('a file changed on disk is shown again over http, at the same place, with a quiet "Updated" note', async ({ page }, info) => {
  const errors = collectErrors(page);
  const doc = servedFile(info, 'notes/long.md', longDocument('Live notes'));
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#section-6');
  await waitForLayoutSettled(page);
  const before = await scrollHeadingTo(page, 'section-6', 140);
  const entries = await page.evaluate(() => history.length);
  doc.write(longDocument('Live notes', ADDED)); // pushes section 6 down the page
  await expect(page.locator('#mdBody')).toContainText('A paragraph that another program added', { timeout: 10_000 });
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated');
  await expect(page.locator('#mdvLiveToast')).toHaveClass(/show/);
  await expectHeadingAt(page, 'section-6', before);
  // A reload is not a new place in Back/Forward, and the address still names the file
  expect(await page.evaluate(() => history.length)).toBe(entries);
  expect(new URL(page.url()).searchParams.get('file')).toBe(doc.path);
  await expect(page.locator('#mdvHistoryNav')).toBeHidden();
  await expect(page.locator('#mdvLiveToast')).not.toHaveClass(/show/, { timeout: 5000 }); // it fades by itself
  expect(errors).toEqual([]);
});

test('with no heading above the reader, a reload keeps the same proportion of the page', async ({ page }, info) => {
  const errors = collectErrors(page);
  const words = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of a long note without headings. ` + 'Text. '.repeat(30)).join('\n\n');
  const doc = servedFile(info, 'plain.md', words(80));
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody p');
  await waitForLayoutSettled(page);
  await page.evaluate(() => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) / 2, behavior: 'instant' }));
  const ratio = () => page.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight));
  const before = await ratio();
  doc.write(words(80) + '\n\nOne more line at the end.\n');
  await expect(page.locator('#mdBody')).toContainText('One more line at the end.', { timeout: 10_000 });
  await expect.poll(async () => Math.abs((await ratio()) - before), { timeout: 5000 }).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});

test('over http each look is a conditional request, and a time stamp younger than 2 s is never trusted', async ({ page }) => {
  const errors = collectErrors(page);
  let text = longDocument('Conditional');
  let modified = Date.now() - 60_000;
  let date = () => new Date().toUTCString();
  const asked = []; // If-Modified-Since of each request, or null
  await page.route('**/live-fixture/cond.md', async (route) => {
    const since = route.request().headers()['if-modified-since'] || null;
    asked.push(since);
    const headers = { 'Last-Modified': new Date(modified).toUTCString(), Date: date(), 'Cache-Control': 'no-store' };
    if (since && Date.parse(since) >= Math.floor(modified / 1000) * 1000) {
      await route.fulfill({ status: 304, headers });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: text, headers });
  });
  await page.goto('markdown-viewer.html?file=live-fixture/cond.md');
  await page.waitForSelector('#section-2');
  // The load and the first look ask for the whole file; once the stamp is old enough, each look only asks
  // whether the file changed since, and the server answers 304 with no body
  await expect.poll(() => asked.filter(Boolean).length, { timeout: 10_000 }).toBeGreaterThan(1);
  expect(asked[0]).toBe(null);
  await page.evaluate(() => { document.querySelector('#mdBody h1').dataset.probe = 'kept'; });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => document.querySelector('#mdBody h1').dataset.probe), 'an unchanged file is not shown again').toBe('kept');
  // Another program saves the file. Its stamp is under 2 s old by the server's clock: two versions saved within one
  // second share a stamp, so a conditional request could be told "not modified" about the second one
  text = longDocument('Conditional', 'An edit saved just now. ');
  modified = Date.now();
  date = () => new Date(modified + 500).toUTCString();
  await expect(page.locator('#mdBody')).toContainText('An edit saved just now.', { timeout: 10_000 });
  const n = asked.length;
  await expect.poll(() => asked.length, { timeout: 6000 }).toBeGreaterThan(n + 1);
  expect(asked.slice(n), 'requests after a too-young stamp ask for the whole file').toEqual(asked.slice(n).map(() => null));
  expect(errors).toEqual([]);
});

test('a file caught half-way through a save (emptied, then written) is never shown half-written', async ({ page }) => {
  const errors = collectErrors(page);
  await recordOpens(page);
  let body = longDocument('Saved in two steps');
  let emptyOnce = false;
  await page.route('**/live-fixture/two-step.md', async (route) => {
    let reply = body;
    if (emptyOnce) { emptyOnce = false; reply = ''; } // the look that lands between "empty" and "write"
    await route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: reply, headers: { 'Cache-Control': 'no-store' } });
  });
  await page.goto('markdown-viewer.html?file=live-fixture/two-step.md');
  await page.waitForSelector('#section-2');
  await page.waitForTimeout(2300); // one look has seen the file as it is
  body = longDocument('Saved in two steps', 'The second step wrote this. ');
  emptyOnce = true;
  await expect(page.locator('#mdBody')).toContainText('The second step wrote this.', { timeout: 10_000 });
  const opens = await page.evaluate(() => window.__opens);
  expect(opens.filter((o) => o.kind === 'reload')).toHaveLength(1);
  expect(opens.every((o) => o.length > 1000), 'no empty version was shown').toBe(true);
  expect(errors).toEqual([]);
});

test('a document with unsaved comment changes is never replaced: "Changed on disk: reload?" asks first', async ({ page }, info) => {
  const errors = collectErrors(page);
  const text = '# Plan\n\nThe first paragraph of the plan.\n\n## Details\n\nMore of the plan.\n';
  const doc = servedFile(info, 'plan.md', text);
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h1');
  // A page over http has no file to save comments into: this comment stays unsaved
  await page.evaluate(() => mdvAddComment(document.querySelector('#mdBody p'), null, 'An unsaved comment'));
  expect(await page.evaluate(() => mdvDirty)).toBe(true);
  await page.evaluate(() => { document.querySelector('#mdBody h1').dataset.probe = 'kept'; });
  doc.write(text + '\nA line another program added.\n');
  const prompt = page.locator('#mdvLivePrompt');
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await expect(prompt).toContainText('Changed on disk: reload?');
  await expect(prompt).toContainText('plan.md has a newer version');
  // The page under the reader is untouched
  const kept = () => page.evaluate(() => ({
    probe: document.querySelector('#mdBody h1').dataset.probe,
    comment: rawMarkdown.includes('An unsaved comment'),
    other: rawMarkdown.includes('A line another program added.'),
  }));
  expect(await kept()).toEqual({ probe: 'kept', comment: true, other: false });
  // "Not now": the reader keeps reading; the same version does not ask again
  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(prompt).toBeHidden();
  await page.waitForTimeout(2600);
  await expect(prompt).toBeHidden();
  expect(await kept()).toEqual({ probe: 'kept', comment: true, other: false });
  // A newer version asks again; Reload shows it, and the comment stays in the comments panel to download
  doc.write(text + '\nA line another program added.\n\nAnd a second one.\n');
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await prompt.getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('#mdBody')).toContainText('And a second one.');
  await expect(prompt).toBeHidden();
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated');
  expect(await page.evaluate(() => mdvNotices.some((n) => n.kind === 'unsaved' && n.text.includes('An unsaved comment')))).toBe(true);
  expect(errors).toEqual([]);
});

test('a file opened through the File System Access API follows its file, and the viewer\'s own comment save is no change', async ({ page }) => {
  const errors = collectErrors(page);
  await recordOpens(page);
  await page.goto('markdown-viewer.html');
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('live-handle.md', { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    window.__fh = fh;
    await mdvOpenWithHandle(fh, { prompt: false }); // the toolbar's writable open
  }, longDocument('Handle notes'));
  await page.waitForSelector('#section-6');
  await waitForLayoutSettled(page);
  const before = await scrollHeadingTo(page, 'section-6', 160);
  // Another program saves the file
  await page.evaluate(async (text) => {
    const w = await window.__fh.createWritable();
    await w.write(text);
    await w.close();
  }, longDocument('Handle notes', ADDED));
  await expect(page.locator('#mdBody')).toContainText('A paragraph that another program added', { timeout: 10_000 });
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated');
  await expectHeadingAt(page, 'section-6', before);
  // The viewer's own comment save changes the file's time and size: that is not another program's change
  await page.evaluate(async () => {
    await mdvAddComment(document.querySelector('#section-6 ~ .section-content p, #mdBody p'), null, 'Saved into the file');
    await mdvFlushWrites();
  });
  const onDisk = () => page.evaluate(async () => (await (await window.__fh.getFile()).text()).includes('Saved into the file'));
  await expect.poll(onDisk).toBe(true);
  const opens = await page.evaluate(() => window.__opens.length);
  await page.waitForTimeout(3500);
  expect(await page.evaluate(() => window.__opens.length), 'the own save was not shown again').toBe(opens);
  expect(await page.evaluate(() => [mdvDirty, mdvNotices.length])).toEqual([false, 0]);
  expect(errors).toEqual([]);
});

test('a hidden page does not look at the file, and looks at once when it is shown again', async ({ page }, info) => {
  const errors = collectErrors(page);
  const doc = servedFile(info, 'hidden.md', '# Hidden\n\nThe first version.\n');
  const looks = [];
  page.on('request', (r) => { if (r.url().includes('hidden.md')) looks.push(Date.now()); });
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h1');
  await expect.poll(() => looks.length, { timeout: 8000 }).toBeGreaterThan(1); // the load, then a look
  await setVisibility(page, 'hidden');
  await page.waitForTimeout(400); // a look already on its way finishes
  const n = looks.length;
  doc.write('# Hidden\n\nThe second version.\n');
  await page.waitForTimeout(4500); // more than two looks' worth of time
  expect(looks.length, 'no look while hidden').toBe(n);
  await expect(page.locator('#mdBody')).toContainText('The first version.');
  const shown = Date.now();
  await setVisibility(page, 'visible');
  await expect(page.locator('#mdBody')).toContainText('The second version.', { timeout: 3000 });
  expect(looks[n] - shown, 'the first look comes at once').toBeLessThan(1000);
  expect(errors).toEqual([]);
});

test('a file that cannot be fetched is looked at less and less often, and a large one read whole every 10 s', async ({ page }) => {
  const errors = collectErrors(page, [/status of 404/]); // the browser's own line for each failed look
  let gone = false;
  let text = '# Comes and goes\n\nThe first version.\n';
  const looks = [];
  await page.route('**/live-fixture/comes-and-goes.md', async (route) => {
    looks.push(Date.now());
    if (gone) await route.fulfill({ status: 404, body: 'not found' });
    else await route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: text, headers: { 'Cache-Control': 'no-store' } });
  });
  await page.goto('markdown-viewer.html?file=live-fixture/comes-and-goes.md');
  await page.waitForSelector('#mdBody h1');
  gone = true; // removed by another program
  const from = Date.now();
  await page.waitForTimeout(10_500);
  // Every 2 s would be 5 looks; waiting 2, 4, 8 s after each failure is 3 at most
  const failed = looks.filter((t) => t > from).length;
  expect(failed).toBeGreaterThan(0);
  expect(failed).toBeLessThanOrEqual(3);
  await expect(page.locator('#mdBody')).toContainText('The first version.');
  // It comes back: shown at once when the page is shown again, and the looks are every 2 s again
  text = '# Comes and goes\n\nThe second version.\n';
  gone = false;
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await expect(page.locator('#mdBody')).toContainText('The second version.', { timeout: 5000 });
  expect(await page.evaluate(() => mdvLive.failures)).toBe(0);
  // A document over 1 MB read whole on each look is looked at every 10 s; failures double the wait, up to 30 s
  const every = await page.evaluate(() => {
    const keep = [mdvLive.base, mdvLive.failures];
    mdvLive.base = 'x'.repeat(1_100_000);
    const r = { large: mdvLiveEvery(2000, true), largeButCheap: mdvLiveEvery(1500, false) };
    mdvLive.failures = 1; r.oneFailure = mdvLiveEvery(2000, false);
    mdvLive.failures = 9; r.capped = mdvLiveEvery(2000, true);
    [mdvLive.base, mdvLive.failures] = keep;
    return r;
  });
  expect(every).toEqual({ large: 10000, largeButCheap: 1500, oneFailure: 4000, capped: 30000 });
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Back and forward, and links that open in the viewer (browser)
// ---------------------------------------------------------------------------------------------------------------

test('a relative link opens in the viewer; Back and Forward bring each document back at the same place', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'docs/a.md', longDocument('Document A', '', { 5: 'See [the other document](b.md) for the details.\n\n' }));
  const b = servedFile(info, 'docs/b.md', longDocument('Document B'));
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#section-5');
  await waitForLayoutSettled(page);
  const viewer = new URL(page.url()).pathname;
  await expect(page.locator('#mdvHistoryNav')).toBeHidden();
  const aTop = await scrollHeadingTo(page, 'section-5', 150);
  const length = await page.evaluate(() => history.length);
  await page.locator('#mdBody a', { hasText: 'the other document' }).click();
  await expect(page.locator('#mdBody h1')).toHaveText(/Document B/);
  // In the viewer: the page did not navigate away; the address, the tab title and the history name the new file
  expect(new URL(page.url()).pathname).toBe(viewer);
  expect(new URL(page.url()).searchParams.get('file')).toBe(b.path);
  expect(await page.evaluate(() => [history.length, document.title, Math.round(scrollY)])).toEqual([length + 1, 'b.md - Markdown Viewer', 0]);
  const back = page.locator('#mdvBackBtn');
  const forward = page.locator('#mdvForwardBtn');
  await expect(back).toBeEnabled();
  await expect(back).toHaveAttribute('title', `Back to a.md (${ALT_LEFT})`);
  await expect(forward).toBeDisabled();
  await waitForLayoutSettled(page);
  const bTop = await scrollHeadingTo(page, 'section-3', 220);
  // Alt+←: A, where the reader left it
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('#mdBody h1')).toHaveText(/Document A/);
  await expectHeadingAt(page, 'section-5', aTop);
  expect(new URL(page.url()).searchParams.get('file')).toBe(a.path);
  await expect(back).toBeDisabled();
  await expect(forward).toBeEnabled();
  // Alt+→: B, where the reader left it
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('#mdBody h1')).toHaveText(/Document B/);
  await expectHeadingAt(page, 'section-3', bTop);
  // The toolbar's Back, then the browser's own Forward: the same places
  await back.click();
  await expect(page.locator('#mdBody h1')).toHaveText(/Document A/);
  await expectHeadingAt(page, 'section-5', aTop);
  await page.goForward();
  await expect(page.locator('#mdBody h1')).toHaveText(/Document B/);
  await expectHeadingAt(page, 'section-3', bTop);
  expect(errors).toEqual([]);
});

test('a link with a #fragment opens at that place; a link to a missing file says so and stays', async ({ page }, info) => {
  const errors = collectErrors(page, [/status of 404/]); // the browser's own line about the missing file
  const a = servedFile(info, 'a.md', '# Start\n\n- [Section nine of the long one](sub/long.md#section-9)\n- [A file that is not there](missing.md)\n- [Its own heading](a.md#start)\n');
  servedFile(info, 'sub/long.md', longDocument('The long one'));
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'A file that is not there' }).click();
  await expect(page.locator('.mdv-toast')).toContainText('missing.md could not be opened: it was not found.');
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Start');
  await page.locator('#mdBody a', { hasText: 'Section nine of the long one' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The long one');
  await waitForLayoutSettled(page);
  const top = await headingTop(page, 'section-9');
  expect(top).toBeGreaterThan(40);
  expect(top).toBeLessThan(140);
  expect(new URL(page.url()).hash).toBe('#section-9');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('section-9');
  expect(errors).toEqual([]);
});

test('Cmd/Ctrl-click on a relative link opens the viewer for it in a new tab', async ({ page, context }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# A\n\n[The other one](b.md)\n');
  const b = servedFile(info, 'b.md', '# B\n\nThe other one.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  const opened = context.waitForEvent('page');
  await page.locator('#mdBody a', { hasText: 'The other one' }).click({ modifiers: [MOD] });
  const tab = await opened;
  await tab.waitForLoadState();
  expect(new URL(tab.url()).searchParams.get('file')).toBe(b.path);
  await expect(tab.locator('#mdBody h1')).toHaveAttribute('aria-label', 'B');
  await tab.close();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'A');
  expect(errors).toEqual([]);
});

test('with a folder open, a link opens through mdvFolder.resolve and mdvFolder.read (a stand-in until the folder stream merges)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    const files = { 'notes/a.md': '# Folder A\n\n[To B](../b.md)\n', 'b.md': '# Folder B\n\nThe other file.\n' };
    window.__folderCalls = [];
    window.mdvFolder = {
      kind: 'browser',
      rootName: 'stand-in',
      list: () => Object.keys(files).map((path) => ({ path, name: path.split('/').pop(), depth: path.split('/').length - 1 })),
      resolve(from, href) {
        window.__folderCalls.push(['resolve', from, href]);
        const parts = from ? from.split('/').slice(0, -1) : [];
        for (const p of href.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
        const path = parts.join('/');
        return files[path] != null ? path : null;
      },
      async read(path) {
        window.__folderCalls.push(['read', path]);
        return { name: path.split('/').pop(), text: files[path], path, handle: null, mtimeMs: 1 };
      },
    };
  });
  await page.goto('markdown-viewer.html');
  await page.evaluate(async () => mdvOpenDocument(await window.mdvFolder.read('notes/a.md')));
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Folder A');
  await page.locator('#mdBody a', { hasText: 'To B' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Folder B');
  expect(await page.evaluate(() => window.__folderCalls)).toEqual([['read', 'notes/a.md'], ['resolve', 'notes/a.md', '../b.md'], ['read', 'b.md']]);
  expect(await page.evaluate(() => [mdvShownDocument().kind, mdvShownDocument().path])).toEqual(['folder', 'b.md']);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Folder A');
  expect(errors).toEqual([]);
});

test('every way of opening a document is a place in Back/Forward: the file chooser, paste and the writable open', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# From a link\n\nServed over http.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  // The file chooser (as the Open button and drag-and-drop): the address and title name it, as they always did
  await page.locator('#fileInput').setInputFiles({ name: 'chosen.md', mimeType: 'text/markdown', buffer: Buffer.from('# A chosen file\n\nRead from disk.\n') });
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'A chosen file');
  expect(new URL(page.url()).searchParams.get('file')).toBe('chosen.md');
  expect(await page.evaluate(() => document.title)).toBe('chosen.md - Markdown Viewer');
  // Paste
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text', '# Pasted notes\n\nFrom the clipboard.\n');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Pasted notes');
  expect(new URL(page.url()).searchParams.get('file')).toBe('pasted');
  // The writable open (the comment code's own loader): a file with a handle; its address has no ?file=, so
  // reloading the page reopens it
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('writable.md', { create: true });
    const w = await fh.createWritable();
    await w.write('# A writable file\n\nOpened with a handle.\n');
    await w.close();
    await mdvOpenWithHandle(fh, { prompt: false });
  });
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'A writable file');
  expect(new URL(page.url()).searchParams.has('file')).toBe(false);
  for (const title of ['Pasted notes', 'A chosen file', 'From a link']) {
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', title);
  }
  for (const title of ['A chosen file', 'Pasted notes', 'A writable file']) {
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', title);
  }
  // Back to the file with a handle reads it through the comment code, so a comment saves into it
  expect(await page.evaluate(() => mdvFileHandle && mdvFileHandle.name)).toBe('writable.md');
  expect(errors).toEqual([]);
});

test('Alt+← with nowhere to go back to is left to the browser; the ? sheet lists Back and Forward', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# A\n\n[B](b.md)\n');
  servedFile(info, 'b.md', '# B\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  const altLeft = () => page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(await altLeft(), 'nothing to go back to: the key stays the browser\'s').toBe(false);
  await page.locator('#mdBody a', { hasText: 'B' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'B');
  expect(await altLeft()).toBe(true);
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'A');
  await page.keyboard.press('Shift+Slash');
  const sheet = page.locator('#shortcutsOverlay');
  await expect(sheet).toHaveClass(/show/);
  await expect(sheet.locator('.shortcut-row', { hasText: 'Back to the previous document' })).toContainText(process.platform === 'darwin' ? '⌥+←' : 'Alt+←');
  await expect(sheet.locator('.shortcut-row', { hasText: 'Forward to the next document' })).toContainText(process.platform === 'darwin' ? '⌥+→' : 'Alt+→');
  expect(errors).toEqual([]);
});

test('mdvRegisterShortcut adds a shortcut to the keys and the sheet, and refuses keys another shortcut has', async ({ page }) => {
  const errors = collectErrors(page, [/already does/]);
  await page.goto('markdown-viewer.html');
  await page.waitForFunction(() => typeof mdvRegisterShortcut === 'function');
  const r = await page.evaluate(() => ({
    taken: mdvRegisterShortcut('Mod+K', () => {}, 'Something else'),
    // Shift does not count for punctuation (some layouts need it to type "?"), so these are the "?" keys
    takenPunctuation: mdvRegisterShortcut('Shift+?', () => {}, 'Something else'),
    added: mdvRegisterShortcut('Mod+Shift+Y', () => { window.__ran = (window.__ran || 0) + 1; }, 'A test shortcut'),
    bad: (() => { try { mdvRegisterShortcut('Hyper+Y', () => {}, 'x'); return 'accepted'; } catch (e) { return e.name; } })(),
  }));
  expect(r).toEqual({ taken: false, takenPunctuation: false, added: true, bad: 'TypeError' });
  await page.keyboard.press(`${MOD}+Shift+KeyY`);
  expect(await page.evaluate(() => window.__ran)).toBe(1);
  await page.keyboard.press('Shift+Slash');
  await expect(page.locator('#shortcutsOverlay .shortcut-row', { hasText: 'A test shortcut' })).toHaveCount(1);
  // Typing in a text field is not a shortcut
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'typing'; document.body.appendChild(i); i.focus(); });
  await page.keyboard.press(`${MOD}+Shift+KeyY`);
  expect(await page.evaluate(() => window.__ran)).toBe(1);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// The desktop app (stand-in shell, with the app's Content Security Policy)
// ---------------------------------------------------------------------------------------------------------------

async function openApp(page, { doc, disk = {} }, allow = []) {
  const errors = collectErrors(page, allow);
  await page.route('**/markdown-viewer.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: Object.assign({}, response.headers(), { 'content-security-policy': APP_CSP }) });
  });
  await page.addInitScript(({ doc, disk }) => {
    const calls = [];
    const listeners = {};
    const files = Object.assign({}, disk);
    if (doc) files[doc.path] = Object.assign({}, doc);
    let saved = 0;
    window.__shell = {
      calls,
      disk: files,
      emit(event, payload) { for (const h of listeners[event] || []) h({ event, payload }); },
    };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path.split('/').map(encodeURIComponent).join('/'),
        async invoke(cmd, args) {
          calls.push({ cmd, args: args || {} });
          switch (cmd) {
            case 'mdv_initial_document': return doc;
            case 'mdv_read_document':
              if (files[args.path]) return Object.assign({}, files[args.path], { reason: 'reload' });
              throw { code: 'not-found', message: 'no such file' };
            case 'mdv_save_document':
              // As the shell: a window saves only into the file it opened
              if (!doc || args.path !== doc.path) return { ok: false, reason: 'not-allowed', message: 'A window saves only into the file it opened.' };
              saved++;
              files[doc.path] = Object.assign({}, files[doc.path], { text: args.text, mtimeMs: 5000 + saved, version: 'v-saved-' + saved });
              return { ok: true, mtimeMs: 5000 + saved, version: 'v-saved-' + saved };
            default: return null;
          }
        },
      },
      event: {
        async listen(event, handler) {
          (listeners[event] = listeners[event] || []).push(handler);
          return () => {};
        },
      },
    };
  }, { doc, disk });
  await page.goto('markdown-viewer.html');
  return errors;
}

const callsTo = (page, cmd) => page.evaluate((c) => window.__shell.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

const windowFile = {
  path: '/notes/doc.md', name: 'doc.md', mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial',
  text: longDocument('The window file', '', { 4: '[The other file](other.md) is next to it.\n\n' }),
};
const otherFile = { path: '/notes/other.md', name: 'other.md', mtimeMs: 2000, version: 'v-2000', readOnly: null, text: '# The other file\n\nOpened from a link.\n' };

test('desktop: a relative link opens in the same window, Back returns, and Cmd/Ctrl-click opens a window of its own', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await page.waitForSelector('#section-4');
  await waitForLayoutSettled(page);
  const top = await scrollHeadingTo(page, 'section-4', 150);
  await page.locator('#mdBody a', { hasText: 'The other file' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The other file');
  expect(await callsTo(page, 'mdv_open_path'), 'no new window').toEqual([]);
  expect((await callsTo(page, 'mdv_read_document')).map((a) => a.path)).toContain(otherFile.path);
  // The bridge follows the document on screen: its images and links resolve from its own folder
  expect(await page.evaluate(() => [mdvHost.currentPath, mdvHost.currentMtimeMs, document.title])).toEqual([otherFile.path, 2000, 'other.md']);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The window file');
  await expectHeadingAt(page, 'section-4', top);
  expect(await page.evaluate(() => mdvHost.currentPath)).toBe(windowFile.path);
  // Cmd/Ctrl-click: js/host.js opens it in a window of its own, and this window keeps its document
  await page.locator('#mdBody a', { hasText: 'The other file' }).click({ modifiers: [MOD] });
  await expect.poll(() => callsTo(page, 'mdv_open_path')).toEqual([{ path: otherFile.path }]);
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The window file');
  expect(errors).toEqual([]);
});

test('desktop: the window\'s own file reloads (js/host.js) with the "Updated" note', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile });
  await page.waitForSelector('#section-6');
  await page.evaluate((d) => window.__shell.emit('mdv://document-changed', d), Object.assign({}, windowFile, {
    text: longDocument('The window file', ADDED), mtimeMs: 3000, version: 'v-3000', reason: 'changed',
  }));
  await expect(page.locator('#mdBody')).toContainText('A paragraph that another program added');
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated');
  // The shell watches that file: the page does not read it again on its own
  await page.waitForTimeout(2500);
  expect(await callsTo(page, 'mdv_read_document')).toEqual([]);
  expect(errors).toEqual([]);
});

test('desktop: a document opened from a link, which the shell does not watch, is read again to follow its file', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await page.waitForSelector('#section-4');
  await page.locator('#mdBody a', { hasText: 'The other file' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The other file');
  await page.evaluate((p) => Object.assign(window.__shell.disk[p], { text: '# The other file\n\nEdited by another program.\n', mtimeMs: 4000, version: 'v-4000' }), otherFile.path);
  await expect(page.locator('#mdBody')).toContainText('Edited by another program.', { timeout: 10_000 });
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated');
  expect(await page.evaluate(() => [mdvHost.currentMtimeMs, mdvHost.currentVersion])).toEqual([4000, 'v-4000']);
  expect(errors).toEqual([]);
});

test('desktop: a comment on a document opened from a link is never written into the window\'s own file', async ({ page }) => {
  // The comment code reports the shell's refusal with console.error ("MDV save failed"): expected here
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } }, [/MDV save failed/]);
  await page.waitForSelector('#section-4');
  await page.locator('#mdBody a', { hasText: 'The other file' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The other file');
  await page.evaluate(async () => {
    await mdvAddComment(document.querySelector('#mdBody p'), null, 'A comment on the other file');
    await mdvFlushWrites();
  });
  const saves = await callsTo(page, 'mdv_save_document');
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.map((s) => s.path), 'every save named the document on screen, never the window\'s file').toEqual(saves.map(() => otherFile.path));
  expect(await page.evaluate((p) => window.__shell.disk[p].text, windowFile.path)).toBe(windowFile.text);
  await expect(page.locator('#mdvNotices')).toContainText('A window saves only into the file it opened.');
  expect(await page.evaluate(() => rawMarkdown.includes('A comment on the other file'))).toBe(true);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// How it looks: light, sepia and dark, and a phone
// ---------------------------------------------------------------------------------------------------------------

for (const theme of ['light', 'sepia', 'dark']) {
  test(`screens in the ${theme} theme: Back and Forward, the "Updated" note and the "Changed on disk" question`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await page.addInitScript((t) => { try { localStorage.setItem('mdv-theme', t); } catch (_) { /* default */ } }, theme);
    const a = servedFile(info, 'handoff.md', longDocument('Handoff: the migration', '', { 1: 'The plan is in [the proposal](proposal.md).\n\n' }));
    servedFile(info, 'proposal.md', longDocument('Proposal: move the queue'));
    await page.goto(`markdown-viewer.html?file=${a.path}`);
    await page.waitForSelector('#mdBody h1');
    await page.locator('#mdBody a', { hasText: 'the proposal' }).click();
    await expect(page.locator('#mdBody h1')).toHaveText(/Proposal/);
    // The tooltip of the link just followed went with its document (the pointer never left that link)
    await expect(page.locator('#linkTooltip')).not.toHaveClass(/visible/);
    await waitForLayoutSettled(page);
    await page.evaluate(() => mdvLiveToast('Updated'));
    await expect(page.locator('#mdvLiveToast')).toHaveClass(/show/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: info.outputPath(`live-updated-${theme}.png`), clip: { x: 0, y: 0, width: 1366, height: 260 } });
    await page.evaluate(() => mdvLiveShowPrompt({ kind: 'http' }, { text: '' }, 'comments'));
    await expect(page.locator('#mdvLivePrompt')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: info.outputPath(`live-prompt-${theme}.png`) });
    // Contrast of the note, the question and its buttons, measured on the page
    const contrast = await page.evaluate(() => {
      const lum = (c) => {
        const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (fg, bg) => { const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const pair = (sel) => { const el = document.querySelector(sel); const s = getComputedStyle(el); return ratio(s.color, s.backgroundColor); };
      const card = getComputedStyle(document.querySelector('#mdvLivePrompt')).backgroundColor;
      return {
        toast: pair('#mdvLiveToast'),
        title: ratio(getComputedStyle(document.querySelector('.mdv-live-prompt-title')).color, card),
        detail: ratio(getComputedStyle(document.querySelector('.mdv-live-prompt-detail')).color, card),
        reload: pair('.mdv-live-btn-primary'),
        later: ratio(getComputedStyle(document.querySelector('.mdv-live-btn:not(.mdv-live-btn-primary)')).color, card),
      };
    });
    for (const [what, value] of Object.entries(contrast)) expect(value, `${what} contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
    expect(errors).toEqual([]);
  });
}

test('at phone width, with Back and Forward shown, every toolbar button stays on screen', async ({ page }, info) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const a = servedFile(info, 'a.md', '# Phone A\n\n[Phone B](b.md)\n');
  servedFile(info, 'b.md', '# Phone B\n\nText.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'Phone B' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Phone B');
  await expect(page.locator('#mdvBackBtn')).toBeVisible();
  const layout = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    offscreen: [...document.querySelectorAll('.toolbar button')]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => { const r = b.getBoundingClientRect(); return r.right > window.innerWidth + 0.5 || r.left < 0; })
      .map((b) => b.title || b.textContent.trim()),
  }));
  expect(layout.pageWidth).toBeLessThanOrEqual(390);
  expect(layout.offscreen).toEqual([]);
  await page.screenshot({ path: info.outputPath('live-phone.png'), clip: { x: 0, y: 0, width: 390, height: 220 } });
  expect(errors).toEqual([]);
});
