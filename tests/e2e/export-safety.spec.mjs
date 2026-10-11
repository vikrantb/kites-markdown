// What a document must not be able to do through the Export menu's features: take one of the viewer's own elements
// (and from there press the viewer's buttons), put a file that is not an image into an exported page, or reach the
// viewer's actions from the off-screen drawing a paste uses. A document is untrusted input (CLAUDE.md).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { renderSource } from './visuals-helpers.mjs';
import { exportHtml, inspect, menu, openDoc, repo, toast } from './export-helpers.mjs';

const focusMode = (page) => page.evaluate(() => document.body.classList.contains('focus-mode'));

test('a document cannot take the print header\'s id: its element stays in the document, its labels press nothing, and the next document is untouched', async ({ page }) => {
  // The first document of the page: the print header must already be the viewer's when it is sanitized.
  await openDoc(page, 'tests/fixtures/export/print-header-id.md');
  const where = await page.evaluate(() => {
    const outside = [...document.querySelectorAll('body *')].filter((el) => !el.closest('#mdBody') && /Session expired/.test(el.textContent || '') && !el.querySelector('*'));
    return {
      inDocument: !!document.querySelector('#mdBody') && /Session expired/.test(document.getElementById('mdBody').textContent),
      outside: outside.length,
      headers: document.querySelectorAll('.mdv-print-header').length,
      byId: document.getElementById('mdvPrintHeader').className,
    };
  });
  expect(where).toEqual({ inDocument: true, outside: 0, headers: 1, byId: 'mdv-print-header' });

  // The instrument: the viewer's own focus button turns focus mode on and off.
  await page.locator('#focusBtn').click();
  expect(await focusMode(page)).toBe(true);
  await page.locator('#focusBtn').click();
  expect(await focusMode(page)).toBe(false);
  // A diagram label naming the same action, in the element that named itself the print header: nothing happens.
  await page.locator('.rv-press').click();
  expect(await focusMode(page)).toBe(false);

  // The next document: no trace of the first one around it, its ids its own, and the print header is the viewer's.
  await renderSource(page, '# Second document\n\n## Intro\n\nHello from the second document.\n', 'second.md');
  const next = await page.evaluate(() => ({
    leftover: /Session expired/.test(document.body.textContent),
    intro: !!document.querySelector('#mdBody h2#intro'),
    headers: document.querySelectorAll('.mdv-print-header').length,
    title: document.querySelector('.mdv-print-header .mdv-print-title').textContent,
  }));
  expect(next).toEqual({ leftover: false, intro: true, headers: 1, title: 'Second document' });
});

test('a document cannot take the ids of elements the viewer makes later: the search status, the comment notices, the diagram view\'s 1:1 button', async ({ page }) => {
  // The same kind of hole as the print header's: the first document is sanitized before these exist.
  await openDoc(page, 'tests/fixtures/export/later-ids.md');
  expect(await page.evaluate(() => ['mdvSearchStatus', 'mdvNotices', 'diagramActualBtn']
    .filter((id) => document.querySelector(`#mdBody [id="${id}"]`)))).toEqual([]);
  // Search writes its status into its own footer, not into the document.
  await page.keyboard.press('Control+k');
  await page.locator('#searchInput').fill('release');
  await expect(page.locator('#searchOverlay .search-footer [role="status"]')).toHaveText(/match/);
  await expect(page.locator('#mdBody span', { hasText: 'own status line' })).toHaveText(/^The document.s own status line$/);
  await expect(page.locator('#mdBody')).not.toContainText('match');
  await page.keyboard.press('Escape');
  // The expanded diagram gets its 1:1 button.
  await page.locator('#mdBody .mermaid-wrapper').first().click();
  await expect(page.locator('#diagramOverlay #diagramActualBtn')).toBeVisible();
});

test('Export HTML embeds only images: a file named with an image extension in its fragment or query, or whose bytes are not an image, stays out', async ({ page }) => {
  await openDoc(page, 'tests/fixtures/export/not-images.md');
  const { html } = await exportHtml(page);
  const x = await inspect(page, html);
  const png = readFileSync(repo('tests/fixtures/export/chart.png')).toString('base64');
  // Positive control: the real image next to the document is embedded.
  expect(x.images).toEqual([`data:image/png;base64,${png}`]);
  expect(x.notes).toHaveLength(5);
  for (const file of ['not-an-image.txt', 'not-really-a.png']) {
    const bytes = readFileSync(repo(`tests/fixtures/export/${file}`));
    expect(html).not.toContain(bytes.toString('base64').slice(0, 24));
    expect(html).not.toContain(bytes.toString('utf8').slice(0, 24));
  }
  expect(html).not.toMatch(/data:text\//);
  await expect(toast(page)).toContainText('5 images could not be read');
});

test('Export HTML embeds only images read through the open folder too (window.mdvFolder, stubbed)', async ({ page }) => {
  const png = readFileSync(repo('tests/fixtures/export/chart.png')).toString('base64');
  await page.addInitScript((b64) => {
    const files = {
      'folder-only.png': () => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'folder-only.png', { type: 'image/png' }),
      'secret.txt': () => new File(['PRIVATE-MARKER-FOLDER-TEXT'], 'secret.txt', { type: 'text/plain' }),
      'disguised.png': () => new File(['PRIVATE-MARKER-FOLDER-PNG'], 'disguised.png', { type: 'image/png' }),
    };
    window.mdvFolder = {
      kind: 'browser',
      rootName: 'notes',
      list: () => [],
      resolve: (from, href) => from.replace(/[^/]*$/, '') + href,
      async read(path) {
        const make = files[path.split('/').pop()];
        return make ? { name: path.split('/').pop(), path, text: '', mtimeMs: 1, handle: { getFile: async () => make() } } : null;
      },
    };
  }, png);
  await openDoc(page, 'tests/fixtures/export/folder-mixed.md');
  const { html } = await exportHtml(page);
  const x = await inspect(page, html);
  expect(x.images).toEqual([`data:image/png;base64,${png}`]); // positive control: the folder's real image
  expect(x.notes).toHaveLength(2);
  expect(html).not.toContain('PRIVATE-MARKER-FOLDER');
  expect(html).not.toContain(Buffer.from('PRIVATE-MARKER-FOLDER').toString('base64').slice(0, 20));
});

test('the light drawing of diagrams for a paste holds document markup, so a label there cannot press the viewer\'s buttons', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, 'tests/fixtures/export/sections.md', 'dark');
  await renderSource(page, '# Labels\n\n```mermaid\nflowchart LR\n  A["<span class=\'stage-press\' data-action=\'toggle-focus\'>Press here</span>"] --> B[Next]\n```\n\n' +
    '```mermaid\nflowchart LR\n  C[Second] --> D[Diagram]\n```\n', 'labels.md');
  // While the copy draws the diagrams again off screen, click every label that names an action outside the
  // document and the toolbar: as a pointer or a script could reach them there.
  await page.evaluate(() => {
    window.__stageClicks = 0;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-action="toggle-focus"]')) {
        if (el.closest('#mdBody') || el.closest('.toolbar')) continue;
        window.__stageClicks++;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toContainText('Copied the document as rich text');
  expect(await page.evaluate(() => window.__stageClicks)).toBeGreaterThan(0); // the instrument reached the stage
  expect(await focusMode(page)).toBe(false);
});
