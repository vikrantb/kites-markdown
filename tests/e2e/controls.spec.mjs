// Every control of the viewer, clicked or typed into, with the effect it must have.
// The controls are found by id, class or title (never by data-action), so this spec runs unchanged
// against a viewer wired with inline handlers (main before this branch) and one wired by
// js/actions.js: the same results on both are the evidence that moving to delegated actions kept
// every behaviour. (Main also asks for favicon.ico; support/viewer.mjs counts that 404 as noise.)
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { collectProblems, stubFilePickers, openDocument } from './support/viewer.mjs';

const SAMPLE_FILE = fileURLToPath(new URL('../../samples/commented.md', import.meta.url));

test.beforeEach(async ({ page, context }) => {
  await stubFilePickers(page);
  // Speech would need audio; record what the player asks to speak instead.
  await page.addInitScript(() => {
    window.__mdvSpoken = [];
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = (u) => { window.__mdvSpoken.push(u.text); };
    }
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('toolbar: text size, width, contents, folding, focus, theme and settings', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');

  const label = page.locator('#fontLbl');
  await expect(label).toHaveText('M');
  await page.locator('.font-ctrl button').nth(0).click();
  await expect(label).toHaveText('S');
  await page.locator('.font-ctrl button').nth(1).click();
  await page.locator('.font-ctrl button').nth(1).click();
  await expect(label).toHaveText('L');

  await page.locator('#widthBtn').click();
  await expect(page.locator('#contentWrapper')).toHaveClass(/expanded/);
  await page.locator('#widthBtn').click();
  await expect(page.locator('#contentWrapper')).not.toHaveClass(/expanded/);

  await page.locator('#tocBtn').click();
  await expect(page.locator('#tocSidebar')).toHaveClass(/hidden/);
  await page.locator('#tocBtn').click();
  await expect(page.locator('#tocSidebar')).not.toHaveClass(/hidden/);

  await page.locator('#foldBtn').click();
  expect(await page.locator('#mdBody .section-content.collapsed').count()).toBeGreaterThan(0);
  await page.locator('#foldBtn').click();
  expect(await page.locator('#mdBody .section-content.collapsed').count()).toBe(0);

  await page.locator('#focusBtn').click();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await page.locator('#focusBtn').click();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);

  // Theme: the dropdown opens, each item applies its theme and closes it.
  for (const theme of ['dark', 'sepia', 'light']) {
    await page.locator('.dropdown-wrap > button').click();
    await expect(page.locator('#themeDD')).toHaveClass(/show/);
    await page.locator(`#themeDD [data-theme="${theme}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#themeDD')).not.toHaveClass(/show/);
  }

  // Settings: open, save a path (which closes it), reopen, close.
  await page.locator('.toolbar button[title="Settings"]').click();
  await expect(page.locator('#settingsPanel')).toHaveClass(/show/);
  await page.locator('#basePathInput').fill('notes');
  await page.locator('#settingsPanel .settings-actions button').nth(0).click();
  expect(await page.evaluate(() => localStorage.getItem('mdv-basepath'))).toBe('notes/');
  await expect(page.locator('#settingsPanel')).not.toHaveClass(/show/);
  await page.locator('.toolbar button[title="Settings"]').click();
  await page.locator('#settingsPanel .settings-actions button').nth(1).click();
  await expect(page.locator('#settingsPanel')).not.toHaveClass(/show/);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('search: typing, arrow keys and Enter, a click on a result, and the backdrop', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');
  const overlay = page.locator('#searchOverlay');
  const openSearch = () => page.locator('.toolbar button[title^="Search"]').click();

  await openSearch();
  await expect(overlay).toHaveClass(/show/);
  await page.locator('#searchInput').pressSequentially('queue');
  await expect(page.locator('.search-result-item').first()).toBeVisible();
  await page.locator('#searchInput').press('ArrowDown');
  await expect(page.locator('.search-result-item').first()).toHaveClass(/focused/);
  await page.locator('#searchInput').press('Enter');
  await expect(overlay).not.toHaveClass(/show/);

  await openSearch();
  await page.locator('#searchInput').pressSequentially('merge');
  await page.locator('.search-result-item').nth(1).click();
  await expect(overlay).not.toHaveClass(/show/);

  // A click inside the box keeps the search open; a click on the backdrop closes it.
  await openSearch();
  await page.locator('.search-footer').click();
  await expect(overlay).toHaveClass(/show/);
  await overlay.click({ position: { x: 8, y: 8 } });
  await expect(overlay).not.toHaveClass(/show/);

  // Escape in the input closes it too.
  await openSearch();
  await page.locator('#searchInput').press('Escape');
  await expect(overlay).not.toHaveClass(/show/);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('overlays: shortcuts backdrop, image lightbox, diagram zoom, fit and close', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');

  const shortcuts = page.locator('#shortcutsOverlay');
  await page.locator('body').press('?');
  await expect(shortcuts).toHaveClass(/show/);
  await page.locator('.shortcuts-box h3').click();
  await expect(shortcuts).toHaveClass(/show/);
  await shortcuts.click({ position: { x: 8, y: 8 } });
  await expect(shortcuts).not.toHaveClass(/show/);

  await page.locator('#mdBody img').first().click();
  await expect(page.locator('#lightbox')).toHaveClass(/show/);
  await page.locator('#lightbox').click();
  await expect(page.locator('#lightbox')).not.toHaveClass(/show/);

  const controls = page.locator('.diagram-overlay-controls button');
  const zoomLabel = page.locator('#diagramZoomLabel');
  await page.locator('.mermaid-wrapper .diagram-expand-btn').first().click();
  await expect(page.locator('#diagramOverlay')).toHaveClass(/show/);
  await expect(zoomLabel).toHaveText('Fit');
  await controls.nth(1).click();
  await expect(zoomLabel).toHaveText('125%');
  await controls.nth(0).click();
  await expect(zoomLabel).toHaveText('100%');
  await page.locator('#diagramFitBtn').click();
  await expect(zoomLabel).toHaveText('Fit');
  await controls.nth(3).click();
  await expect(page.locator('#diagramOverlay')).not.toHaveClass(/show/);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('links and code: tooltip copy, the links panel and copy-code', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');

  // The tooltip opens below the link; keep the link mid-screen so the tooltip is on screen too.
  const link = page.locator('#mdBody a[href="https://example.com/"]').first();
  await link.evaluate((a) => a.scrollIntoView({ block: 'center' }));
  await link.hover();
  await expect(page.locator('#linkTooltip')).toHaveClass(/visible/);
  await page.locator('#linkTooltipCopy').click();
  await expect(page.locator('#linkTooltipCopy')).toHaveText('Copied!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/');

  await page.locator('#linksPanelBtn').click();
  await expect(page.locator('#linksPanel')).toHaveClass(/show/);
  await page.locator('.links-panel-close').click();
  await expect(page.locator('#linksPanel')).not.toHaveClass(/show/);

  const copy = page.locator('#mdBody pre .copy-btn').first();
  await copy.click();
  await expect(copy).toHaveText('Copied!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('interface Operation');

  expect(problems, problems.join('\n')).toEqual([]);
});

test('read-aloud player: open, play and pause, next, previous, seek, speed and close', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');
  const player = page.locator('#ttsPlayer');
  const label = page.locator('#ttsSectionLabel');
  const buttons = page.locator('#ttsPlayer .tts-btn');

  await page.locator('#ttsToggleBtn').click();
  await expect(player).toHaveClass(/show/);
  await expect(label).toHaveText(/^1\//);

  await page.locator('#ttsPlayBtn').click();
  await expect(page.locator('#ttsPauseIcon')).toBeVisible();
  expect((await page.evaluate(() => window.__mdvSpoken)).length).toBeGreaterThan(0);
  await page.locator('#ttsPlayBtn').click();
  await expect(page.locator('#ttsPlayIcon')).toBeVisible();

  await buttons.nth(2).click();
  await expect(label).toHaveText(/^2\//);
  await buttons.nth(0).click();
  await expect(label).toHaveText(/^1\//);

  const bar = await page.locator('#ttsProgressBar').boundingBox();
  await page.locator('#ttsProgressBar').click({ position: { x: bar.width * 0.6, y: bar.height / 2 } });
  await expect(label).not.toHaveText(/^1\//);

  await expect(page.locator('#ttsSpeedBtn')).toHaveText('1x');
  await page.locator('#ttsSpeedBtn').click();
  await expect(page.locator('#ttsSpeedBtn')).toHaveText('1.25x');

  await page.locator('#ttsPlayer .tts-close').click();
  await expect(player).not.toHaveClass(/show/);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('scroll buttons and the comment sidebar', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');
  await page.locator('#fabDown').click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  await page.locator('#fabUp').click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await openDocument(page, 'samples/commented.md');
  await expect(page.locator('#mdvToggleBtn')).toBeVisible();
  await page.locator('#mdvToggleBtn').click();
  await expect(page.locator('#mdvSidebar')).toHaveClass(/open/);
  await page.locator('.mdv-sidebar-close').click();
  await expect(page.locator('#mdvSidebar')).not.toHaveClass(/open/);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('files: Open, the file input, the writable open and the workspace buttons', async ({ page }) => {
  const problems = collectProblems(page);
  await openDocument(page, 'samples/kitchen-sink.md');

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.toolbar button[title="Open file"]').click(),
  ]);
  await chooser.setFiles(SAMPLE_FILE);
  await expect(page.locator('#titleText')).toHaveText('commented.md');

  await page.locator('#mdvOpenBtn').click();
  await page.locator('#mdvWorkspaceBtn').click();
  await expect.poll(() => page.evaluate(() => window.__mdvPickerCalls.slice().sort()))
    .toEqual(['showDirectoryPicker', 'showSaveFilePicker']);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('the welcome screen Browse button opens one file dialog and the click stops there', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('markdown-viewer.html');
  // Listeners above the button: they must not see the click on it (the file input's own click,
  // which opens the dialog, is a different event).
  await page.evaluate(() => {
    window.__mdvBubbled = 0;
    const count = (e) => { if (e.target.closest && e.target.closest('.drop-btn')) window.__mdvBubbled++; };
    document.getElementById('welcomeScreen').addEventListener('click', count);
    document.addEventListener('click', count);
  });
  let dialogs = 0;
  page.on('filechooser', () => { dialogs++; });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#dropZone .drop-btn').click()]);
  await page.waitForTimeout(300);
  expect(dialogs).toBe(1);
  expect(await page.evaluate(() => window.__mdvBubbled)).toBe(0);
  await chooser.setFiles(SAMPLE_FILE);
  await expect(page.locator('#titleText')).toHaveText('commented.md');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the "Open: <name>" prompt for a missing ?file= has a working Browse button', async ({ page }) => {
  const problems = collectProblems(page, [/no-such-file\.md/]);
  await page.goto('markdown-viewer.html?file=no-such-file.md');
  await expect(page.locator('#dropZone2')).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#dropZone2 .drop-btn').click()]);
  await chooser.setFiles(SAMPLE_FILE);
  await expect(page.locator('#titleText')).toHaveText('commented.md');
  expect(problems, problems.join('\n')).toEqual([]);
});
