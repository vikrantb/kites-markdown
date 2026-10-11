// Live reload, Back/Forward between documents, and links that open in the viewer (js/live-reload.js,
// js/history.js, and the load seam mdvOpenDocument in js/files.js).
//
// Files "on disk" are real files: each test writes its documents into its own output folder, which the test
// server serves, and edits them there, as another program would. The File System Access path uses the browser's
// private file system (OPFS), so its handles and time stamps are real too. The desktop app is the stand-in shell
// that desktop.spec.mjs uses (Tauri's injected API, with the app's own Content Security Policy). A link in a folder
// of documents goes through the folder sidebar's own window.mdvFolder, over its fixture folder (folder-helpers.mjs).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { waitForLayoutSettled } from './support/viewer.mjs';
import {
  MOD, ALT_LEFT, collectErrors, servedFile, longDocument, ADDED, scrollHeadingTo, headingTop, expectHeadingAt,
  recordOpens, setVisibility, openApp, callsTo, windowFile, otherFile,
} from './support/live.mjs';
import { browserSetup, seed, openFolder } from './folder-helpers.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Live reload in the browser
// ---------------------------------------------------------------------------------------------------------------

test('a file changed on disk is shown again over http, at the same place, with a quiet note that says where', async ({ page }, info) => {
  const errors = collectErrors(page);
  const doc = servedFile(info, 'notes/long.md', longDocument('Live notes'));
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#section-6');
  await waitForLayoutSettled(page);
  const before = await scrollHeadingTo(page, 'section-6', 140);
  const entries = await page.evaluate(() => history.length);
  doc.write(longDocument('Live notes', ADDED)); // pushes section 6 down the page
  await expect(page.locator('#mdBody')).toContainText('A paragraph that another program added', { timeout: 10_000 });
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: Section 1');
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
  // "Not now": the reader keeps reading this version, and a quiet mark at the top right says a newer one waits
  const chip = page.locator('#mdvLiveChip');
  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(prompt).toBeHidden();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('plan.md has a newer version on disk.');
  await page.waitForTimeout(2600);
  await expect(prompt).toBeHidden();
  await expect(chip).toBeVisible();
  expect(await kept()).toEqual({ probe: 'kept', comment: true, other: false });
  // A newer version does not ask again (an agent saving every minute would ask every minute); the mark stays. Its
  // Reload… asks again; Reload shows the newest version, and the comment stays in the comments panel to download
  doc.write(text + '\nA line another program added.\n\nAnd a second one.\n');
  await page.waitForTimeout(3000);
  await expect(prompt).toBeHidden();
  await expect(chip).toBeVisible();
  await chip.getByRole('button', { name: 'Reload…' }).click();
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Reload' })).toBeFocused();
  await prompt.getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('#mdBody')).toContainText('And a second one.');
  await expect(prompt).toBeHidden();
  await expect(chip).toBeHidden();
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: Details');
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
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: Section 1');
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

test('a server that fails is asked less and less often, and a large file read whole is looked at every 10 s', async ({ page }) => {
  const errors = collectErrors(page, [/status of 503/]); // the browser's own line for each failed look
  let failing = false;
  let text = '# Comes and goes\n\nThe first version.\n';
  const looks = [];
  await page.route('**/live-fixture/comes-and-goes.md', async (route) => {
    looks.push(Date.now());
    if (failing) await route.fulfill({ status: 503, body: 'unavailable' });
    else await route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: text, headers: { 'Cache-Control': 'no-store' } });
  });
  await page.goto('markdown-viewer.html?file=live-fixture/comes-and-goes.md');
  await page.waitForSelector('#mdBody h1');
  failing = true; // the server is down
  const from = Date.now();
  await page.waitForTimeout(10_500);
  // Every 2 s would be 5 looks; waiting 2, 4, 8 s after each failure is 3 at most
  const failed = looks.filter((t) => t > from).length;
  expect(failed).toBeGreaterThan(0);
  expect(failed).toBeLessThanOrEqual(3);
  await expect(page.locator('#mdBody')).toContainText('The first version.');
  // It comes back: shown at once when the page is shown again, and the looks are every 2 s again
  text = '# Comes and goes\n\nThe second version.\n';
  failing = false;
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await expect(page.locator('#mdBody')).toContainText('The second version.', { timeout: 5000 });
  expect(await page.evaluate(() => mdvLive.failures)).toBe(0);
  // A document over 1 MB read whole on each look is looked at every 10 s; failures double the wait, up to 30 s; a
  // file that is not there is asked about every 4 s over http (each miss is a line in the console), as often as
  // usual otherwise
  const every = await page.evaluate(() => {
    const keep = [mdvLive.base, mdvLive.failures, mdvLive.gone];
    mdvLive.base = 'x'.repeat(1_100_000);
    const r = { large: mdvLiveEvery(2000, true), largeButCheap: mdvLiveEvery(1500, false) };
    mdvLive.failures = 1; r.oneFailure = mdvLiveEvery(2000, false);
    mdvLive.failures = 9; r.capped = mdvLiveEvery(2000, true);
    mdvLive.failures = 0; mdvLive.gone = true; mdvLive.base = '';
    r.goneOverHttp = mdvLiveEvery(2000, true, true); r.goneHandle = mdvLiveEvery(1500, false);
    [mdvLive.base, mdvLive.failures, mdvLive.gone] = keep;
    return r;
  });
  expect(every).toEqual({ large: 10000, largeButCheap: 1500, oneFailure: 4000, capped: 30000, goneOverHttp: 4000, goneHandle: 1500 });
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

test('with a folder open, a link opens through mdvFolder.resolve and mdvFolder.read, and the sidebar follows it', async ({ page }) => {
  // The fixture's proposal names two images that are not in the folder (its preview test needs them)
  const errors = collectErrors(page, [/\/preview-probe\.png/, /\/diagram\.png/]);
  // The folder sidebar's own folder (js/folder.js) over tests/fixtures/folder, in the browser's private file system
  await browserSetup(page);
  await page.goto('markdown-viewer.html');
  await seed(page);
  await openFolder(page);
  // Its read and resolve, recorded as the link follows them (the sidebar's own opens call them directly)
  await page.evaluate(() => {
    window.__folderCalls = [];
    for (const name of ['resolve', 'read']) {
      const real = window.mdvFolder[name];
      window.mdvFolder[name] = (...args) => { window.__folderCalls.push([name, ...args]); return real(...args); };
    }
  });
  await page.locator('#mdvFolderTree [data-path="handoffs/2026-10-01-api.md"]').click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Handoff: the API');
  await page.locator('#mdBody a', { hasText: 'search proposal' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Search across documents');
  expect(await page.evaluate(() => window.__folderCalls)).toEqual([
    ['resolve', 'handoffs/2026-10-01-api.md', '../proposals/search.md'], ['read', 'proposals/search.md'],
  ]);
  // A file of the folder in a browser is read through its handle, and is known by its place in the folder
  expect(await page.evaluate(() => [mdvShownDocument().kind, mdvShownDocument().path])).toEqual(['handle', 'proposals/search.md']);
  await expect(page.locator('#mdvFolderTree .is-current')).toHaveAttribute('data-path', 'proposals/search.md');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Handoff: the API');
  await expect(page.locator('#mdvFolderTree .is-current')).toHaveAttribute('data-path', 'handoffs/2026-10-01-api.md');
  expect(errors).toEqual([]);
});

test('a reload of the page opens the file on screen again, also when the seam showed it from text it had already read', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('markdown-viewer.html');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const write = async (name, text) => {
      const fh = await root.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      return fh;
    };
    const a = await write('a.md', '# File A\n\nThe first file.\n');
    const b = await write('b.md', '# File B\n\nThe second file.\n');
    await mdvOpenFileHandle(a); // read through the handle: the comment code records the version it read
    await mdvOpenFileHandle(b);
    // A again, with the text the comment code already holds for it, as the folder's sidebar, quick open and the
    // recent documents call the seam: it is shown without reading the file a second time
    await mdvOpenDocument({ name: 'a.md', text: await (await a.getFile()).text(), handle: a });
  });
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'File A');
  await expect.poll(() => page.evaluate(() => mdvGetHandle('current').then((h) => h && h.name))).toBe('a.md');
  await page.reload();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'File A');
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
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: Section 1');
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
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: The other file');
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
  test(`screens in the ${theme} theme: Back and Forward, the note and the marked change, the marks, and the "Changed on disk" question`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await page.addInitScript((t) => { try { localStorage.setItem('mdv-theme', t); } catch (_) { /* default */ } }, theme);
    const a = servedFile(info, 'handoff.md', longDocument('Handoff: the migration', '', { 1: 'The plan is in [the proposal](proposal.md).\n\n' }));
    const proposal = servedFile(info, 'proposal.md', longDocument('Proposal: move the queue'));
    await page.goto(`markdown-viewer.html?file=${a.path}`);
    await page.waitForSelector('#mdBody h1');
    await page.locator('#mdBody a', { hasText: 'the proposal' }).click();
    await expect(page.locator('#mdBody h1')).toHaveText(/Proposal/);
    // The tooltip of the link just followed went with its document (the pointer never left that link)
    await expect(page.locator('#linkTooltip')).not.toHaveClass(/visible/);
    await waitForLayoutSettled(page);
    // A real change near the top: the note says where, and the changed paragraph is marked for a moment
    proposal.write(longDocument('Proposal: move the queue').replace('Paragraph 1 of section 1.', 'Paragraph 1 of section 1, as the agent rewrote it.'));
    await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: Section 1', { timeout: 10_000 });
    await expect(page.locator('#mdBody .mdv-live-changed')).toHaveCount(1);
    // And the mark a newer version leaves after "Not now" (set here directly), with the note below it
    await page.evaluate(() => { mdvLive.pending = { target: mdvLiveTarget(), change: { text: '' } }; mdvLive.deferred = 'dismissed'; mdvLiveUpdateChip(); });
    await page.waitForTimeout(200);
    await page.screenshot({ path: info.outputPath(`live-updated-${theme}.png`), clip: { x: 0, y: 0, width: 1366, height: 440 } });
    // The other marks: the file is not on disk, and a copy that cannot follow its file
    await page.evaluate(() => { mdvLive.gone = true; mdvLiveUpdateChip(); });
    await page.screenshot({ path: info.outputPath(`live-chip-gone-${theme}.png`), clip: { x: 766, y: 48, width: 600, height: 56 } });
    await page.evaluate(() => { mdvLive.gone = false; mdvLiveClearPending(); });
    await page.evaluate(() => { mdvLiveShowPrompt(); });
    await expect(page.locator('#mdvLivePrompt')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: info.outputPath(`live-prompt-${theme}.png`) });
    // Contrast of the note, the marks, the question and their buttons, measured on the page
    const contrast = await page.evaluate(() => {
      const lum = (c) => {
        const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (fg, bg) => { const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const pair = (sel) => { const el = document.querySelector(sel); const s = getComputedStyle(el); return ratio(s.color, s.backgroundColor); };
      const card = getComputedStyle(document.querySelector('#mdvLivePrompt')).backgroundColor;
      const r = {
        toast: pair('#mdvLiveToast'),
        title: ratio(getComputedStyle(document.querySelector('.mdv-live-prompt-title')).color, card),
        detail: ratio(getComputedStyle(document.querySelector('.mdv-live-prompt-detail')).color, card),
        reload: pair('.mdv-live-btn-primary'),
        later: ratio(getComputedStyle(document.querySelector('.mdv-live-btn:not(.mdv-live-btn-primary)')).color, card),
      };
      mdvLive.pending = { target: mdvLiveTarget(), change: { text: '' } };
      mdvLive.deferred = 'dismissed';
      mdvLiveHidePrompt();
      mdvLiveUpdateChip();
      r.chip = pair('#mdvLiveChip');
      r.chipButton = pair('#mdvLiveChip .mdv-live-chip-btn');
      return r;
    });
    for (const [what, value] of Object.entries(contrast)) expect(value, `${what} contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
    // A copy chosen with the Open button says so (the File System Access picker is there to follow it)
    await page.locator('#fileInput').setInputFiles({ name: 'chosen.md', mimeType: 'text/markdown', buffer: Buffer.from('# Chosen\n\nA copy.\n') });
    await expect(page.locator('#mdvLiveChip')).toContainText('A copy');
    await page.waitForTimeout(200);
    await page.screenshot({ path: info.outputPath(`live-chip-copy-${theme}.png`), clip: { x: 766, y: 48, width: 600, height: 56 } });
    expect(await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('#mdvLiveChip .mdv-live-chip-text'));
      const bg = getComputedStyle(document.querySelector('#mdvLiveChip')).backgroundColor;
      const lum = (c) => {
        const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [x, y] = [lum(s.color), lum(bg)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    }), `copy mark contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
    expect(errors).toEqual([]);
  });
}

// A :has() rule in css/live.css made every diagram drawing re-evaluate it: one 1.37 s long task on kitchen-sink.md in
// headless Chromium, and two font-timing tests of visuals.spec.mjs failed on CI. The toolbar and the chip are marked by
// script instead.
test('css/live.css has no :has() rule (each one restyled the page on every diagram drawing)', () => {
  const css = readFileSync(new URL('../../css/live.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).not.toMatch(/:has\(/);
});

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
