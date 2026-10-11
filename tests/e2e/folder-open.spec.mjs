// Opening the folder's documents (js/folder-open.js): the last request wins, the reader's place is kept, a document
// the load seam declines leaves nothing behind, and the keyboard goes from the tree into the document and back.
// Helpers and the stand-in for stream L's load seam: folder-helpers.mjs.
import { test, expect } from '@playwright/test';
import { start, seed, openFolder, expectTitle, openInTree, scrollY } from './folder-helpers.mjs';

// A long document: 30 parts of three paragraphs each, so a place in it is far from its top.
const LONG = '# Long handoff\n\n' + Array.from({ length: 30 }, (_, i) => `## Part ${i + 1}\n\n` + [1, 2, 3].map((n) =>
  `Paragraph ${n} of part ${i + 1}. The rollout plan keeps a canary at five percent for an hour, then widens it while the error budget holds.`).join('\n\n')).join('\n\n') + '\n';

test('the last click wins: a slower read for an earlier choice never replaces a later one', async ({ page }) => {
  const problems = await start(page);
  await seed(page, { 'first.md': '# First\n\nThe first file.\n', 'second.md': '# Second\n\nThe second file.\n' });
  await openFolder(page);
  // The tree: first.md reads slowly (a large file, a busy disk), and the reader clicks second.md meanwhile.
  await page.evaluate(() => { window.__slowNames = ['first.md']; });
  await page.locator('#mdvFolderTree [data-path="first.md"]').click();
  await page.locator('#mdvFolderTree [data-path="second.md"]').click();
  await expectTitle(page, 'Second');
  await page.waitForTimeout(1500); // first.md's read has finished by now
  await expectTitle(page, 'Second');
  await expect(page.locator('#mdvFolderTree .is-current')).toHaveAttribute('data-path', 'second.md');
  expect((await page.evaluate(() => window.__opened)).map((o) => o.path)).toEqual(['second.md']);
  // Quick open, the same.
  await page.keyboard.press('Control+p');
  await page.keyboard.type('first');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+p');
  await page.keyboard.type('status');
  await page.keyboard.press('Enter');
  await expectTitle(page, 'Status');
  await page.waitForTimeout(1500);
  await expectTitle(page, 'Status');
  // A recent document, then the tree.
  await page.click('#mdvRecentBtn');
  await page.locator('#mdvRecentMenu .mdv-recent-item', { hasText: 'second.md' }).click();
  await expectTitle(page, 'Second');
  await page.evaluate(() => { window.__slowNames = ['second.md']; });
  await page.click('#mdvRecentBtn');
  await page.locator('#mdvRecentMenu .mdv-recent-item', { hasText: 'status.md' }).click();
  await expectTitle(page, 'Status');
  await page.click('#mdvRecentBtn');
  await page.locator('#mdvRecentMenu .mdv-recent-item', { hasText: 'second.md' }).click();
  await openInTree(page, 'README.md', 'Project notes');
  await page.waitForTimeout(1500);
  await expectTitle(page, 'Project notes');
  await expect(page.locator('#mdvFolderTree .is-current')).toHaveAttribute('data-path', 'README.md');
  expect(problems).toEqual([]);
});

test('going back to a document from the sidebar, quick open or the recent menu opens it where the reader left it', async ({ page }) => {
  const problems = await start(page);
  await seed(page, { 'long.md': LONG });
  await openFolder(page);
  await openInTree(page, 'long.md', 'Long handoff');
  // The reader scrolls down to part 20 (a wheel turn first, as a reader's own scrolling would).
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 400);
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('#mdBody h2')].find((el) => el.getAttribute('aria-label') === 'Part 20');
    window.scrollTo({ top: window.scrollY + h.getBoundingClientRect().top - 80, behavior: 'instant' });
  });
  await page.waitForTimeout(200);
  const place = await scrollY(page);
  expect(place).toBeGreaterThan(3000);
  const near = async () => Math.abs((await scrollY(page)) - place) <= 60;

  // The sidebar: another document, then back.
  await openInTree(page, 'status.md', 'Status');
  expect(await scrollY(page)).toBeLessThan(50);
  await openInTree(page, 'long.md', 'Long handoff');
  await expect.poll(near, { timeout: 5000 }).toBe(true);
  // Quick open.
  await page.keyboard.press('Control+p');
  await page.keyboard.type('status');
  await page.keyboard.press('Enter');
  await expectTitle(page, 'Status');
  await page.keyboard.press('Control+p');
  await page.keyboard.type('long');
  await page.keyboard.press('Enter');
  await expectTitle(page, 'Long handoff');
  await expect.poll(near, { timeout: 5000 }).toBe(true);
  // The recent menu.
  await page.click('#mdvRecentBtn');
  await page.locator('#mdvRecentMenu .mdv-recent-item', { hasText: 'status.md' }).click();
  await expectTitle(page, 'Status');
  await page.click('#mdvRecentBtn');
  await page.locator('#mdvRecentMenu .mdv-recent-item', { hasText: 'long.md' }).click();
  await expectTitle(page, 'Long handoff');
  await expect.poll(near, { timeout: 5000 }).toBe(true);
  // A document never read before opens at its top.
  await openInTree(page, 'handoffs/2026-10-08-ui.md', 'Handoff: the reading UI');
  expect(await scrollY(page)).toBeLessThan(50);
  // Search in files goes to the match, not to the place the reader left.
  await page.keyboard.press('Control+Shift+F');
  await page.keyboard.type('Paragraph 2 of part 3.');
  const hit = page.locator('#mdvFolderSearchList .mdv-xs-hit').first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expectTitle(page, 'Long handoff');
  const block = page.locator('#mdBody p', { hasText: 'Paragraph 2 of part 3.' });
  await expect.poll(async () => {
    const box = await block.boundingBox();
    return !!box && box.y >= 0 && box.y + box.height <= page.viewportSize().height;
  }, { timeout: 5000 }).toBe(true);
  expect(problems).toEqual([]);
});

