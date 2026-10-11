// Back and Forward between documents (js/history.js) and links that open in the viewer (js/document-links.js): places
// inside a document, reloads of the tab, the focus, the version on disk, unsaved comments, races between a link and
// Back, and the gestures the browser offers for a link.
import { test, expect } from '@playwright/test';
import { waitForLayoutSettled } from './support/viewer.mjs';
import {
  ALT_LEFT, collectErrors, servedFile, longDocument, expectHeadingAt, recordOpens,
} from './support/live.mjs';

const h1 = (page) => page.locator('#mdBody h1');

test('after a reload of the tab, Back between places of the same document does not read the page again', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# A\n\n[To B](b.md)\n');
  servedFile(info, 'b.md', longDocument('Document B', '', { 1: 'Contents: [Jump to nine](#section-9), [jump to two](#section-2).\n\n' }));
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'To B' }).click();
  await expect(h1(page)).toHaveText(/Document B/);
  await page.locator('#mdBody a', { hasText: 'Jump to nine' }).click(); // a place made before the reload
  await expect.poll(() => new URL(page.url()).hash).toBe('#section-9');
  await page.reload();
  await page.waitForSelector('#section-9');
  // An unsaved comment (over http there is no file to save it into), then a probe the page loses if it is drawn again
  await page.evaluate(() => mdvAddComment(document.querySelector('#mdBody p'), null, 'My unsaved note'));
  await page.evaluate(() => { document.querySelector('#mdBody h1').dataset.probe = 'kept'; });
  const kept = () => page.evaluate(() => ({ probe: document.querySelector('#mdBody h1').dataset.probe, dirty: mdvDirty, note: rawMarkdown.includes('My unsaved note') }));
  // A place made after the reload, then Back to it, then Back to the places made before the reload
  await page.locator('#mdBody a', { hasText: 'jump to two' }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#section-2');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('#section-9');
  await page.waitForTimeout(800);
  expect(await kept()).toEqual({ probe: 'kept', dirty: true, note: true });
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.waitForTimeout(800);
  expect(await kept()).toEqual({ probe: 'kept', dirty: true, note: true });
  expect(errors).toEqual([]);
});

test('Back and Forward step over the places inside a document, and go where their names say', async ({ page }, info) => {
  const errors = collectErrors(page);
  const readme = servedFile(info, 'readme.md', '# Readme\n\nStart with [the handoff](handoff.md).\n');
  servedFile(info, 'handoff.md', longDocument('Handoff', '', { 1: 'Contents: [Risks](#section-5).\n\n' }));
  await page.goto(`markdown-viewer.html?file=${readme.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'the handoff' }).click();
  await expect(h1(page)).toHaveText(/Handoff/);
  await waitForLayoutSettled(page);
  await page.locator('#mdBody a', { hasText: 'Risks' }).click(); // an in-document place
  await expect.poll(() => new URL(page.url()).hash).toBe('#section-5');
  // The smooth scroll ends: the page holds still for 300 ms
  let lastY = -1;
  await expect.poll(async () => { const y = await page.evaluate(() => scrollY); const still = y === lastY; lastY = y; return still; },
    { intervals: [300], timeout: 10_000 }).toBe(true);
  const risksTop = await page.evaluate(() => document.getElementById('section-5').getBoundingClientRect().top);
  expect(risksTop).toBeLessThan(200);
  const back = page.locator('#mdvBackBtn');
  const forward = page.locator('#mdvForwardBtn');
  await expect(back).toHaveAttribute('title', `Back to readme.md (${ALT_LEFT})`);
  await back.click(); // one press: the readme, not the top of the handoff
  await expect(h1(page)).toHaveText(/Readme/);
  await expect(forward).toHaveAttribute('aria-label', 'Forward to handoff.md');
  await forward.click();
  await expect(h1(page)).toHaveText(/Handoff/);
  // Back where the reader left the handoff: at Risks
  await expectHeadingAt(page, 'section-5', risksTop);
  expect(errors).toEqual([]);
});

test('a heading\'s "#" permalink is a place of the document too: Back still goes to the previous document in one press', async ({ page }, info) => {
  const errors = collectErrors(page);
  const readme = servedFile(info, 'readme.md', '# Readme\n\nStart with [the handoff](handoff.md).\n');
  servedFile(info, 'handoff.md', longDocument('Handoff'));
  await page.goto(`markdown-viewer.html?file=${readme.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'the handoff' }).click();
  await expect(h1(page)).toHaveText(/Handoff/);
  await waitForLayoutSettled(page);
  // The permalink after a heading is the browser's own jump (js/links.js leaves it alone): it shows on hover
  await page.locator('#section-3').hover();
  await page.locator('#section-3 a.header-anchor').click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#section-3');
  await expect(page.locator('#mdvBackBtn')).toHaveAttribute('aria-label', 'Back to readme.md');
  await page.locator('#mdvBackBtn').click();
  await expect(h1(page)).toHaveText(/Readme/);
  expect(errors).toEqual([]);
});

