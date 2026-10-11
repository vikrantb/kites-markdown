// Live reload's watch (js/live-reload.js): looks that hang or race, files that keep changing or go away, the mark that
// says a newer version waits, comment boxes and saves, and the note that says what changed.
import { test, expect } from '@playwright/test';
import {
  collectErrors, servedFile, longDocument, recordOpens, setVisibility, openHandleFile, writeHandleFile, openApp, windowFile, otherFile,
} from './support/live.mjs';

const md = (body) => ({ status: 200, contentType: 'text/markdown; charset=utf-8', body, headers: { 'Cache-Control': 'no-store' } });
const relativeTo = (from, to) => '../'.repeat(from.split('/').length - 1) + to;

test('a look that never answers does not stop the looks of the next document', async ({ page }, info) => {
  const errors = collectErrors(page);
  const next = servedFile(info, 'next.md', '# Next\n\nThe first version of next.\n');
  const hung = [];
  let asked = 0;
  await page.route('**/live-fixture/hang.md', async (route) => {
    if (asked++ === 0) await route.fulfill(md(`# Hang\n\n[To next](${relativeTo('live-fixture/hang.md', next.path)})\n`));
    else hung.push(route); // every later look never answers
  });
  await page.goto('markdown-viewer.html?file=live-fixture/hang.md');
  await page.waitForSelector('#mdBody h1');
  await expect.poll(() => hung.length, { timeout: 8000 }).toBeGreaterThan(0); // a look is on its way, and stays there
  await page.locator('#mdBody a', { hasText: 'To next' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Next');
  next.write('# Next\n\nThe second version of next.\n');
  await expect(page.locator('#mdBody')).toContainText('The second version of next.', { timeout: 8000 });
  for (const r of hung) await r.abort().catch(() => {});
  expect(errors).toEqual([]);
});

test('a look that never answers is given up after 8 s, and the next one shows the new version', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectErrors(page);
  const hung = [];
  let asked = 0;
  await page.route('**/live-fixture/hang-once.md', async (route) => {
    asked++;
    if (asked === 1) await route.fulfill(md('# Hang once\n\nThe first version.\n'));
    else if (asked === 2) hung.push(route); // this look never answers
    else await route.fulfill(md('# Hang once\n\nThe second version.\n'));
  });
  await page.goto('markdown-viewer.html?file=live-fixture/hang-once.md');
  await page.waitForSelector('#mdBody h1');
  await expect.poll(() => hung.length, { timeout: 8000 }).toBe(1);
  const hungAt = Date.now();
  await expect(page.locator('#mdBody')).toContainText('The second version.', { timeout: 20_000 });
  expect(Date.now() - hungAt, 'not before the hung look was given up').toBeGreaterThan(7500);
  for (const r of hung) await r.abort().catch(() => {});
  expect(errors).toEqual([]);
});

test('a file that changes all the time is shown every few looks, and is not read every 300 ms', async ({ page }) => {
  const errors = collectErrors(page);
  let n = 0;
  const requests = [];
  await page.route('**/live-fixture/stream.md', async (route) => {
    requests.push(Date.now());
    await route.fulfill(md(`# Stream\n\nentry ${n++}\n`)); // an agent writing into the file all the time
  });
  await page.goto('markdown-viewer.html?file=live-fixture/stream.md');
  await page.waitForSelector('#mdBody h1');
  const from = Date.now();
  const shown = new Set();
  while (Date.now() - from < 14_000) {
    shown.add(await page.locator('#mdBody p').first().textContent());
    await page.waitForTimeout(250);
  }
  const looks = requests.filter((t) => t > from).length;
  expect(shown.size, 'newer entries were shown').toBeGreaterThanOrEqual(3);
  // The 2 s pace alone is 7 looks in 14 s; one quick second look per new version adds a few. Reading every 300 ms was ~45.
  expect(looks).toBeLessThanOrEqual(15);
  expect(errors).toEqual([]);
});

test('an open comment box, even an empty one, holds a new version until it closes; nothing asks over it', async ({ page }, info) => {
  const errors = collectErrors(page);
  const text = '# Plan\n\nThe first paragraph of the plan.\n\n## Details\n\nMore of the plan.\n';
  const doc = servedFile(info, 'plan.md', text);
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody p').first().click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await expect(page.locator('.mdv-add-popup textarea')).toBeFocused(); // open, nothing typed
  await page.evaluate(() => { document.querySelector('#mdBody h1').dataset.probe = 'kept'; });
  doc.write(text + '\nA line another program added.\n');
  const chip = page.locator('#mdvLiveChip');
  await expect(chip).toContainText('shown when you close the comment box', { timeout: 10_000 });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => document.querySelector('#mdBody h1').dataset.probe), 'the page was not replaced under the box').toBe('kept');
  await expect(page.locator('#mdvLivePrompt')).toHaveCount(0);
  await page.locator('.mdv-add-popup .mdv-add-cancel').click();
  await expect(page.locator('#mdBody')).toContainText('A line another program added.', { timeout: 5000 });
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: Details');
  await expect(chip).toBeHidden();
  expect(errors).toEqual([]);
});