test('a document the load seam declines leaves nothing behind for a later render to be taken for', async ({ page }) => {
  const problems = await start(page);
  const twin = '# Twin\n\nTwo files made from one template.\n';
  await seed(page, { 'twin-1.md': twin, 'twin-2.md': twin });
  await openFolder(page);
  await openInTree(page, 'status.md', 'Status');
  // The seam declines the next document (it could not be read through its handle, say).
  await page.evaluate(() => {
    window.__realOpen = window.mdvOpenDocument;
    window.mdvOpenDocument = async () => false;
  });
  await page.locator('#mdvFolderTree [data-path="twin-1.md"]').click();
  await page.waitForTimeout(300);
  await expectTitle(page, 'Status');
  expect(await page.evaluate(() => mdvFolderState.pendingOpen)).toBeNull();
  await page.evaluate(() => { window.mdvOpenDocument = window.__realOpen; });
  // The same text arrives by another route (pasted, dropped): it is not twin-1.md, which never opened.
  await page.evaluate((text) => { mdvFileHandle = null; rawMarkdown = text; renderMarkdown(text, 'Pasted Content'); }, twin);
  await expectTitle(page, 'Twin');
  await page.waitForTimeout(300);
  await expect(page.locator('#mdvFolderTree .is-current')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('Enter on a file in the sidebar moves the keyboard into the document; Space in the tree only opens; Ctrl/Cmd+Shift+E comes back', async ({ page }) => {
  const problems = await start(page);
  await seed(page, { 'long.md': LONG });
  await openFolder(page);
  const tree = page.locator('#mdvFolderTree');
  // Space: the document opens, and the focus stays on its row, to look through files.
  await tree.locator('[data-path="status.md"]').focus();
  await page.keyboard.press(' ');
  await expectTitle(page, 'Status');
  await expect(tree.locator('[data-path="status.md"]')).toBeFocused();
  // Enter: the focus moves into the document, so Space scrolls it.
  await tree.locator('[data-path="long.md"]').focus();
  await page.keyboard.press('Enter');
  await expectTitle(page, 'Long handoff');
  await expect.poll(() => page.evaluate(() => document.getElementById('mdBody').contains(document.activeElement))).toBe(true);
  expect(await scrollY(page)).toBeLessThan(50);
  await page.keyboard.press(' ');
  await expect.poll(() => scrollY(page)).toBeGreaterThan(200);
  // Back to the tree, on the document's row.
  await page.keyboard.press('Control+Shift+E');
  await expect(tree.locator('[data-path="long.md"]')).toBeFocused();
  // With the sidebar hidden, the key shows it first.
  await page.click('#mdvFolderBtn');
  await expect(page.locator('#mdvFolderPanel')).toBeHidden();
  await page.locator('#mdBody').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Shift+E');
  await expect(page.locator('#mdvFolderPanel')).toBeVisible();
  await expect(tree.locator('[data-path="long.md"]')).toBeFocused();
  // The filter box: Enter opens the first match and moves into it too.
  await page.fill('#mdvFolderFilter', 'status');
  await page.press('#mdvFolderFilter', 'Enter');
  await expectTitle(page, 'Status');
  await expect.poll(() => page.evaluate(() => document.getElementById('mdBody').contains(document.activeElement))).toBe(true);
  expect(problems).toEqual([]);
});