test('after a reload of the page, Back and Forward still name and reach the documents', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# A\n\n[To B](b.md)\n');
  servedFile(info, 'b.md', '# B\n\n[To C](c.md)\n');
  servedFile(info, 'c.md', '# C\n\nThe last one.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'To B' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'B');
  await page.locator('#mdBody a', { hasText: 'To C' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'C');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'B');
  await page.reload();
  await expect(h1(page)).toHaveAttribute('aria-label', 'B');
  await expect(page.locator('#mdvBackBtn')).toHaveAttribute('aria-label', 'Back to a.md');
  await expect(page.locator('#mdvForwardBtn')).toHaveAttribute('aria-label', 'Forward to c.md');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(h1(page)).toHaveAttribute('aria-label', 'C');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'A');
  expect(errors).toEqual([]);
});

test('following a link puts the focus at the new document\'s start, and Back gives it back to that link', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# A\n\n- [First](b.md)\n- [Second](b.md)\n- [Third](c.md)\n');
  servedFile(info, 'b.md', '# B\n\nText.\n');
  servedFile(info, 'c.md', '# C\n\nThe third one, [and a link](b.md).\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'Third' }).focus();
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveAttribute('aria-label', 'C');
  expect(await page.evaluate(() => document.activeElement.closest('#mdBody') && document.activeElement.tagName)).toBe('H1');
  // Tab goes on from there, in the document (from the page's start it went to the toolbar)
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('#mdBody'))).toBe(true);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'A');
  expect(await page.evaluate(() => document.activeElement.textContent)).toBe('Third');
  expect(errors).toEqual([]);
});

test('Back shows the version on disk now, never the old one first', async ({ page }, info) => {
  const errors = collectErrors(page);
  await recordOpens(page);
  const a = servedFile(info, 'a.md', '# Status\n\nIn progress.\n\n[The PR](b.md)\n');
  servedFile(info, 'b.md', '# The PR\n\nNotes.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'The PR' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'The PR');
  a.write('# Status\n\nDone.\n\n[The PR](b.md)\n'); // while the reader is away
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('#mdBody')).toContainText('Done.');
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated since you left');
  await page.waitForTimeout(2500);
  const opens = await page.evaluate(() => window.__opens.map((o) => [o.kind, o.text.includes('Done.')]));
  expect(opens).toEqual([['first', false], ['open', false], ['history', true]]);
  expect(errors).toEqual([]);
});

