// The desktop app, for a document opened in its window from a link (js/host.js with js/history.js): View → Reload,
// opening the window's own file again, the Go menu, Back reading the window's file, and the names notices use. The
// shell is the stand-in desktop.spec.mjs uses, with the app's Content Security Policy.
import { test, expect } from '@playwright/test';
import { recordOpens, setVisibility, openApp, windowFile, otherFile, longDocument } from './support/live.mjs';

const h1 = (page) => page.locator('#mdBody h1');

async function followTheLink(page) {
  await page.waitForSelector('#section-4');
  await page.locator('#mdBody a', { hasText: 'The other file' }).click();
  await expect(h1(page)).toHaveAttribute('aria-label', 'The other file');
}

test('desktop: View → Reload reloads a document opened from a link', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await followTheLink(page);
  // The page's own looks stop (a hidden window), so only View → Reload can show the new version
  await setVisibility(page, 'hidden');
  await page.evaluate((p) => Object.assign(window.__shell.disk[p], { text: '# The other file\n\nOpened from a link, then edited.\n', mtimeMs: 2600, version: 'v-2600' }), otherFile.path);
  await page.waitForTimeout(2600);
  await expect(page.locator('#mdBody')).not.toContainText('then edited');
  // The shell's View → Reload names the window's own file
  await page.evaluate((d) => window.__shell.emit('mdv://document-changed', d), Object.assign({}, windowFile, { reason: 'reload' }));
  await expect(page.locator('#mdBody')).toContainText('Opened from a link, then edited.');
  await expect(h1(page)).toHaveAttribute('aria-label', 'The other file');
  await expect(page.locator('#mdvLiveToast')).toHaveText('Updated: The other file');
  expect(await page.evaluate(() => mdvHost.currentPath)).toBe(otherFile.path);
  expect(errors).toEqual([]);
});

test('desktop: opening the window\'s own file again shows it, with the linked document one step Back', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await followTheLink(page);
  // A double-click on doc.md in the Finder: the shell brings this window to the front and says why
  await page.evaluate((d) => window.__shell.emit('mdv://open-document', d), Object.assign({}, windowFile, { reason: 'focus' }));
  await expect(h1(page)).toHaveAttribute('aria-label', 'The window file');
  expect(await page.evaluate(() => [mdvHost.currentPath, mdvHost.currentVersion])).toEqual([windowFile.path, windowFile.version]);
  await expect(page.locator('#mdvBackBtn')).toHaveAttribute('aria-label', 'Back to other.md');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'The other file');
  // The window's own file on screen already: the same event changes nothing
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveAttribute('aria-label', 'The window file');
  const length = await page.evaluate(() => history.length);
  await page.evaluate((d) => window.__shell.emit('mdv://open-document', d), Object.assign({}, windowFile, { reason: 'focus' }));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => history.length)).toBe(length);
  expect(errors).toEqual([]);
});

test('desktop: the Go menu\'s Back and Forward move between the window\'s documents', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await followTheLink(page);
  await page.evaluate(() => window.__shell.emit('mdv://go', 'back'));
  await expect(h1(page)).toHaveAttribute('aria-label', 'The window file');
  await page.evaluate(() => window.__shell.emit('mdv://go', 'forward'));
  await expect(h1(page)).toHaveAttribute('aria-label', 'The other file');
  expect(errors).toEqual([]);
});

test('desktop: Back reads the window\'s own file before showing it, so a change made meanwhile shows at once', async ({ page }) => {
  await recordOpens(page);
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await followTheLink(page);
  // Another program saves the window's file; the shell says so, and the page (showing the other file) lets it pass
  const changed = Object.assign({}, windowFile, { text: longDocument('The window file, saved meanwhile', '', { 4: '[The other file](other.md) is next to it.\n\n' }), mtimeMs: 3000, version: 'v-3000', reason: 'changed' });
  await page.evaluate((d) => { Object.assign(window.__shell.disk[d.path], d); window.__shell.emit('mdv://document-changed', d); }, changed);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(h1(page)).toHaveText(/saved meanwhile/);
  await page.waitForTimeout(2500);
  const opens = await page.evaluate(() => window.__opens.map((o) => [o.kind, o.text.includes('saved meanwhile')]));
  expect(opens).toEqual([['first', false], ['open', false], ['history', true]]);
  // The version shown is the one a save names
  expect(await page.evaluate(() => [mdvHost.currentMtimeMs, mdvHost.currentVersion])).toEqual([3000, 'v-3000']);
  expect(errors).toEqual([]);
});

test('desktop: notices name the document on screen, not the window\'s file', async ({ page }) => {
  const errors = await openApp(page, { doc: windowFile, disk: { [otherFile.path]: otherFile } });
  await followTheLink(page);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text', '# Pasted\n\nSome text to paste.\n');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect(page.locator('#mdvHostNotices')).toContainText('This window shows other.md.');
  expect(errors).toEqual([]);
});
