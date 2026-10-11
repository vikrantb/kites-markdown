// A folder of documents: the sidebar, quick open, search in files, recent documents and link previews.
//
// Browser: the folder is tests/fixtures/folder, written into the origin-private file system (OPFS), whose
// handles are real FileSystemDirectoryHandles (listing, reading, resolve(), isSameEntry(), IndexedDB), and the
// folder picker is replaced by one that returns it. Desktop: a stand-in for the shell answers the bridge's
// commands (as desktop.spec.mjs does) and records them; the shell's own walk is tested by its unit tests
// (desktop/src-tauri/src/folders.rs) and by the app's self-test (--expect folder).
//
// mdvOpenDocument belongs to js/files.js (stream L). Until it is merged, the init script below provides a minimal
// one (render the document, link its handle); a real one defined by js/files.js replaces it, and the recorder
// wraps whichever is there. The tests assert on the page, not on the stand-in.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { collectProblems } from './support/viewer.mjs';

const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const FIXTURE = repo('tests/fixtures/folder');
const EXPECTED = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));
const APP_CSP = Object.entries(JSON.parse(readFileSync(repo('desktop/src-tauri/tauri.conf.json'), 'utf8')).app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`).join('; ');

function readTree(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, readTree(full));
    else out[relative(FIXTURE, full).split(sep).join('/')] = readFileSync(full, 'utf8');
  }
  return out;
}
const FILES = Object.assign(readTree(FIXTURE), EXPECTED.addedAtRunTime);

// ------- The browser: an OPFS folder, the picker, and mdvOpenDocument -------
async function browserSetup(page, { permission = 'granted' } = {}) {
  await page.addInitScript(({ permission }) => {
    window.__opened = [];
    window.__pickerCalls = 0;
    window.__permissionRequests = 0;
    window.showDirectoryPicker = async () => {
      window.__pickerCalls++;
      return (await navigator.storage.getDirectory()).getDirectoryHandle('notes');
    };
    // A remembered folder whose permission the browser dropped: it must be asked for again, from a click.
    if (permission !== 'granted') {
      const proto = FileSystemHandle.prototype;
      let granted = false;
      proto.queryPermission = async function () { return granted ? 'granted' : permission; };
      proto.requestPermission = async function () { window.__permissionRequests++; granted = true; return 'granted'; };
    }
    // Stream L's mdvOpenDocument stands in until it is merged (a function in js/files.js replaces this one).
    window.mdvOpenDocument = async (doc) => {
      mdvFileHandle = doc.handle || null;
      rawMarkdown = doc.text;
      currentFileName = doc.name;
      renderMarkdown(doc.text, doc.name);
    };
    document.addEventListener('DOMContentLoaded', () => {
      const open = window.mdvOpenDocument;
      window.mdvOpenDocument = (doc, opts) => {
        window.__opened.push({ path: doc.path, name: doc.name, push: !!(opts && opts.push), handle: !!doc.handle, text: typeof doc.text === 'string' });
        return open(doc, opts);
      };
    });
  }, { permission });
}

async function seed(page, files = FILES, folder = 'notes') {
  await page.evaluate(async ({ files, folder }) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true });
    for (const [rel, text] of Object.entries(files)) {
      const parts = rel.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await file.createWritable();
      await w.write(text);
      await w.close();
    }
  }, { files, folder });
}

async function openFolder(page) {
  await page.click('#mdvFolderBtn');
  await expect(page.locator('#mdvFolderTree [data-path]').first()).toBeVisible();
}

const listedPaths = (page) => page.locator('#mdvFolderTree [data-path]').evaluateAll((els) => els.map((e) => e.dataset.path));
// A heading's own words (its aria-label), without the fold toggle and the '#' permalink the viewer adds.
const heading = (page) => page.locator('#mdBody h1').first();
const expectTitle = (page, text) => expect(heading(page)).toHaveAttribute('aria-label', text);

async function start(page, options) {
  const problems = collectProblems(page);
  await browserSetup(page, options);
  await page.goto('markdown-viewer.html');
  await seed(page);
  return problems;
}

test.describe('in a browser', () => {
  test('the sidebar lists exactly the Markdown files, skipping .git, node_modules, dot-folders and anything over 8 folders deep', async ({ page }) => {
    const problems = await start(page);
    await expect(page.locator('#mdvFolderPanel')).toBeHidden();
    await openFolder(page);
    expect(await listedPaths(page)).toEqual(EXPECTED.listed);
    // The skipped files are there (the positive control): the walk saw them and left them out.
    const present = await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('notes');
      const has = async (...parts) => { let d = root; try { for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p); await d.getFileHandle(parts[parts.length - 1]); return true; } catch (e) { return false; } };
      return [await has('.git', 'notes.md'), await has('node_modules', 'some-package', 'README.md'), await has('.drafts', 'hidden.md'),
        await has('deep', '1', '2', '3', '4', '5', '6', '7', '8', 'too-deep.md'), await has('notes.txt')];
    });
    expect(present).toEqual([true, true, true, true, true]);
    await expect(page.locator('#mdvFolderName')).toHaveText('notes');
    await expect(page.locator('#mdvFolderStatus')).toHaveText('7 Markdown files');
    // The contract other streams use.
    const contract = await page.evaluate(() => ({ kind: mdvFolder.kind, rootName: mdvFolder.rootName, list: mdvFolder.list() }));
    expect(contract.kind).toBe('browser');
    expect(contract.rootName).toBe('notes');
    expect(contract.list.map((e) => e.path)).toEqual(EXPECTED.listed);
    expect(contract.list.find((e) => e.name === 'deepest-listed.md').depth).toBe(8);
    expect(problems).toEqual([]);
  });

  test('a click opens a file through mdvOpenDocument and marks it as the current one', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="status.md"]').click();
    await expectTitle(page, 'Status');
    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toEqual([{ path: 'status.md', name: 'status.md', push: true, handle: true, text: true }]);
    const current = page.locator('#mdvFolderTree .is-current');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('data-path', 'status.md');
    await expect(current).toHaveAttribute('aria-selected', 'true');
    await expect(current).toHaveAttribute('aria-current', 'page');
    // The contract's read and resolve, for stream L's relative links.
    const contract = await page.evaluate(async () => {
      const doc = await mdvFolder.read('handoffs/2026-10-08-ui.md');
      return {
        read: { name: doc.name, path: doc.path, hasHandle: !!doc.handle, mtime: typeof doc.mtimeMs, starts: doc.text.slice(0, 25) },
        resolve: [
          mdvFolder.resolve('handoffs/2026-10-01-api.md', '../proposals/search.md#design'),
          mdvFolder.resolve('handoffs/2026-10-01-api.md', './2026-10-08-ui.md'),
          mdvFolder.resolve('status.md', 'handoffs/2026-10-01-api.md?x=1'),
          mdvFolder.resolve('README.md', '/proposals/archive/old-idea.markdown'),
          mdvFolder.resolve('README.md', '../outside.md'),
          mdvFolder.resolve('README.md', 'notes.txt'),
          mdvFolder.resolve('README.md', 'https://example.com/a.md'),
          mdvFolder.resolve('README.md', '#status'),
        ],
        missing: await mdvFolder.read('nowhere.md').then(() => null, (e) => e.code),
      };
    });
    expect(contract.read).toEqual({ name: '2026-10-08-ui.md', path: 'handoffs/2026-10-08-ui.md', hasHandle: true, mtime: 'number', starts: '# Handoff: the reading UI' });
    expect(contract.resolve).toEqual(['proposals/search.md', 'handoffs/2026-10-08-ui.md', 'handoffs/2026-10-01-api.md',
      'proposals/archive/old-idea.markdown', null, null, null, null]);
    expect(contract.missing).toBe('not-found');
    expect(problems).toEqual([]);
  });

  test('the filter narrows the tree as you type, Enter opens the first match, Esc clears it', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await page.fill('#mdvFolderFilter', 'hand');
    await expect.poll(() => listedPaths(page)).toEqual(['handoffs/2026-10-01-api.md', 'handoffs/2026-10-08-ui.md']);
    await expect(page.locator('#mdvFolderStatus')).toHaveText('2 files match of 7');
    await expect(page.locator('#mdvFolderTree mark').first()).toHaveText('hand');
    await page.fill('#mdvFolderFilter', 'handoffs ui');
    await expect.poll(() => listedPaths(page)).toEqual(['handoffs/2026-10-08-ui.md']);
    await page.press('#mdvFolderFilter', 'Enter');
    await expectTitle(page, 'Handoff: the reading UI');
    await page.press('#mdvFolderFilter', 'Escape');
    await expect(page.locator('#mdvFolderFilter')).toHaveValue('');
    await expect.poll(() => listedPaths(page)).toEqual(EXPECTED.listed);
    expect(problems).toEqual([]);
  });

  test('the tree is an ARIA tree and works from the keyboard', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    const tree = page.locator('#mdvFolderTree');
    await expect(tree).toHaveAttribute('role', 'tree');
    const first = tree.locator('[role="treeitem"]').first();
    await expect(first).toHaveAttribute('aria-level', '1');
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
    const handoffs = tree.locator('[data-rel="handoffs"]');
    await expect(handoffs).toHaveAttribute('aria-setsize', '5');
    await expect(handoffs).toHaveAttribute('aria-posinset', '2');
    await handoffs.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(handoffs).toHaveAttribute('aria-expanded', 'false');
    await expect(tree.locator('[data-path^="handoffs/"]')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(handoffs).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tree.locator('[data-path="handoffs/2026-10-01-api.md"]')).toBeFocused();
    await expect(tree.locator('[data-path="handoffs/2026-10-01-api.md"]')).toHaveAttribute('aria-level', '2');
    await page.keyboard.press('ArrowDown');
    await expect(tree.locator('[data-path="handoffs/2026-10-08-ui.md"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(handoffs).toBeFocused();
    await page.keyboard.press('End');
    await expect(tree.locator('[data-path="status.md"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    await page.keyboard.type('re');
    await expect(tree.locator('[data-path="README.md"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expectTitle(page, 'Project notes');
    await expect(tree.locator('[data-path="README.md"]')).toHaveAttribute('aria-current', 'page');
    // One tab stop: the focused row.
    await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
    expect(problems).toEqual([]);
  });

  test('quick open (Ctrl/Cmd+P) finds a file by a fuzzy match and opens it', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="status.md"]').click();
    await expectTitle(page, 'Status');
    await page.keyboard.press('Control+p');
    const dialog = page.locator('#mdvQuickOpen');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#mdvQuickOpenInput')).toBeFocused();
    await page.keyboard.type('hnd ui');
    const rows = page.locator('#mdvQuickOpenList [role="option"]');
    await expect(rows.first().locator('.mdv-palette-name')).toHaveText('2026-10-08-ui.md');
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
    await expect(rows.first().locator('.search-match').first()).toBeVisible();
    // Letters out of order match nothing.
    await page.fill('#mdvQuickOpenInput', 'zzq');
    await expect(rows).toHaveCount(0);
    await expect(page.locator('#mdvQuickOpen .mdv-palette-status')).toHaveText('No file matches');
    await page.fill('#mdvQuickOpenInput', 'oldid');
    await expect(rows.first().locator('.mdv-palette-name')).toHaveText('old-idea.markdown');
    await page.fill('#mdvQuickOpenInput', 'hnd ui');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expectTitle(page, 'Handoff: the reading UI');
    // With nothing typed, the recent documents come first.
    await page.keyboard.press('Control+p');
    await expect(rows.first().locator('.mdv-palette-tag')).toHaveText('recent');
    await expect(rows.first().locator('.mdv-palette-name')).toHaveText('2026-10-08-ui.md');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('search in files (Ctrl/Cmd+Shift+F) finds a phrase across the folder, and a click opens the file at the match', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="README.md"]').click();
    await expectTitle(page, 'Project notes');
    await page.keyboard.press('Control+Shift+F');
    const dialog = page.locator('#mdvFolderSearch');
    await expect(dialog).toBeVisible();
    await page.keyboard.type('Token Bucket');
    const files = page.locator('#mdvFolderSearchList .mdv-xs-file');
    await expect(files).toHaveCount(1);
    await expect(files.first().locator('.mdv-xs-name')).toHaveText('2026-10-01-api.md');
    await expect(files.first().locator('.mdv-xs-count')).toHaveText('1');
    const hit = files.first().locator('.mdv-xs-hit').first();
    await expect(hit.locator('.search-match')).toHaveText('token bucket');
    await expect(hit.locator('.mdv-xs-line')).toHaveText('33');
    await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('1 match in 1 file');
    // A phrase in several files: one group per file, each with its count.
    await page.fill('#mdvFolderSearchInput', 'rate limiter');
    await expect(files).toHaveCount(2);
    await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('2 matches in 2 files');
    // A match at the end of a long line keeps the words before it (about 50 characters, from a word start).
    await page.fill('#mdvFolderSearchInput', 'on a server');
    await expect(files.first().locator('.mdv-xs-text')).toHaveText(/^…\S.* in the reader's browser rather than on a server\.$/);
    await page.fill('#mdvFolderSearchInput', 'token bucket');
    await expect(hit.locator('.search-match')).toHaveText('token bucket');
    await hit.click();
    await expect(dialog).toBeHidden();
    await expectTitle(page, 'Handoff: the API');
    const block = page.locator('#mdBody p', { hasText: 'token bucket per client' });
    await expect.poll(async () => {
      const box = await block.boundingBox();
      const viewport = page.viewportSize();
      return !!box && box.y >= 0 && box.y + box.height <= viewport.height;
    }, { timeout: 5000 }).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    expect(await page.evaluate(() => CSS.highlights.has('mdv-folder-match'))).toBe(true);
    // Enter straight after typing searches, then goes: here within the document already open.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.keyboard.press('Control+Shift+F');
    await page.fill('#mdvFolderSearchInput', 'owns the dashboards');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    const last = page.locator('#mdBody p', { hasText: 'Who owns the dashboards' });
    await expect.poll(async () => {
      const box = await last.boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= page.viewportSize().height;
    }, { timeout: 5000 }).toBe(true);
    expect(await page.evaluate(() => window.__opened.length)).toBe(2);
    expect(problems).toEqual([]);
  });

  test('Ctrl/Cmd+Shift+F still folds every section while the folder is not shown', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="status.md"]').click();
    await expectTitle(page, 'Status');
    await page.click('#mdvFolderBtn');
    await expect(page.locator('#mdvFolderPanel')).toBeHidden();
    await page.locator('#mdBody').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Shift+F');
    await expect(page.locator('#mdvFolderSearch')).toHaveCount(0);
    await expect(page.locator('#mdBody .section-content.collapsed').first()).toBeAttached();
    expect(problems).toEqual([]);
  });

  test('recent documents survive a reload, open again from the welcome screen and the menu, and can be cleared', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="status.md"]').click();
    await expectTitle(page, 'Status');
    await page.locator('#mdvFolderTree [data-path="handoffs/2026-10-08-ui.md"]').click();
    await expectTitle(page, 'Handoff: the reading UI');
    await page.locator('#mdvFolderTree [data-path="status.md"]').click();
    await expectTitle(page, 'Status');
    // What is stored (IndexedDB), not only what the page holds: the reload reads it back.
    const stored = () => page.evaluate(() => mdvGetHandle('mdv-recents').then((l) => (l || []).map((r) => r.path)));
    await expect.poll(stored).toEqual(['status.md', 'handoffs/2026-10-08-ui.md']);
    await page.reload();
    const welcome = page.locator('#mdvWelcomeRecents');
    await expect(welcome.locator('.mdv-recent-name')).toHaveText(['status.md', '2026-10-08-ui.md']);
    await expect(welcome.locator('.mdv-recent-where').first()).toHaveText('notes');
    await expect(welcome.locator('.mdv-recent-where').nth(1)).toHaveText('notes/handoffs');
    await welcome.locator('.mdv-recent-item').nth(1).click();
    await expectTitle(page, 'Handoff: the reading UI');
    // The toolbar menu, from the keyboard: the newest first, then Clear.
    await page.click('#mdvRecentBtn');
    const menu = page.locator('#mdvRecentMenu');
    await expect(menu).toBeVisible();
    await expect(page.locator('#mdvRecentBtn')).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
    await expect(menu.locator('.mdv-recent-name')).toHaveText(['2026-10-08-ui.md', 'status.md']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expectTitle(page, 'Status');
    await expect(menu).toBeHidden();
    await page.click('#mdvRecentBtn');
    await menu.locator('.mdv-recent-clear').click();
    await expect.poll(stored).toEqual([]);
    await page.reload();
    await expect(page.locator('#mdvWelcomeRecents .mdv-recent-item')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('the folder is remembered: after a reload it is listed again without a picker', async ({ page }) => {
    const problems = await start(page);
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="status.md"]').click();
    await expectTitle(page, 'Status');
    expect(await page.evaluate(() => window.__pickerCalls)).toBe(1);
    await page.reload();
    await expect(page.locator('#mdvFolderPanel')).toBeVisible();
    await expect.poll(() => listedPaths(page)).toEqual(EXPECTED.listed);
    expect(await page.evaluate(() => window.__pickerCalls)).toBe(0);
    expect(problems).toEqual([]);
  });

  test('a remembered folder the browser needs permission for again waits for a click to reconnect', async ({ page }) => {
    const problems = await start(page, { permission: 'prompt' });
    // Remember the folder (as an earlier visit would have), then load the page again.
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('notes');
      await mdvPutHandle('folder', dir);
      localStorage.setItem('mdv-folder-panel', 'open');
    });
    await page.reload();
    const reconnect = page.locator('#mdvFolderEmpty [data-action="folder-reconnect"]');
    await expect(reconnect).toBeVisible();
    await expect(page.locator('#mdvFolderEmpty')).toContainText('Reconnect to “notes”');
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(0);
    await expect(page.locator('#mdvFolderTree [data-path]')).toHaveCount(0);
    await reconnect.click();
    await expect.poll(() => listedPaths(page)).toEqual(EXPECTED.listed);
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(1);
    expect(await page.evaluate(() => window.__pickerCalls)).toBe(0);
    expect(problems).toEqual([]);
  });

  test('hovering a link to another document in the folder previews its title and first paragraph, sanitized', async ({ page }) => {
    const problems = await start(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, '__mdvPwned', { configurable: true, set(v) { (window.__hits = window.__hits || []).push(String(v)); }, get() { return undefined; } });
    });
    await page.reload();
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="README.md"]').click();
    await expectTitle(page, 'Project notes');
    const failed = [];
    page.on('requestfailed', (r) => failed.push(r.url()));
    page.on('response', (r) => { if (r.status() >= 400) failed.push(r.url()); });
    await page.locator('#mdBody a', { hasText: 'Proposal: search across documents' }).hover();
    const card = page.locator('#mdvLinkPreview');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('role', 'tooltip');
    await expect(card).toHaveAttribute('data-mdv-document', '');
    await expect(card.locator('.mdv-preview-where')).toHaveText('proposals/search.md');
    await expect(card.locator('.mdv-preview-title')).toHaveText('Proposal: search across documents');
    await expect(card.locator('.mdv-preview-body')).toContainText('Readers keep dozens of agent reports open and need to find a phrase in all of them');
    await expect(card.locator('.mdv-preview-body strong')).toHaveText('dozens');
    await expect(card.locator('.mdv-preview-body')).toContainText('[a diagram]');
    expect(await card.locator('img, script, a, [onerror]').count()).toBe(0);
    await expect(page.locator('#mdBody a', { hasText: 'Proposal: search across documents' })).toHaveAttribute('aria-describedby', 'mdvLinkPreview');
    // The heading-less status document is titled from its frontmatter.
    await page.mouse.move(5, 5);
    await expect(card).toBeHidden();
    await page.locator('#mdBody a', { hasText: 'Weekly status' }).hover();
    await expect(card.locator('.mdv-preview-title')).toHaveText('Weekly status, 8 October');
    await expect(card.locator('.mdv-preview-body')).toContainText('The rate limiter shipped on Monday');
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    // A link to a file that is not Markdown gets no preview.
    await page.locator('#mdBody a', { hasText: 'A note that is not Markdown' }).hover();
    await page.waitForTimeout(700);
    await expect(card).toBeHidden();
    expect(await page.evaluate(() => window.__hits || [])).toEqual([]);
    expect(failed.filter((u) => /preview-probe|diagram\.png/.test(u))).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('names from the file system are shown as text', async ({ page }) => {
    const problems = await start(page);
    await seed(page, { '<img src=x onerror="window.__mdvPwned=1">.md': '# Hostile name\n' });
    await page.addInitScript(() => {
      Object.defineProperty(window, '__mdvPwned', { configurable: true, set(v) { (window.__hits = window.__hits || []).push(String(v)); }, get() { return undefined; } });
    });
    await page.reload();
    await openFolder(page);
    const row = page.locator('#mdvFolderTree [data-path^="<img"]');
    await expect(row.locator('.mdv-tree-label')).toHaveText('<img src=x onerror="window.__mdvPwned=1">');
    expect(await page.locator('#mdvFolderPanel img').count()).toBe(0);
    await page.keyboard.press('Control+p');
    await page.keyboard.type('img');
    await expect(page.locator('#mdvQuickOpenList .mdv-palette-name').first()).toContainText('<img src=x');
    expect(await page.locator('#mdvQuickOpen img').count()).toBe(0);
    expect(await page.evaluate(() => window.__hits || [])).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('a folder with more than 5,000 Markdown files is listed up to 5,000, and says so', async ({ page }) => {
    test.setTimeout(120_000);
    const problems = await start(page);
    await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('big', { create: true });
      const writes = [];
      for (let i = 0; i < 5010; i++) writes.push(root.getFileHandle(`note-${String(i).padStart(4, '0')}.md`, { create: true }));
      await Promise.all(writes);
      window.showDirectoryPicker = async () => root;
    });
    await page.click('#mdvFolderBtn');
    await expect(page.locator('#mdvFolderStatus')).toContainText('5,000 Markdown files', { timeout: 60_000 });
    await expect(page.locator('#mdvFolderStatus')).toContainText('the listing stopped at 5,000 files');
    expect(await page.evaluate(() => mdvFolder.list().length)).toBe(5000);
    // A large folder is drawn collapsed only when it has folders; this one is flat: every row is there.
    await page.fill('#mdvFolderFilter', 'note-499');
    await expect.poll(() => listedPaths(page)).toEqual(Array.from({ length: 10 }, (_, i) => `note-499${i}.md`));
    expect(problems).toEqual([]);
  });
});

// ------- The desktop app: a stand-in shell -------
const ROOT = '/work/notes';
const abs = (rel) => `${ROOT}/${rel}`;
const desktopDoc = (rel) => ({ path: abs(rel), name: rel.split('/').pop(), text: FILES[rel], mtimeMs: 1000, version: `v-${rel}`, readOnly: null, reason: 'initial' });
const LISTING = {
  root: ROOT, name: 'notes', truncated: false, unreadable: 0,
  entries: EXPECTED.listed.map((rel) => ({ path: abs(rel), rel, name: rel.split('/').pop(), depth: rel.split('/').length - 1, size: FILES[rel].length, mtimeMs: 1000 })),
};

async function desktopSetup(page, { doc = desktopDoc('README.md'), storage = {} } = {}) {
  await page.route('**/markdown-viewer.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: Object.assign({}, response.headers(), { 'content-security-policy': APP_CSP }) });
  });
  const disk = {};
  for (const rel of Object.keys(FILES)) disk[abs(rel)] = desktopDoc(rel);
  await page.addInitScript(({ doc, disk, listing, storage }) => {
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    const calls = [];
    window.__shell = { calls };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path,
        async invoke(cmd, args) {
          calls.push({ cmd, args: args || {} });
          switch (cmd) {
            case 'mdv_initial_document': return doc;
            case 'mdv_read_document':
              if (disk[args.path]) return Object.assign({}, disk[args.path], { reason: 'reload' });
              return Promise.reject({ code: 'not-found', message: `${args.path} does not exist.` });
            case 'mdv_list_directory':
              if (args.root === listing.root) return listing;
              return Promise.reject({ code: 'not-found', message: `${args.root} does not exist.` });
            case 'mdv_choose_folder': return listing.root;
            case 'mdv_open_path': return null;
            case 'mdv_self_test_requested': return false;
            default: return null;
          }
        },
      },
      event: { async listen() { return () => {}; } },
    };
    window.__opened = [];
    window.mdvOpenDocument = async (doc) => { rawMarkdown = doc.text; currentFileName = doc.name; renderMarkdown(doc.text, doc.name); };
    document.addEventListener('DOMContentLoaded', () => {
      const open = window.mdvOpenDocument;
      window.mdvOpenDocument = (d, opts) => { window.__opened.push({ path: d.path, push: !!(opts && opts.push), handle: d.handle }); return open(d, opts); };
    });
  }, { doc, disk, listing: LISTING, storage });
}

const shellCalls = (page, cmd) => page.evaluate((c) => window.__shell.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

test.describe('in the desktop app', () => {
  test('the folder is the document\'s own folder, listed by mdv_list_directory; a click reads the file through the bridge', async ({ page }) => {
    const problems = collectProblems(page);
    await desktopSetup(page);
    await page.goto('markdown-viewer.html');
    await expectTitle(page, 'Project notes');
    await openFolder(page);
    expect(await shellCalls(page, 'mdv_list_directory')).toEqual([{ root: ROOT }]);
    expect(await shellCalls(page, 'mdv_choose_folder')).toEqual([]);
    expect(await listedPaths(page)).toEqual(EXPECTED.listed.map(abs));
    await expect(page.locator('#mdvFolderTree .is-current')).toHaveAttribute('data-path', abs('README.md'));
    await expect(page.locator('#mdvFolderName')).toHaveAttribute('title', ROOT);
    await page.locator(`#mdvFolderTree [data-path="${abs('status.md')}"]`).click();
    await expectTitle(page, 'Status');
    expect(await shellCalls(page, 'mdv_read_document')).toContainEqual({ path: abs('status.md') });
    expect(await page.evaluate(() => window.__opened)).toEqual([{ path: abs('status.md'), push: true, handle: null }]);
    await expect(page.locator('#mdvFolderTree .is-current')).toHaveAttribute('data-path', abs('status.md'));
    // Cmd/Ctrl-click: its own window, as a link does; nothing changes here.
    await page.locator(`#mdvFolderTree [data-path="${abs('handoffs/2026-10-08-ui.md')}"]`).click({ modifiers: ['ControlOrMeta'] });
    await expect.poll(() => shellCalls(page, 'mdv_open_path')).toEqual([{ path: abs('handoffs/2026-10-08-ui.md') }]);
    await expectTitle(page, 'Status');
    // "Open another folder…" is the native folder panel.
    await page.locator('#mdvFolderPanel [data-action="folder-choose"]').click();
    await expect.poll(() => shellCalls(page, 'mdv_choose_folder')).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  test('a link to another document previews it, read through the bridge', async ({ page }) => {
    const problems = collectProblems(page);
    await desktopSetup(page);
    await page.goto('markdown-viewer.html');
    await expectTitle(page, 'Project notes');
    // No folder open: the desktop app still previews a link to a Markdown file next to the document.
    await page.locator('#mdBody a', { hasText: 'Handoff: the API' }).hover();
    const card = page.locator('#mdvLinkPreview');
    await expect(card.locator('.mdv-preview-title')).toHaveText('Handoff: the API');
    await expect(card.locator('.mdv-preview-where')).toHaveText('handoffs/2026-10-01-api.md');
    await expect(card.locator('.mdv-preview-body')).toContainText('The API work is finished except for the load tests.');
    expect(await shellCalls(page, 'mdv_read_document')).toContainEqual({ path: abs('handoffs/2026-10-01-api.md') });
    expect(problems).toEqual([]);
  });

  test('the sidebar and its folder come back in a new window, and recent documents by path', async ({ page }) => {
    const problems = collectProblems(page);
    const recents = JSON.stringify([{ kind: 'path', name: 'status.md', path: abs('status.md'), folder: ROOT, at: Date.now() - 60_000 }]);
    await desktopSetup(page, { doc: null, storage: { 'mdv-folder-panel': 'open', 'mdv-folder': ROOT, 'mdv-recents': recents } });
    await page.goto('markdown-viewer.html');
    // The welcome window: the remembered folder, and the recent documents.
    await expect.poll(() => listedPaths(page)).toEqual(EXPECTED.listed.map(abs));
    expect(await shellCalls(page, 'mdv_list_directory')).toEqual([{ root: ROOT }]);
    const welcome = page.locator('#mdvWelcomeRecents');
    await expect(welcome.locator('.mdv-recent-name')).toHaveText(['status.md']);
    await expect(welcome.locator('.mdv-recent-when')).toHaveText('1 min ago');
    // An empty window asks the shell to open the path: it then becomes this window's document.
    await welcome.locator('.mdv-recent-item').click();
    await expect.poll(() => shellCalls(page, 'mdv_open_path')).toEqual([{ path: abs('status.md') }]);
    expect(problems).toEqual([]);
  });
});