test('an unsaved comment keeps its protection after the reader follows a link and comes back', async ({ page }, info) => {
  const errors = collectErrors(page);
  const text = '# Status\n\nIn progress.\n\nSee [PR 104](pr-104.md).\n';
  const status = servedFile(info, 'status.md', text);
  servedFile(info, 'pr-104.md', '# PR 104\n\nThe change.\n');
  await page.goto(`markdown-viewer.html?file=${status.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.evaluate(() => mdvAddComment(document.querySelector('#mdBody p'), null, 'Ask about the rollout'));
  await page.locator('#mdBody a', { hasText: 'PR 104' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'PR 104');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'Status');
  expect(await page.evaluate(() => [mdvDirty, rawMarkdown.includes('Ask about the rollout')])).toEqual([true, true]);
  // The agent saves the file: the page is not replaced, the question asks
  await page.evaluate(() => { document.querySelector('#mdBody h1').dataset.probe = 'kept'; });
  status.write(text.replace('In progress.', 'Done.'));
  const prompt = page.locator('#mdvLivePrompt');
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => document.querySelector('#mdBody h1').dataset.probe)).toBe('kept');
  await prompt.getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('#mdBody')).toContainText('Done.');
  expect(await page.evaluate(() => mdvNotices.some((n) => n.kind === 'unsaved' && n.text.includes('Ask about the rollout')))).toBe(true);
  expect(errors).toEqual([]);
});

test('a link followed while an older one is still being read wins', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# A\n\n[Slow](slow.md) and [fast](fast.md).\n');
  servedFile(info, 'slow.md', '# Slow\n\nArrives late.\n');
  servedFile(info, 'fast.md', '# Fast\n\nArrives at once.\n');
  await page.route('**/slow.md', async (route) => { await new Promise((r) => setTimeout(r, 1000)); await route.continue(); });
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  const length = await page.evaluate(() => history.length);
  await page.locator('#mdBody a', { hasText: 'Slow' }).click();
  await page.locator('#mdBody a', { hasText: 'fast' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'Fast');
  await page.waitForTimeout(1500); // the slow one has arrived by now
  await expect(h1(page)).toHaveAttribute('aria-label', 'Fast');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect(errors).toEqual([]);
});

test('Back, then a link before Back has read its file: the link wins, and Back and Forward stay right', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# A\n\n[To B](b.md)\n');
  servedFile(info, 'b.md', '# B\n\n[To C](c.md)\n');
  servedFile(info, 'c.md', '# C\n\nThe end.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'To B' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'B');
  await page.route('**/a.md', async (route) => { await new Promise((r) => setTimeout(r, 400)); await route.continue(); });
  await page.keyboard.press('Alt+ArrowLeft'); // Back reads a.md again (400 ms)…
  await page.locator('#mdBody a', { hasText: 'To C' }).click(); // …and the reader follows B's link meanwhile
  await expect(h1(page)).toHaveAttribute('aria-label', 'C');
  await page.waitForTimeout(1000);
  await expect(h1(page)).toHaveAttribute('aria-label', 'C');
  // The tab went back to A, then on to C: B is no longer in it
  await expect(page.locator('#mdvBackBtn')).toHaveAttribute('aria-label', 'Back to a.md');
  await page.locator('#mdvBackBtn').click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'A');
  await expect(page.locator('#mdvForwardBtn')).toHaveAttribute('aria-label', 'Forward to c.md');
  expect(errors).toEqual([]);
});

test('a document that can no longer be read: Back says so, and the page and its address stay', async ({ page }, info) => {
  const errors = collectErrors(page, [/status of 404/]);
  const a = servedFile(info, 'a.md', '# A\n\n[To B](b.md)\n');
  const b = servedFile(info, 'b.md', '# B\n\nThe second one.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  await page.locator('#mdBody a', { hasText: 'To B' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'B');
  await page.reload(); // A's text is no longer in memory
  await expect(h1(page)).toHaveAttribute('aria-label', 'B');
  a.remove();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.mdv-toast')).toContainText('a.md could not be opened');
  await expect.poll(() => new URL(page.url()).searchParams.get('file')).toBe(b.path);
  await expect(h1(page)).toHaveAttribute('aria-label', 'B');
  await expect(page.locator('#mdvBackBtn')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a link to a Markdown file carries the viewer\'s own address, so a middle click opens the viewer', async ({ page, context }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'notes/a.md', '# A\n\nRead [the plan](../plans/plan.md#part-2) first.\n\n[The plan, as a card](../plans/plan.md)\n');
  const plan = servedFile(info, 'plans/plan.md', '# The plan\n\n## Part 2\n\nThe second part.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  const viewer = new URL('markdown-viewer.html', page.url());
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('#mdBody a[href]')].filter((x) => !x.classList.contains('header-anchor')).map((x) => x.href));
  for (const href of hrefs) {
    const u = new URL(href);
    expect(u.pathname).toBe(viewer.pathname);
    expect(u.searchParams.get('file')).toBe(plan.path);
  }
  expect(new URL(hrefs[0]).hash).toBe('#part-2');
  // The status bar, "Copy link address" and "Open link in new tab" use that address; a middle click too
  const opened = context.waitForEvent('page');
  await page.locator('#mdBody').getByRole('link', { name: 'the plan', exact: true }).click({ button: 'middle' });
  const tab = await opened;
  await tab.waitForLoadState();
  await expect(tab.locator('#mdBody h1')).toHaveAttribute('aria-label', 'The plan');
  await tab.close();
  // A plain click still opens it here
  await page.locator('#mdBody').getByRole('link', { name: 'the plan', exact: true }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'The plan');
  expect(errors).toEqual([]);
});

test('two different files with the same name, chosen one after the other, are two places in Back/Forward', async ({ page }, info) => {
  const errors = collectErrors(page);
  const a = servedFile(info, 'a.md', '# Start\n\nServed.\n');
  await page.goto(`markdown-viewer.html?file=${a.path}`);
  await page.waitForSelector('#mdBody h1');
  for (const project of ['Project one', 'Project two']) {
    await page.locator('#fileInput').setInputFiles({ name: 'README.md', mimeType: 'text/markdown', buffer: Buffer.from(`# ${project}\n\nIts readme.\n`) });
    await expect(h1(page)).toHaveAttribute('aria-label', project);
  }
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'Project one');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'Start');
  expect(errors).toEqual([]);
});