test('a comment typed while the file changed can still be saved; the comment code settles the conflict, and nothing else asks', async ({ page }) => {
  const errors = collectErrors(page, [/MDV save failed/]);
  await page.goto('markdown-viewer.html');
  await openHandleFile(page, 'typed.md', '# Typed\n\nThe paragraph to comment on.\n\n## More\n\nOther text.\n');
  await page.waitForSelector('#mdBody h1');
  // The question is recorded if it ever shows
  await page.evaluate(() => {
    window.__asked = 0;
    new MutationObserver(() => { const p = document.getElementById('mdvLivePrompt'); if (p && !p.hidden) window.__asked++; })
      .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
  await page.locator('#mdBody p').first().click({ button: 'right' });
  await page.locator('.mdv-ctx-menu button').click();
  await page.locator('.mdv-add-popup textarea').fill('My note on the paragraph');
  await writeHandleFile(page, '# Typed\n\nThe paragraph to comment on.\n\n## More\n\nOther text, edited by another program.\n');
  await expect(page.locator('#mdvLiveChip')).toContainText('shown when you close the comment box', { timeout: 10_000 });
  await page.locator('.mdv-add-popup .mdv-add-save').click();
  await expect(page.locator('.mdv-add-popup')).toHaveCount(0);
  // The comment was taken (the box was never left pointing at text that is gone)
  expect(await page.evaluate(() => mdvComments.some((c) => c.body_md === 'My note on the paragraph'))).toBe(true);
  await expect(page.locator('.mdv-toast', { hasText: 'changed while you were typing' })).toHaveCount(0);
  // The file changed under the save: the comment code's own notice asks, and live reload asks nothing
  await expect(page.locator('#mdvNotices')).toContainText('Not saved: the file changed on disk', { timeout: 10_000 });
  await page.waitForTimeout(3500);
  expect(await page.evaluate(() => window.__asked)).toBe(0);
  await expect(page.locator('#mdvLiveChip')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a file removed from disk says so, and is shown again within a few seconds of coming back', async ({ page }, info) => {
  const errors = collectErrors(page, [/status of 404/]); // the browser's own line for each look that finds nothing
  const doc = servedFile(info, 'status.md', '# Status\n\nIn progress.\n');
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h1');
  doc.remove(); // a branch switch
  const chip = page.locator('#mdvLiveChip');
  await expect(chip).toContainText('status.md is not on disk', { timeout: 6000 });
  await expect(page.locator('#mdBody')).toContainText('In progress.');
  await page.waitForTimeout(9000); // well past the back-off that used to reach 16 s
  doc.write('# Status\n\nDone.\n');
  const back = Date.now();
  await expect(page.locator('#mdBody')).toContainText('Done.', { timeout: 6000 });
  expect(Date.now() - back).toBeLessThan(5500);
  await expect(chip).toBeHidden();
  expect(errors).toEqual([]);
});

test('the blocks a new version changed are marked for a moment, and the note says where', async ({ page }, info) => {
  const errors = collectErrors(page);
  const doc = servedFile(info, 'notes.md', longDocument('Notes'));
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#section-9');
  await page.evaluate(() => {
    window.__marked = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('#mdBody .mdv-live-changed')) {
        const t = el.textContent.trim().slice(0, 30);
        if (!window.__marked.includes(t)) window.__marked.push(t);
      }
    }).observe(document.getElementById('mdBody'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  const changed = longDocument('Notes')
    .replace('Paragraph 2 of section 7.', 'Paragraph 2 of section 7, rewritten by the agent.')
    .replace('## Section 10', 'A paragraph the agent added to section 9.\n\n## Section 10');
  doc.write(changed);
  await expect(page.locator('#mdBody')).toContainText('rewritten by the agent', { timeout: 10_000 });
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: Section 7 and 1 more');
  await expect.poll(() => page.evaluate(() => window.__marked.sort())).toEqual(['A paragraph the agent added to', 'Paragraph 2 of section 7, rewr']);
  expect(errors).toEqual([]);
});

test('a look about a document that was replaced while it waited changes nothing', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await page.waitForSelector('#section-4');
  await page.locator('#mdBody a', { hasText: 'The other file' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The other file');
  await setVisibility(page, 'hidden'); // the page's own looks stop; this test makes one by hand
  const r = await page.evaluate(async (p) => {
    while (mdvLive.look) await new Promise((r) => setTimeout(r, 50)); // a look of the page's own finishes first
    Object.assign(window.__shell.disk[p], { text: '# The other file\n\nChanged.\n', mtimeMs: 2500, version: 'v-2500' });
    window.__shell.delay[p] = 500;
    const look = { gen: mdvLive.gen, over: false };
    const pending = mdvLiveLook(mdvLiveTarget(), look);
    mdvLive.gen++; // another document is shown meanwhile
    const result = await pending;
    return { result, candidate: mdvLive.candidate, seen: mdvLive.seen };
  }, otherFile.path);
  expect(r).toEqual({ result: 'stale', candidate: null, seen: null });
  expect(errors).toEqual([]);
});

test('no look while a comment save is writing the file', async ({ page }) => {
  const errors = collectErrors(page);
  await recordOpens(page);
  await page.goto('markdown-viewer.html');
  await openHandleFile(page, 'saving.md', '# Saving\n\nThe first version.\n');
  await page.waitForSelector('#mdBody h1');
  // Count the looks: each one asks the handle for its file
  await page.evaluate(() => {
    window.__looks = 0;
    const getFile = window.__fh.getFile.bind(window.__fh);
    window.__fh.getFile = () => { window.__looks++; return getFile(); };
  });
  await expect.poll(() => page.evaluate(() => window.__looks), { timeout: 5000 }).toBeGreaterThan(0);
  // A save is in flight (as the comment code counts one) while another program changes the file
  await page.evaluate(() => { mdvWritesQueued++; });
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__looks = 0; });
  await writeHandleFile(page, '# Saving\n\nThe second version.\n');
  await page.waitForTimeout(3500);
  expect(await page.evaluate(() => window.__looks), 'no look during the save').toBe(0);
  await expect(page.locator('#mdBody')).toContainText('The first version.');
  await page.evaluate(() => { mdvWritesQueued--; });
  await expect(page.locator('#mdBody')).toContainText('The second version.', { timeout: 6000 });
  expect(errors).toEqual([]);
});

test('when the comment code already asks about the file, live reload does not ask again', async ({ page }) => {
  const errors = collectErrors(page, [/MDV save failed/]);
  await page.goto('markdown-viewer.html');
  await openHandleFile(page, 'conflict.md', '# Conflict\n\nThe paragraph.\n');
  await page.waitForSelector('#mdBody h1');
  await page.evaluate(() => {
    window.__asked = 0;
    new MutationObserver(() => { const p = document.getElementById('mdvLivePrompt'); if (p && !p.hidden) window.__asked++; })
      .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
  // Another program saves the file, and a comment is added at once: its save finds the file changed
  await page.evaluate(async () => {
    const w = await window.__fh.createWritable();
    await w.write('# Conflict\n\nThe paragraph, edited elsewhere.\n');
    await w.close();
    await mdvAddComment(document.querySelector('#mdBody p'), null, 'A comment saved too late');
    await mdvFlushWrites();
  });
  await expect(page.locator('#mdvNotices')).toContainText('Not saved: the file changed on disk');
  await page.waitForTimeout(4000); // live reload has seen the change by now
  expect(await page.evaluate(() => window.__asked), 'the question was never shown').toBe(0);
  await expect(page.locator('#mdvLiveChip')).toBeHidden();
  expect(errors).toEqual([]);
});

test('Alt+R answers the question, and opens it again from the mark', async ({ page }, info) => {
  const errors = collectErrors(page);
  const text = '# Plan\n\nThe first paragraph of the plan.\n';
  const doc = servedFile(info, 'plan.md', text);
  await page.goto(`markdown-viewer.html?file=${doc.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.evaluate(() => mdvAddComment(document.querySelector('#mdBody p'), null, 'An unsaved comment'));
  doc.write(text + '\nVersion two.\n');
  const prompt = page.locator('#mdvLivePrompt');
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await expect(prompt.getByRole('button', { name: 'Reload' })).toHaveAttribute('aria-keyshortcuts', 'Alt+R');
  await page.keyboard.press('Alt+KeyR');
  await expect(page.locator('#mdBody')).toContainText('Version two.');
  // Again, with "Not now": the mark's Alt+R opens the question with Reload focused, and Enter reloads
  await page.evaluate(() => mdvAddComment(document.querySelector('#mdBody p'), null, 'Another unsaved comment'));
  doc.write(text + '\nVersion two.\n\nVersion three.\n');
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('#mdvLiveChip')).toBeVisible();
  await page.locator('#mdBody h1').click(); // the reader is back in the document
  await page.keyboard.press('Alt+KeyR');
  await expect(prompt.getByRole('button', { name: 'Reload' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mdBody')).toContainText('Version three.');
  expect(errors).toEqual([]);
});

// A file handle whose reads take 400 ms (a large file, a network volume), as the comment code's writable open has it
async function openSlowHandle(page, text) {
  await page.evaluate(async (text) => {
    let body = text, stamp = 1;
    window.__setSlow = (t) => { body = t; stamp++; };
    const later = (v) => new Promise((r) => setTimeout(() => r(v), 400));
    window.__slow = { kind: 'file', name: 'slow.md', queryPermission: async () => 'granted', getFile: () => later(new File([body], 'slow.md', { lastModified: stamp })) };
    await mdvOpenWithHandle(window.__slow, { prompt: false });
  }, text);
}

test('the newest open wins: a slow file read through a handle never replaces the document the reader chose since', async ({ page }, info) => {
  const errors = collectErrors(page);
  const b = servedFile(info, 'b.md', '# Doc B\n\nThe document the reader chose.\n');
  await page.goto('markdown-viewer.html');
  await openSlowHandle(page, `# Doc A\n\n[To B](${b.path})\n`);
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Doc A');
  const length = await page.evaluate(() => history.length);
  // Another program changes A; live reload reads it again through the handle (400 ms)…
  await page.evaluate((p) => window.__setSlow(`# Doc A\n\n[To B](${p})\n\nA line another program added.\n`), b.path);
  await page.waitForFunction(() => mdvPendingOpen && mdvPendingOpen.viaHandle, null, { timeout: 15_000, polling: 10 });
  // …and the reader follows the link meanwhile
  await page.locator('#mdBody a', { hasText: 'To B' }).click();
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Doc B');
  await page.waitForTimeout(1500);
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Doc B');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect(new URL(page.url()).searchParams.get('file')).toBe(b.path);
  // The same with the seam called directly (as the folder sidebar will), then a link
  await page.evaluate(() => { mdvOpenDocument({ name: 'slow.md', handle: window.__slow }); });
  await page.waitForFunction(() => mdvPendingOpen && mdvPendingOpen.viaHandle, null, { timeout: 5000, polling: 10 });
  await page.evaluate(() => mdvOpenDocument({ name: 'pasted.md', text: '# Chosen meanwhile\n\nText.\n', kind: 'pasted' }));
  await page.waitForTimeout(1200);
  await expect(page.locator('#mdBody h1')).toHaveAttribute('aria-label', 'Chosen meanwhile');
  expect(errors).toEqual([]);
});
