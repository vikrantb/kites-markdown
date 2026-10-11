// The folder as a list of files, kept current while agents write to it: the contract's resolve, listing again when
// the window comes back or quick open opens, quick open's order and its recent documents, and what belongs to one
// folder rather than to its name. Helpers: folder-helpers.mjs.
import { test, expect } from '@playwright/test';
import {
  start, seed, openFolder, listedPaths, expectTitle, openInTree, ageListing, EXPECTED,
  ROOT, abs, desktopSetup, collectProblems,
} from './folder-helpers.mjs';

test.describe('in a browser', () => {
  test('mdvFolder.resolve: a missing fromPath means the document on screen, and web addresses and other disks are null', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    const resolve = (from, href) => page.evaluate(([f, h]) => mdvFolder.resolve(f, h), [from, href]);
    // Nothing on screen: a relative link has nothing to be relative to; the folder's top still has a meaning.
    expect(await resolve(null, 'status.md')).toBeNull();
    expect(await resolve(null, '/status.md')).toBe('status.md');
    // A document of the folder on screen: from its own place.
    await openInTree(page, 'handoffs/2026-10-01-api.md', 'Handoff: the API');
    expect(await resolve(null, '2026-10-08-ui.md')).toBe('handoffs/2026-10-08-ui.md');
    expect(await resolve(null, '../status.md')).toBe('status.md');
    // Protocol-relative addresses (the browser reads '/\' as '//' too) and paths on a disk are not the folder's.
    expect(await resolve('handoffs/2026-10-01-api.md', '//cdn.example.com/status.md')).toBeNull();
    expect(await resolve('handoffs/2026-10-01-api.md', '/\\cdn.example.com/status.md')).toBeNull();
    expect(await resolve('README.md', 'C:\\notes\\status.md')).toBeNull();
    expect(await resolve('README.md', '\\\\server\\share\\status.md')).toBeNull();
    // A document that is not in the folder on screen (pasted text): a relative link resolves to nothing.
    await page.evaluate(() => { mdvFileHandle = null; rawMarkdown = '# Pasted\n\n[s](status.md)\n'; renderMarkdown(rawMarkdown, 'Pasted Content'); });
    await expectTitle(page, 'Pasted');
    await expect.poll(() => page.evaluate(() => mdvFolderState.current)).toBeNull();
    expect(await resolve(null, 'status.md')).toBeNull();
    expect(problems).toEqual([]);
  });

  test('a file added while the window was away is listed when the window comes back', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    expect(await listedPaths(page)).toEqual(EXPECTED.listed);
    await seed(page, { 'handoffs/2026-10-11-hotfix.md': '# Handoff: the hotfix\n' });
    await ageListing(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => listedPaths(page)).toContain('handoffs/2026-10-11-hotfix.md');
    await expect(page.locator('#mdvFolderStatus')).toHaveText('8 Markdown files');
    expect(problems).toEqual([]);
  });

  test('quick open finds a file an agent has just written, without the window losing focus', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await openInTree(page, 'status.md', 'Status');
    await seed(page, { 'handoffs/2026-10-11-hotfix.md': '# Handoff: the hotfix\n' });
    await ageListing(page);
    await page.keyboard.press('Control+p');
    await page.keyboard.type('hotfix');
    const rows = page.locator('#mdvQuickOpenList [role="option"]');
    await expect(rows.first().locator('.mdv-palette-name')).toHaveText('2026-10-11-hotfix.md');
    await page.keyboard.press('Enter');
    await expectTitle(page, 'Handoff: the hotfix');
    await expect(page.locator('#mdvFolderStatus')).toHaveText('8 Markdown files');
    // A listing that arrives while the reader moves through the list keeps them on their row.
    await page.keyboard.press('Control+p');
    await page.keyboard.type('hand');
    await expect(rows).toHaveCount(3);
    await page.keyboard.press('ArrowDown');
    const chosen = await rows.nth(1).locator('.mdv-palette-name').textContent();
    await page.evaluate(() => mdvFolderRefresh());
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(rows.nth(1).locator('.mdv-palette-name')).toHaveText(chosen);
    expect(problems).toEqual([]);
  });

  test('quick open with nothing typed lists the recent documents, then the most recently changed files first', async ({ page }) => {
    const problems = await start(page);
    await page.waitForTimeout(50);
    await seed(page, { 'handoffs/2026-10-11-newest.md': '# Handoff: the newest\n' });
    await openFolder(page);
    await page.keyboard.press('Control+p');
    const names = page.locator('#mdvQuickOpenList .mdv-palette-name');
    // No recent documents yet: the file written last comes first.
    await expect(names.first()).toHaveText('2026-10-11-newest.md');
    await page.keyboard.press('Enter');
    await expectTitle(page, 'Handoff: the newest');
    await openInTree(page, 'status.md', 'Status');
    await page.waitForTimeout(50);
    await seed(page, { 'proposals/later.md': '# A later proposal\n' });
    await ageListing(page);
    await page.keyboard.press('Control+p');
    // The recent documents (newest first), then the files by time.
    await expect(names.nth(2)).toHaveText('later.md');
    await expect(names.nth(0)).toHaveText('status.md');
    await expect(names.nth(1)).toHaveText('2026-10-11-newest.md');
    await expect(page.locator('#mdvQuickOpenList [role="option"]').nth(1).locator('.mdv-palette-tag')).toHaveText('recent');
    expect(problems).toEqual([]);
  });

  test('another folder with the same name is another folder: its tree, its search index and quick open\'s recent documents', async ({ page }) => {
    const problems = await start(page);
    await seed(page, { 'status.md': '# Other status\n\nAnother project.\n', 'handoffs/a.md': '# A\n' }, 'elsewhere/notes');
    await openFolder(page);
    await openInTree(page, 'status.md', 'Status');
    // The reader closes handoffs here.
    await page.locator('#mdvFolderTree [data-rel="handoffs"]').click();
    await expect(page.locator('#mdvFolderTree [data-rel="handoffs"]')).toHaveAttribute('aria-expanded', 'false');
    const firstKey = await page.evaluate(() => mdvXsFolderKey());
    // Another folder, also called notes.
    await page.evaluate(() => { window.__pickFolder = 'elsewhere/notes'; });
    await page.locator('#mdvFolderPanel [data-action="folder-choose"]').click();
    await expect.poll(() => listedPaths(page)).toEqual(['handoffs/a.md', 'status.md']);
    await expect(page.locator('#mdvFolderName')).toHaveText('notes');
    // Its own tree, opened as a small folder is.
    await expect(page.locator('#mdvFolderTree [data-rel="handoffs"]')).toHaveAttribute('aria-expanded', 'true');
    // Its own search index.
    expect(await page.evaluate(() => mdvXsFolderKey())).not.toBe(firstKey);
    // The status.md read in the first folder is a recent document, not this folder's status.md.
    await page.keyboard.press('Control+p');
    const recent = page.locator('#mdvQuickOpenList [role="option"]').filter({ has: page.locator('.mdv-palette-tag') });
    await expect(recent).toHaveCount(1);
    await expect(recent.locator('.mdv-palette-where')).toHaveText('notes');
    const thisOne = page.locator('#mdvQuickOpenList [role="option"]').filter({ hasText: 'status.md' }).filter({ hasNot: page.locator('.mdv-palette-tag') });
    await expect(thisOne).toHaveCount(1);
    await thisOne.click();
    await expectTitle(page, 'Other status');
    expect(problems).toEqual([]);
  });
});

test.describe('in the desktop app', () => {
  test('mdvFolder.resolve: a leading / is the folder\'s top unless it names a path inside the folder', async ({ page }) => {
    const problems = collectProblems(page);
    await desktopSetup(page);
    await page.goto('markdown-viewer.html');
    await expectTitle(page, 'Project notes');
    await openFolder(page);
    const resolve = (from, href) => page.evaluate(([f, h]) => mdvFolder.resolve(f, h), [from, href]);
    expect(await resolve(abs('handoffs/2026-10-01-api.md'), '/proposals/search.md')).toBe(abs('proposals/search.md'));
    expect(await resolve(abs('handoffs/2026-10-01-api.md'), abs('status.md'))).toBe(abs('status.md'));
    expect(await resolve(abs('handoffs/2026-10-01-api.md'), '../status.md')).toBe(abs('status.md'));
    expect(await resolve(abs('README.md'), '../outside.md')).toBeNull();
    expect(await resolve(abs('README.md'), '//cdn.example.com/status.md')).toBeNull();
    // The document on screen (README.md) when fromPath is missing.
    expect(await resolve(null, 'status.md')).toBe(abs('status.md'));
    expect(ROOT).toBe('/work/notes');
    expect(problems).toEqual([]);
  });
});