// The browser's private file system (OPFS) stands in for the file the reader picks or drops
async function stubPickedFile(page, name, text) {
  await page.addInitScript(([name, text]) => {
    window.__picked = (async () => {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      return fh;
    })();
    window.showOpenFilePicker = async () => [await window.__picked];
    DataTransferItem.prototype.getAsFileSystemHandle = function () { return window.__picked; };
  }, [name, text]);
}
const writePicked = (page, text) => page.evaluate(async (text) => {
  const w = await (await window.__picked).createWritable();
  await w.write(text);
  await w.close();
}, text);

test('a file chosen with the Open button says it is a copy; Follow… opens the file itself, which is then followed', async ({ page }) => {
  const errors = collectErrors(page);
  await stubPickedFile(page, 'chosen.md', '# Chosen\n\nThe first version.\n');
  await page.goto('markdown-viewer.html');
  // The Open button's file input hands the page a snapshot of the file
  await page.locator('#fileInput').setInputFiles({ name: 'chosen.md', mimeType: 'text/markdown', buffer: Buffer.from('# Chosen\n\nThe first version.\n') });
  await expect(h1(page)).toHaveAttribute('aria-label', 'Chosen');
  const chip = page.locator('#mdvLiveChip');
  await expect(chip).toContainText('A copy: changes to chosen.md do not show here.');
  await chip.getByRole('button', { name: 'Follow…' }).click(); // the File System Access picker: the file itself
  await expect.poll(() => page.evaluate(() => mdvFileHandle && mdvFileHandle.name)).toBe('chosen.md');
  await expect(chip).toBeHidden();
  await writePicked(page, '# Chosen\n\nThe second version.\n');
  await expect(page.locator('#mdBody')).toContainText('The second version.', { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('a dropped file is read through a handle and followed (Chromium)', async ({ page }) => {
  const errors = collectErrors(page);
  await stubPickedFile(page, 'dropped.md', '# Dropped\n\nThe first version.\n');
  await page.goto('markdown-viewer.html');
  await page.evaluate(async () => {
    const data = new DataTransfer();
    data.items.add(new File([await (await (await window.__picked).getFile()).text()], 'dropped.md', { type: 'text/markdown' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(h1(page)).toHaveAttribute('aria-label', 'Dropped');
  await writePicked(page, '# Dropped\n\nThe second version.\n');
  await expect(page.locator('#mdBody')).toContainText('The second version.', { timeout: 10_000 });
  expect(errors).toEqual([]);
});

for (const width of [1366, 1280]) {
  test(`at ${width} px, with Back shown and the comments' "Not saved" status, the Open button stays on screen`, async ({ page }, info) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width, height: 900 });
    const a = servedFile(info, 'a.md', '# A status report with a name\n\n[The PR](b.md)\n');
    servedFile(info, 'b.md', '# The PR\n\nThe change.\n');
    await page.goto(`markdown-viewer.html?file=${a.path}`);
    await page.waitForSelector('#mdBody h1');
    await page.locator('#mdBody a', { hasText: 'The PR' }).click();
    await expect(h1(page)).toHaveAttribute('aria-label', 'The PR');
    await page.evaluate(() => mdvAddComment(document.querySelector('#mdBody p'), null, 'An unsaved comment'));
    await expect(page.locator('#mdvSaveStatus')).toBeVisible();
    await expect(page.locator('#mdvBackBtn')).toBeVisible();
    const layout = await page.evaluate(() => {
      const open = document.querySelector('.toolbar .btn:has(+ #fileInput)').getBoundingClientRect();
      return {
        toolbarScroll: document.querySelector('.toolbar').scrollWidth,
        openVisible: Math.round(Math.max(0, Math.min(open.right, innerWidth) - Math.max(open.left, 0))),
        openWidth: Math.round(open.width),
      };
    });
    expect(layout.toolbarScroll).toBeLessThanOrEqual(width);
    expect(layout.openVisible).toBe(layout.openWidth);
    expect(errors).toEqual([]);
  });
}