// ------- How it looks: every theme, LOOKED AT (test-results/folder-*.png) -------
// Dialogs, menus and the card fade in; a screenshot waits until nothing on the page is animating.
async function settled(page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  await page.waitForTimeout(60);
}

for (const theme of ['light', 'dark', 'sepia']) {
  test(`the sidebar, quick open, search in files, the preview and the welcome list in the ${theme} theme`, async ({ page }) => {
    const problems = await start(page);
    await page.evaluate((t) => localStorage.setItem('mdv-theme', t), theme);
    await page.reload();
    await openFolder(page);
    await page.locator('#mdvFolderTree [data-path="handoffs/2026-10-01-api.md"]').click();
    await expectTitle(page, 'Handoff: the API');
    await page.locator('#mdvFolderTree [data-path="README.md"]').click();
    await expectTitle(page, 'Project notes');
    await page.evaluate(() => document.fonts.ready);
    // The sidebar takes its own column: the outline and the document move over, nothing overlaps.
    const boxes = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { panel: r('#mdvFolderPanel'), toc: r('#tocSidebar'), body: r('#mdBody'), overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(boxes.toc.left).toBeGreaterThanOrEqual(boxes.panel.right - 1);
    expect(boxes.body.left).toBeGreaterThanOrEqual(boxes.toc.right);
    expect(boxes.overflow).toBeLessThanOrEqual(0);
    await page.locator('#mdBody a', { hasText: 'Handoff: the API' }).hover();
    await expect(page.locator('#mdvLinkPreview .mdv-preview-title')).toHaveText('Handoff: the API');
    await expect(page.locator('#linkTooltip')).not.toHaveClass(/visible/);
    await settled(page);
    await page.screenshot({ path: `test-results/folder-${theme}-sidebar-preview.png` });
    await page.mouse.move(700, 880);
    await page.keyboard.press('Control+p');
    await page.keyboard.type('hnd');
    await expect(page.locator('#mdvLinkPreview')).toBeHidden();
    await expect(page.locator('#mdvQuickOpenList [role="option"]')).toHaveCount(2);
    await settled(page);
    await page.screenshot({ path: `test-results/folder-${theme}-quick-open.png` });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+F');
    await page.keyboard.type('rate limiter');
    await expect(page.locator('#mdvFolderSearchStatus')).toHaveText('2 matches in 2 files');
    await settled(page);
    await page.screenshot({ path: `test-results/folder-${theme}-search.png` });
    await page.keyboard.press('Escape');
    await page.goto('markdown-viewer.html');
    await expect(page.locator('#mdvWelcomeRecents .mdv-recent-item')).toHaveCount(2);
    await page.click('#mdvRecentBtn');
    await settled(page);
    await page.screenshot({ path: `test-results/folder-${theme}-welcome-recents.png` });
    expect(problems).toEqual([]);
  });
}
