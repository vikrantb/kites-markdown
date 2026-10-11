// Search in files (js/folder-search.js): going to a match on a short line, Enter before the first results, files
// rewritten between two searches, the comment block left out, one row per line, the folder named, and the memory
// budget kept true. Helpers: folder-helpers.mjs.
import { test, expect } from '@playwright/test';
import { start, seed, removeFile, openFolder, expectTitle, openInTree, scrollY } from './folder-helpers.mjs';

const FILLER = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i} with enough words to take some vertical room on the page.`).join('\n\n');
const RELEASE = `# Release v2\n\nIntro mentions v2 and v2 again.\n\n${FILLER}\n\n- v2 shipped today\n\n${FILLER}\n\n- v2\n`;

const hits = (page) => page.locator('#mdvFolderSearchList .mdv-xs-hit');

async function search(page, query) {
  if (!(await page.locator('#mdvFolderSearch').isVisible())) await page.keyboard.press('Control+Shift+F');
  await page.fill('#mdvFolderSearchInput', query);
}

// Whether the element is inside the window.
const inView = (page, locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
});

test('a match on a line with no long word is shown at its own block, and two matches on one line make one row', async ({ page }) => {
  const problems = await start(page);
  await seed(page, { 'rel.md': RELEASE });
  await openFolder(page);
  await openInTree(page, 'status.md', 'Status');
  await search(page, 'v2');
  // One row per line: line 3 holds two matches, marked in one row.
  await expect(hits(page)).toHaveCount(4);
  await expect(hits(page).locator('.mdv-xs-line')).toHaveText(['1', '3', '85', '167']);
  await expect(hits(page).nth(1).locator('.search-match')).toHaveCount(2);
  await expect(page.locator('#mdvFolderSearchList .mdv-xs-count')).toHaveText('5');
  await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('5 matches in 1 file');
  // The control: a line with words of its own.
  await hits(page).nth(2).click();
  await expectTitle(page, 'Release v2');
  const items = page.locator('#mdBody li');
  await expect.poll(() => inView(page, items.nth(0)), { timeout: 5000 }).toBe(true);
  expect(await scrollY(page)).toBeGreaterThan(1000);
  // The bare "- v2": its own list item, the last, with the words highlighted.
  await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); CSS.highlights.delete('mdv-folder-match'); });
  await search(page, 'v2');
  await expect(hits(page)).toHaveCount(4);
  await hits(page).nth(3).click();
  await expect.poll(() => inView(page, items.nth(1)), { timeout: 5000 }).toBe(true);
  expect(await page.evaluate(() => CSS.highlights.has('mdv-folder-match'))).toBe(true);
  expect(await scrollY(page)).toBeGreaterThan(2000);
  expect(problems).toEqual([]);
});

test('Enter pressed before the first results are there goes to the first match once they are', async ({ page }) => {
  const problems = await start(page, { folder: 'p9' });
  await seed(page, { 'a.md': '# A\n\nNothing to see.\n', 'b.md': '# B\n\nThe needle is here.\n' }, 'p9');
  await openFolder(page);
  await openInTree(page, 'a.md', 'A');
  // A slow disk: the first search reads the whole folder before it can answer.
  await page.evaluate(() => { window.__slowAll = true; });
  await page.keyboard.press('Control+Shift+F');
  await page.keyboard.type('needle');
  await page.waitForTimeout(300); // the typing pause has passed; the search waits for the folder to be read
  await page.keyboard.press('Enter');
  await expect(page.locator('#mdvFolderSearch')).toBeHidden({ timeout: 10_000 });
  await expectTitle(page, 'B');
  // Typing on after Enter means the reader is still choosing: nothing opens by itself.
  await page.evaluate(() => { window.__slowAll = false; });
  await openInTree(page, 'a.md', 'A');
  await page.evaluate(() => { mdvXs.index = new Map(); mdvXs.bytes = 0; window.__slowAll = true; });
  await page.keyboard.press('Control+Shift+F');
  await page.fill('#mdvFolderSearchInput', 'needl');
  await page.keyboard.press('Enter');
  await page.keyboard.type('e');
  await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('1 match in 1 file', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await expect(page.locator('#mdvFolderSearch')).toBeVisible();
  await expectTitle(page, 'A');
  expect(problems).toEqual([]);
});

test('a file rewritten between two searches is searched as it is now', async ({ page }) => {
  const problems = await start(page);
  await seed(page, { 'live.md': '# Live\n\nnothing here yet\n' });
  await openFolder(page);
  await openInTree(page, 'live.md', 'Live');
  await search(page, 'needle');
  await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('No matches in “notes”');
  await page.keyboard.press('Escape');
  await seed(page, { 'live.md': '# Live\n\nnow the needle phrase is here, a longer file\n' });
  await page.keyboard.press('Control+Shift+F');
  await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('1 match in 1 file');
  await expect(hits(page).first().locator('.search-match')).toHaveText('needle');
  expect(problems).toEqual([]);
});

test('words that are only in the comment block at the end of a file are not searched', async ({ page }) => {
  const problems = await start(page);
  const block = '<!-- MDV-COMMENTS:v1\n{"comments":[{"id":"cm_1","body_md":"zebracomment"}]}\nMDV-COMMENTS:end -->\n';
  await seed(page, { 'c.md': '# C\n\nPlain text with a giraffeword in it.\n\n' + block });
  await openFolder(page);
  await openInTree(page, 'c.md', 'C');
  // The control: a word of the document itself is found.
  await search(page, 'giraffeword');
  await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('1 match in 1 file');
  await search(page, 'zebracomment');
  await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('No matches in “notes”');
  expect(problems).toEqual([]);
});

test('the memory budget counts only the text it holds: a file that is gone gives its bytes back', async ({ page }) => {
  const problems = await start(page);
  await seed(page, { 'gone-soon.md': '# Gone soon\n\n' + 'Words that take room. '.repeat(200) + '\n' });
  await openFolder(page);
  await openInTree(page, 'status.md', 'Status');
  await search(page, 'rate limiter');
  await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('2 matches in 2 files');
  const held = () => page.evaluate(() => [...mdvXs.index.values()].filter((d) => typeof d.text === 'string').reduce((n, d) => n + d.size, 0));
  const counted = () => page.evaluate(() => mdvXs.bytes);
  expect(await counted()).toBe(await held());
  expect(await counted()).toBeGreaterThan(4000);
  // Deleted while the listing still has it: the next search finds it gone when it looks.
  await page.keyboard.press('Escape');
  await removeFile(page, 'gone-soon.md');
  await page.evaluate(() => { mdvFolderState.listedAt = Date.now(); }); // a listing that still names it
  await page.keyboard.press('Control+Shift+F');
  await expect.poll(() => page.evaluate(() => mdvXs.index.has('gone-soon.md'))).toBe(false);
  expect(await counted()).toBe(await held());
  expect(problems).toEqual([]);
});
