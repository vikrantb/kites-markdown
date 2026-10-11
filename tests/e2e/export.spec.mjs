// Export and copy (js/export.js, js/copy.js, css/print.css): Export HTML, Print / Save as PDF, Copy as rich text
// and Copy link to this section, from the toolbar's Export menu and from each heading's "#".
//
// In a browser, and in the desktop app through a stand-in for its shell (as desktop.spec.mjs does it: Tauri's
// injected API, the app's own Content Security Policy). The real shell's part (where a download is saved, the print
// sheet) is the app's own; see docs/features.md. What a document must not be able to do through these features is in
// export-safety.spec.mjs; where links and section addresses lead, in export-links.spec.mjs.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { collectProblems, waitForLayoutSettled } from './support/viewer.mjs';
import { THEMES, renderSource, waitForDiagrams } from './visuals-helpers.mjs';
import {
  FIXTURE, FIXTURE_DIR, IMAGES, SECTIONS, exportHtml, inspect, menu, openDoc, openInApp, readClipboard, repo, toast,
} from './export-helpers.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Export HTML
// ---------------------------------------------------------------------------------------------------------------

test('Export HTML is one self-contained file: no script, every diagram as its SVG, the styles and math fonts inside', async ({ page, context, baseURL }, info) => {
  const problems = collectProblems(page);
  await openDoc(page, 'samples/kitchen-sink.md');
  const onPage = await page.evaluate(() => ({
    diagrams: document.querySelectorAll('#mdBody .mermaid > svg').length,
    math: document.querySelectorAll('#mdBody .katex').length,
    title: mdvHeadingText(document.querySelector('#mdBody h1')),
  }));
  expect(onPage.diagrams).toBeGreaterThan(0); // the sample draws four: the count below is not a vacuous 0 == 0
  expect(onPage.math).toBeGreaterThan(0);
  // As if something had slipped past the sanitizer: the export drops it anyway (so the zero counts below can fail).
  await page.evaluate(() => {
    const p = document.querySelector('#mdBody p');
    const s = document.createElement('script');
    s.type = 'text/x-probe'; // a script element that does not run here (the page's CSP would report one that did)
    s.textContent = 'window.__mdvExportProbe = 1;';
    p.appendChild(s);
    p.setAttribute('onclick', 'window.__mdvExportProbe = 2');
    const a = document.createElement('a');
    a.href = 'javascript:void 0';
    a.textContent = 'probe';
    p.appendChild(a);
  });

  const { name, html, download } = await exportHtml(page);
  expect(name).toBe('kitchen-sink.html');
  // The sample links to the project README next to its folder: that link now opens it in this viewer, on this computer.
  await expect(toast(page)).toHaveText('Downloading kitchen-sink.html: 1 link goes to a file on this computer.');
  const x = await inspect(page, html);
  expect(x.scripts).toBe(0);
  expect(html).not.toMatch(/<script/i);
  expect(x.handlers).toEqual([]);
  expect(x.jsUrls).toEqual([]);
  expect(x.actions).toBe(0);
  expect(x.controls).toBe(0);
  expect(x.diagrams).toBe(onPage.diagrams);
  expect(x.title).toBe(onPage.title);
  expect(x.theme).toBe('light');
  expect(x.csp).toContain("default-src 'none'");
  expect(x.stylesheetLinks).toBe(0);
  expect(x.style).toContain('.md-body');
  expect(x.style).toMatch(/@font-face \{ font-family: KaTeX_Main; src: url\("data:font\/woff2;base64,/);
  // No comment thread, anchor or narration, and nothing the page loads from the server it came from: no image, font or
  // stylesheet address. (A link is not a load: the README link above is one, by design.)
  expect(html).not.toContain('<!--');
  const origin = new URL(baseURL).origin;
  expect(x.style).not.toContain(origin);
  expect(x.images.filter((src) => src.startsWith(origin))).toEqual([]);
  expect(x.links.find((l) => l.text === 'project README').href).toBe(`${origin}/markdown-viewer.html?file=README.md`);

  // Opened on its own, it renders with nothing but itself: no request leaves the file.
  const saved = info.outputPath('kitchen-sink.html');
  await download.saveAs(saved);
  const view = await context.newPage();
  const requests = [];
  view.on('request', (r) => { if (!/^(file|data):/.test(r.url())) requests.push(r.url()); });
  await view.goto('file://' + saved);
  await expect(view.locator('h1')).toHaveAttribute('aria-label', onPage.title);
  await expect(view.locator('.mermaid > svg').first()).toBeVisible();
  const fonts = await view.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
  });
  expect(fonts).toContain('KaTeX_Main');
  expect(requests).toEqual([]);
  await view.screenshot({ path: info.outputPath('exported-light.png') });
  expect(problems, problems.join('\n')).toEqual([]);
});

test('Export HTML keeps the theme on screen and leaves out comment threads', async ({ page }) => {
  await openDoc(page, 'samples/commented.md', 'dark');
  const threads = await page.evaluate(() => mdvComments.length);
  expect(threads).toBeGreaterThan(0);
  const { html } = await exportHtml(page);
  const x = await inspect(page, html);
  expect(x.theme).toBe('dark');
  expect(html).not.toMatch(/MDV-COMMENTS|MDV-ANCHOR|<!--/);
  const bodies = await page.evaluate(() => mdvComments.map((c) => c.body_md).filter((b) => b && b.length > 12));
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) expect(html).not.toContain(b.slice(0, 40));
});

test('Export HTML embeds local images, keeps a web image\'s address, and notes one it cannot read', async ({ page }) => {
  await openDoc(page, IMAGES);
  // On the page, an image named relative to the document does not load (the page resolves it against the viewer);
  // the export reads it next to the document.
  const loaded = await page.evaluate(() => [...document.querySelectorAll('#mdBody img')].map((i) => i.complete && i.naturalWidth > 0));
  expect(loaded).toEqual([false, true, false, false]);
  const { html } = await exportHtml(page);
  const x = await inspect(page, html);
  const png = readFileSync(repo('tests/fixtures/export/chart.png')).toString('base64');
  expect(x.images).toEqual([`data:image/png;base64,${png}`, `data:image/png;base64,${png}`, 'https://example.invalid/picture.png']);
  expect(x.notes).toHaveLength(1);
  expect(x.notes[0]).toContain('no-such-image.png');
  await expect(toast(page)).toContainText('1 image could not be read');
});

test('Export HTML reads an image through the open folder (window.mdvFolder, stubbed until the folder stream merges)', async ({ page }) => {
  // window.mdvFolder is the folder stream's contract (wave2-streams.md): resolve(fromPath, href) and read(path) with a
  // file handle. This stand-in serves one image the server does not have.
  const png = readFileSync(repo('tests/fixtures/export/chart.png')).toString('base64');
  await page.addInitScript((b64) => {
    window.__folderCalls = [];
    window.mdvFolder = {
      kind: 'browser',
      rootName: 'notes',
      list: () => [],
      resolve(from, href) { window.__folderCalls.push(['resolve', from, href]); return from.replace(/[^/]*$/, '') + href; },
      async read(path) {
        window.__folderCalls.push(['read', path]);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return { name: path.split('/').pop(), path, text: '', mtimeMs: 1, handle: { getFile: async () => new File([bytes], 'folder-only.png', { type: 'image/png' }) } };
      },
    };
  }, png);
  await openDoc(page, 'tests/fixtures/export/folder.md');
  const { html } = await exportHtml(page);
  const x = await inspect(page, html);
  expect(x.images).toEqual([`data:image/png;base64,${png}`]);
  expect(x.notes).toEqual([]);
  expect(await page.evaluate(() => window.__folderCalls)).toEqual([
    ['resolve', 'tests/fixtures/export/folder.md', 'folder-only.png'],
    ['read', 'tests/fixtures/export/folder-only.png'],
  ]);
});

test('Export HTML keeps the ticks the reader made in task lists', async ({ page }) => {
  await openDoc(page, 'samples/kitchen-sink.md');
  const boxes = page.locator('#mdBody input[type="checkbox"]');
  const before = await boxes.evaluateAll((all) => all.map((b) => b.checked));
  const i = before.indexOf(false);
  expect(i).toBeGreaterThanOrEqual(0); // a box to tick
  await boxes.nth(i).click();
  const ticked = await boxes.evaluateAll((all) => all.map((b) => b.checked));
  expect(ticked[i]).toBe(true);
  const { html } = await exportHtml(page);
  const exported = await page.evaluate((h) => [...new DOMParser().parseFromString(h, 'text/html').querySelectorAll('input[type="checkbox"]')]
    .map((b) => b.checked), html);
  expect(exported).toEqual(ticked);
});

test('Export HTML names the document it copied, even when another opens while its images are read', async ({ page }) => {
  await openDoc(page, IMAGES);
  // The export reads chart.png next to the document: hold that read, and open another document meanwhile, as a
  // loader does (its name, then its text).
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/tests/fixtures/export/chart.png', async (route) => { await held; await route.continue(); });
  const downloading = page.waitForEvent('download');
  await menu(page, 'export-html');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const s = '# Other document\n\nSomething else entirely.\n';
    currentFileName = 'other.md';
    rawMarkdown = s;
    renderMarkdown(s, 'other.md');
  });
  await expect(page.locator('#mdBody h1')).toContainText('Other document');
  release();
  const download = await downloading;
  const html = readFileSync(await download.path(), 'utf8');
  expect(download.suggestedFilename()).toBe('images.html');
  const x = await inspect(page, html);
  expect(x.title).toBe('Images in an export');
  expect(html).not.toContain('Something else entirely');
});

test('Export HTML of pasted text is named after its title, not the file shown before it', async ({ page }) => {
  await openDoc(page, SECTIONS);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '# Pasted plan\n\nA paragraph that was pasted into the viewer.\n');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect(page.locator('#mdBody h1')).toContainText('Pasted plan');
  const { name } = await exportHtml(page);
  expect(name).toBe('Pasted plan.html');
});

test('Export HTML from a page opened as a file (file://) carries portable styles, and draws callouts, the frontmatter card and heading links as the page does', async ({ page, context }, info) => {
  const problems = collectProblems(page);
  await page.goto(new URL('../../markdown-viewer.html', import.meta.url).href);
  await page.locator('#fileInput').setInputFiles(repo('samples/kitchen-sink.md'));
  await page.waitForSelector('#mdBody h1');
  await waitForDiagrams(page);
  // The instrument: here the page really cannot read its own stylesheet, and it draws callout icons at 18 px.
  expect(await page.evaluate(() => { try { return document.querySelector('link[href="css/viewer.css"]').sheet.cssRules.length; } catch (e) { return e.name; } })).toBe('SecurityError');
  expect(await page.evaluate(() => document.querySelectorAll('#mdBody .callout-title svg').length)).toBeGreaterThan(0);
  const diagrams = await page.evaluate(() => document.querySelectorAll('#mdBody .mermaid > svg').length);
  const { html, download } = await exportHtml(page);
  const x = await inspect(page, html);
  expect(x.scripts).toBe(0);
  expect(x.handlers).toEqual([]);
  expect(x.diagrams).toBe(diagrams);
  expect(html).toContain('class="mdv-export mdv-export-portable"');
  expect(x.style).toContain('.katex .katex-html { display: none; }'); // math as MathML: KaTeX's stylesheet is unreadable too
  const code = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    return d.querySelector('pre:not(.mermaid)').getAttribute('style') || '';
  }, html);
  expect(code).toMatch(/font-family:[^;]*monospace/);
  await expect(toast(page)).toContainText('styled simply');

  // Opened: no callout icon blown up to the column's width (the page draws them at 18 px), the document's own drawing
  // at its own size, the frontmatter card's status and date apart, and each heading's "#" hidden until the pointer is
  // on its heading, as on the page.
  const saved = info.outputPath('portable.html');
  await download.saveAs(saved);
  const view = await context.newPage();
  await view.goto('file://' + saved);
  const shown = await view.evaluate(() => {
    const anchors = [...document.querySelectorAll('.header-anchor')];
    const own = document.querySelector('svg[aria-label="Three queued operations"]');
    return {
      callouts: document.querySelectorAll('.callout-title').length,
      bigIcons: [...document.querySelectorAll('.callout svg')].map((s) => Math.round(s.getBoundingClientRect().width)).filter((w) => w > 32),
      ownDrawing: own ? Math.round(own.getBoundingClientRect().width) : null,
      status: (document.querySelector('article p') || {}).textContent,
      anchors: anchors.length,
      anchorsShown: anchors.filter((a) => getComputedStyle(a).opacity !== '0').length,
      anchorsUnderlined: anchors.filter((a) => getComputedStyle(a).textDecorationLine.includes('underline')).length,
    };
  });
  expect(shown.callouts).toBeGreaterThan(0);
  expect(shown.bigIcons).toEqual([]);
  expect(shown.ownDrawing).toBe(120);
  expect(shown.status).toBe('in progress · 2026-10-04'); // as the page's card words it
  expect(shown.anchors).toBeGreaterThan(0);
  expect(shown.anchorsShown).toBe(0);
  expect(shown.anchorsUnderlined).toBe(0);
  await view.screenshot({ path: info.outputPath('portable.png') });

  // The confirmation is long; it stays long enough to be read (a 3.5 s toast would be gone).
  await page.waitForTimeout(4500);
  await expect(toast(page)).toBeVisible();
  expect(problems, problems.join('\n')).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Print / Save as PDF
// ---------------------------------------------------------------------------------------------------------------

const CHROME = ['.toolbar', '#tocSidebar', '.section-minimap', '#mdvExportDD', '#fabContainer', '#progressBar',
  '#mdvSidebar', '#linksPanel', '#ttsPlayer', '#mdvTestChrome'];

for (const theme of THEMES) {
  test(`printing from the ${theme} theme shows only the document, under a title header, light, with tables and code kept whole`, async ({ page }) => {
    await openDoc(page, SECTIONS, theme);
    // Chrome that would print if nothing hid it: the open Export menu, folded sections, and a panel another script
    // adds to the page (as later features will).
    await page.locator('#mdvExportBtn').click();
    await page.evaluate(() => {
      const extra = document.createElement('div');
      extra.id = 'mdvTestChrome';
      extra.textContent = 'A panel added by another script';
      document.body.appendChild(extra);
      toggleAllSections();
    });
    const shown = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; }, sel);
    // The instrument: on screen these are drawn, and the title header is not.
    for (const sel of ['.toolbar', '#tocSidebar', '.section-minimap', '#mdvExportDD', '#mdvTestChrome']) expect(await shown(sel), sel).toBe(true);
    expect(await shown('#mdvPrintHeader')).toBe(false);

    await page.emulateMedia({ media: 'print' });
    for (const sel of CHROME) expect(await shown(sel), `${sel} on paper`).toBe(false);
    const paper = await page.evaluate(() => {
      const cs = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
      const header = document.getElementById('mdvPrintHeader');
      return {
        header: header.getClientRects().length > 0,
        headerTitle: header.querySelector('.mdv-print-title').textContent,
        headerMeta: header.querySelector('.mdv-print-meta').textContent,
        page: getComputedStyle(document.body).backgroundColor,
        text: cs('#mdBody p').color,
        folded: [...document.querySelectorAll('#mdBody .section-content.collapsed')].every((s) => s.getClientRects().length > 0),
        firstH1: cs('#release-handoff').breakBefore,
        secondH1: cs('#appendix').breakBefore,
        h2After: cs('#risks').breakAfter,
        table: cs('#mdBody table').breakInside,
        diagram: cs('#mdBody .mermaid-wrapper').breakInside,
        pre: cs('#mdBody pre:not(.mermaid)').breakInside,
        codeWraps: cs('#mdBody pre code.hljs').whiteSpace,
        codeIntro: getComputedStyle(document.querySelector('#mdBody pre:not(.mermaid)').previousElementSibling).breakAfter,
        web: cs('#mdBody a[href="https://example.com/releases/checklist"]', '::after').content,
        mail: cs('#mdBody a[href="mailto:release@example.com"]', '::after').content,
        bare: cs('#mdBody a[href="https://example.com/tracker"]', '::after').content,
      };
    });
    expect(paper).toEqual({
      // The header names the document as the toolbar does: by its path, so two STATUS.md files print differently.
      header: true, headerTitle: 'Release handoff', headerMeta: expect.stringMatching(/^tests\/fixtures\/export\/sections\.md · /),
      page: 'rgb(255, 255, 255)', text: 'rgb(17, 17, 17)', folded: true,
      firstH1: 'auto', secondH1: 'page', h2After: 'avoid',
      table: 'avoid', diagram: 'avoid', pre: 'avoid', codeWraps: 'pre-wrap', codeIntro: 'auto',
      web: '" (https://example.com/releases/checklist)"', mail: '" (release@example.com)"', bare: 'none',
    });
  });
}

test('a paragraph before a tall diagram, code block or table never costs a page; one before a list stays with it', async ({ page }) => {
  test.setTimeout(150_000);
  await openDoc(page, SECTIONS);
  const pagesOf = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  const tall = {
    diagram: '```mermaid\nflowchart TD\n' + Array.from({ length: 22 }, (_, i) => `    N${i}[Step ${i} of the release] --> N${i + 1}[Step ${i + 1}]`).join('\n') + '\n```',
    code: '```bash\n' + Array.from({ length: 52 }, (_, i) => `echo "line ${i} of the long script that does many things"`).join('\n') + '\n```',
    table: '| Item | Owner | State |\n|---|---|---|\n' + Array.from({ length: 34 }, (_, i) => `| Row ${i} of the release table | someone | in progress |`).join('\n'),
  };
  // The same document with every "keep this paragraph with what follows" rule switched off: the rule may move a line,
  // never add a sheet. (Measured before this change, over 10 layouts each: 1 or 2 more sheets after every tall diagram, 1 more
  // after a long code block or table in 8 of 10.)
  const without = '@media print { .md-body p { break-after: auto !important; } }';
  for (const [kind, block] of Object.entries(tall)) {
    for (const lead of [1, 4]) {
      const filler = Array.from({ length: lead }, (_, i) => `Paragraph ${i}. ` + 'Words that fill the page before the block. '.repeat(9)).join('\n\n');
      await renderSource(page, `# Print check\n\n${filler}\n\nThe paragraph that introduces the block below, long enough to take two or three lines on paper, ends with estimates.\n\n${block}\n\nAfter the block.\n`);
      await waitForLayoutSettled(page);
      const shipped = pagesOf(await page.pdf({ format: 'A4' }));
      const style = await page.addStyleTag({ content: without });
      const counterfactual = pagesOf(await page.pdf({ format: 'A4' }));
      await style.evaluate((s) => s.remove());
      expect(shipped, `${kind} after ${lead} paragraphs: ${shipped} pages, ${counterfactual} without the rule`).toBe(counterfactual);
    }
  }
  // The rule still holds a line with a short block that can break: a list.
  await renderSource(page, '# Steps\n\nThe steps:\n\n1. One\n2. Two\n');
  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#mdBody ol').previousElementSibling).breakAfter)).toBe('avoid');
});

test('a diagram taller than a page prints smaller, whole on one page, on A4 and on US Letter', async ({ page }) => {
  await openDoc(page, SECTIONS);
  const pagesOf = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  const chain = Array.from({ length: 30 }, (_, i) => `    S${i}[Step ${i}] --> S${i + 1}[Step ${i + 1}]`).join('\n');
  await renderSource(page, '```mermaid\nflowchart TD\n' + chain + '\n```\n');
  await waitForLayoutSettled(page);
  // The instrument: drawn at its own size, this diagram is taller than any page.
  expect(await page.evaluate(() => document.querySelector('#mdBody .mermaid > svg').viewBox.baseVal.height * 25.4 / 96)).toBeGreaterThan(300);
  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => document.querySelector('#mdBody .mermaid > svg').getBoundingClientRect().height * 25.4 / 96)).toBeLessThanOrEqual(200.5);
  await page.emulateMedia({ media: null });
  expect(pagesOf(await page.pdf({ format: 'A4' }))).toBe(1);
  expect(pagesOf(await page.pdf({ format: 'Letter' }))).toBe(1);
});

test('Print / Save as PDF from the menu draws diagrams in the light palette for the paper, then gives the theme back', async ({ page }) => {
  await openDoc(page, SECTIONS, 'dark');
  const palettes = () => page.evaluate(() => [...document.querySelectorAll('#mdBody .mermaid')].map((el) => (el.dataset.mdvPalette || '').split('|')[0]));
  expect(await palettes()).toEqual(['dark', 'dark']);
  // The print dialog itself is the browser's: record what it would print instead of opening it.
  await page.evaluate(() => {
    window.print = () => {
      window.__printed = {
        theme: document.documentElement.getAttribute('data-theme'),
        palettes: [...document.querySelectorAll('#mdBody .mermaid')].map((el) => (el.dataset.mdvPalette || '').split('|')[0]),
      };
    };
  });
  await menu(page, 'print-document');
  await expect.poll(() => page.evaluate(() => window.__printed || null)).toEqual({ theme: 'light', palettes: ['light', 'light'] });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  expect(await page.evaluate(() => localStorage.getItem('mdv-theme'))).toBe('dark');
  await expect.poll(palettes).toEqual(['dark', 'dark']);

  // Whatever starts the print (the browser's own command included), a saved PDF is named after the document.
  const before = await page.title();
  expect(await page.evaluate(() => { window.dispatchEvent(new Event('beforeprint')); return document.title; })).toBe('Release handoff');
  expect(await page.evaluate(() => { window.dispatchEvent(new Event('afterprint')); return document.title; })).toBe(before);
});

test('Ctrl/Cmd+P prints as the menu does: from the dark theme, diagrams in the light palette', async ({ page }) => {
  await openDoc(page, SECTIONS, 'dark');
  await page.evaluate(() => {
    window.print = () => {
      window.__printed = {
        theme: document.documentElement.getAttribute('data-theme'),
        palettes: [...document.querySelectorAll('#mdBody .mermaid')].map((el) => (el.dataset.mdvPalette || '').split('|')[0]),
      };
    };
  });
  await page.keyboard.press('Control+p');
  await expect.poll(() => page.evaluate(() => window.__printed || null)).toEqual({ theme: 'light', palettes: ['light', 'light'] });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  // The ? sheet lists the key with the others.
  await page.keyboard.press('?');
  await expect(page.locator('#shortcutsOverlay')).toContainText('Print or save as PDF');
});

// ---------------------------------------------------------------------------------------------------------------
// Copy as rich text
// ---------------------------------------------------------------------------------------------------------------

test('Copy as rich text puts the whole document on the clipboard as HTML and as plain text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const problems = collectProblems(page);
  await openDoc(page, 'samples/kitchen-sink.md');
  await page.evaluate(() => navigator.clipboard.writeText('clipboard before'));
  const labels = await page.evaluate(() => [...document.querySelectorAll('#mdBody .mermaid-wrapper')].map((w) => w.dataset.diagramLabel));
  expect(labels.length).toBeGreaterThan(0);
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the document as rich text: 1 link goes to a file on this computer.');
  const clip = await readClipboard(page);
  expect(clip.types).toEqual(['text/html', 'text/plain']);

  const html = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    const tables = [...d.querySelectorAll('table')].map((t) => [...t.querySelectorAll('td')].map((td) => td.style.borderColor));
    return {
      title: (d.querySelector('h1') || {}).textContent,
      diagramImages: [...d.querySelectorAll('img')].filter((i) => /^data:image\/png;base64,/.test(i.src)).map((i) => i.alt),
      preFont: (d.querySelector('pre') || { style: {} }).style.fontFamily,
      inlineCodeFont: (d.querySelector('p code') || { style: {} }).style.fontFamily,
      cellBorder: (d.querySelector('td') || { style: {} }).style.border,
      // Every body cell of a table draws its border in one colour (the last row's used to be the text colour).
      cellColours: tables.map((cells) => [...new Set(cells)]),
      math: d.querySelectorAll('math').length,
      tex: d.querySelectorAll('annotation').length,
      viewerBits: d.querySelectorAll('button, svg.callout-icon, .mermaid svg, .section-toggle, .header-anchor, .code-header, [data-action], [data-tex], [data-mdv-caption]').length,
    };
  }, clip.html);
  expect(html.title).toBe('Offline Sync Design Review');
  expect(html.diagramImages).toEqual(expect.arrayContaining(labels));
  expect(html.diagramImages.filter((a) => labels.includes(a))).toHaveLength(labels.length);
  expect(html.preFont).toMatch(/monospace/);
  expect(html.inlineCodeFont).toMatch(/monospace/);
  expect(html.cellBorder).toMatch(/1px solid/);
  expect(html.cellColours.length).toBeGreaterThan(0);
  for (const colours of html.cellColours) expect(colours).toHaveLength(1);
  expect(html.math).toBeGreaterThan(0);
  expect(html.tex).toBe(0);
  expect(html.viewerBits).toBe(0);
  expect(clip.html).not.toMatch(/<script|MDV-ANCHOR|oklab\(|color-mix\(/i);

  expect(clip.text).toContain('# Offline Sync Design Review\n\nThis review describes');
  for (const label of labels) expect(clip.text).toContain(`[Diagram: ${label}]`);
  expect(clip.text).toContain('body\ttext\tCRDT\tcharacter-level');
  expect(clip.text).toMatch(/^- \[x\] /m);
  expect(clip.text).toMatch(/\$[^$\n]+\$/);
  expect(clip.text).toContain('2^10 entries');
  expect(clip.text.split('\n')).not.toContain('Copy');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the plain text of a copied document keeps its headings and code fences, as Markdown has them', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, SECTIONS);
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the document as rich text.');
  const { text } = await readClipboard(page);
  expect(text).toMatch(/^# Release handoff$/m);
  expect(text).toMatch(/^## Next steps$/m);
  expect(text).toContain('```sh\ngit tag --annotate v2.0.0');
  expect(text).toMatch(/v2\.0\.0[^\n]*\n```$/m);
  expect(text).toContain('1. Merge the branch.');
});

test('Copy as rich text copies a selection, and only it, with its formatting', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, 'samples/kitchen-sink.md');
  // From "bold" through "inline code" in the first paragraph of Text formatting.
  await page.evaluate(() => {
    const p = document.querySelector('#text-formatting + .section-content > p');
    const range = document.createRange();
    range.setStartBefore(p.querySelector('strong'));
    range.setEndAfter(p.querySelector('code'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the selection as rich text.');
  const clip = await readClipboard(page);
  expect(clip.text).toBe('bold, italic, bold italic, strikethrough, highlighted text, inline code\n');
  expect(clip.html).toContain('<strong>bold</strong>');
  expect(clip.html).not.toContain('Offline Sync Design Review');
  const code = await page.evaluate((h) => new DOMParser().parseFromString(h, 'text/html').querySelector('code').style.fontFamily, clip.html);
  expect(code).toMatch(/monospace/);

  // Part of one line of code: it is still code, in a code block, on the clipboard; its text has no fence.
  await page.evaluate(() => {
    const code = [...document.querySelectorAll('#mdBody pre code.hljs')].find((c) => c.textContent.includes('interface Operation'));
    const text = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node = text.nextNode();
    while (node && !node.nodeValue.includes('Operation')) node = text.nextNode();
    const range = document.createRange();
    range.setStart(node, node.nodeValue.indexOf('Operation'));
    range.setEnd(node, node.nodeValue.indexOf('Operation') + 'Operation'.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.evaluate(() => document.querySelectorAll('.mdv-toast').forEach((t) => t.remove()));
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the selection as rich text.'); // the write has finished
  const inCode = await readClipboard(page);
  expect(inCode.text).toBe('Operation\n');
  const pre = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    return d.querySelector('pre') ? d.querySelector('pre').style.fontFamily : null;
  }, inCode.html);
  expect(pre).toMatch(/monospace/);
});

test('Copy as rich text embeds an image named relative to the document, as Export HTML does, and names a missing one by its path', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, IMAGES);
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the document as rich text.');
  const { html, text } = await readClipboard(page);
  const png = readFileSync(repo('tests/fixtures/export/chart.png')).toString('base64');
  const pasted = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    return {
      images: Object.fromEntries([...d.querySelectorAll('img')].map((i) => [i.alt, i.getAttribute('src')])),
      notes: [...d.querySelectorAll('.mdv-export-missing')].map((n) => n.textContent),
    };
  }, html);
  expect(pasted.images['A chart next to the document']).toBe(`data:image/png;base64,${png}`);
  expect(pasted.images['The same chart, by its path from the viewer']).toBe(`data:image/png;base64,${png}`);
  expect(pasted.notes).toHaveLength(1);
  expect(pasted.notes[0]).toContain('(no-such-image.png)'); // the path as written, not a server address
  // A figure's caption that only repeats its alt text is not read twice.
  expect(text).toContain('[A chart next to the document]\n');
  expect(text).not.toContain('[A chart next to the document]A chart next to the document');
});

test('Copy as rich text from the dark theme pastes in the light palette, and leaves the page dark', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, 'samples/kitchen-sink.md', 'dark');
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toContainText('Copied the document as rich text');
  const { html } = await readClipboard(page);
  const colours = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    const pre = d.querySelector('pre');
    const lum = (c) => {
      const m = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
    };
    return { background: lum(pre.style.backgroundColor), text: lum(pre.style.color) };
  }, html);
  expect(colours.background).toBeGreaterThan(0.8);
  expect(colours.text).toBeLessThan(0.2);
  // Diagrams too: drawn again in the light palette for the paste, so a corner of each image is a light card...
  const corners = await page.evaluate(async (h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    const out = [];
    for (const img of [...d.querySelectorAll('img[alt]')].filter((i) => /^data:image\/png/.test(i.src) && /diagram|chart|Flowchart/i.test(i.alt))) {
      const pic = new Image();
      pic.src = img.src;
      await pic.decode();
      const c = document.createElement('canvas');
      c.width = pic.naturalWidth;
      c.height = pic.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(pic, 0, 0);
      out.push(Math.min(...ctx.getImageData(4, 4, 1, 1).data.slice(0, 3)));
    }
    return out;
  }, html);
  expect(corners.length).toBeGreaterThan(0);
  for (const channel of corners) expect(channel).toBeGreaterThan(200);
  // ...while the page keeps its theme and its own diagrams.
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  expect(await page.evaluate(() => [...document.querySelectorAll('#mdBody .mermaid')].every((el) => (el.dataset.mdvPalette || '').startsWith('dark|')))).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------------------------------------------

test('the Export menu appears with a document, and works from the keyboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('markdown-viewer.html');
  await expect(page.locator('#mdvExportWrap')).toBeHidden();
  await openDoc(page, SECTIONS);
  await expect(page.locator('#mdvExportBtn')).toBeVisible();
  await page.locator('#mdvExportBtn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mdvExportDD')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#mdvExportDD [data-action="export-html"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('#mdvExportDD [data-action="copy-rich-text"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast(page)).toHaveText('Copied the document as rich text.');
  await expect(page.locator('#mdvExportDD')).toBeHidden();
  await expect(page.locator('#mdvExportBtn')).toBeFocused(); // not a hidden item, from which Tab would restart the page
});

test('the toolbar menus close on Escape and when the focus leaves them, move with the arrow keys, and say whether they are open', async ({ page }) => {
  await openDoc(page, SECTIONS);
  const button = page.locator('#mdvExportBtn');
  const dd = page.locator('#mdvExportDD');
  const item = (action) => page.locator(`#mdvExportDD [data-action="${action}"]`);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(dd).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(item('export-html')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item('print-document')).toBeFocused();
  await page.keyboard.press('End');
  await expect(item('copy-section-link')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item('export-html')).toBeFocused(); // round to the first
  await page.keyboard.press('ArrowUp');
  await expect(item('copy-section-link')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dd).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  // ArrowDown on the closed button opens the menu at its first item; Tab past the last item closes it.
  await page.keyboard.press('ArrowDown');
  await expect(dd).toBeVisible();
  await expect(item('export-html')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(dd).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  // The theme menu is the same kind of menu.
  const theme = page.locator('[data-action="toggle-dropdown"][data-arg="themeDD"]');
  await theme.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#themeDD')).toBeVisible();
  await expect(theme).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#themeDD')).toBeHidden();
  await expect(theme).toBeFocused();
});

// ---------------------------------------------------------------------------------------------------------------
// The desktop app (stand-in shell, the app's CSP)
// ---------------------------------------------------------------------------------------------------------------

test('in the desktop app Export HTML embeds the images the window shows and notes the one it cannot read', async ({ page }) => {
  await openInApp(page, FIXTURE);
  const shown = await page.evaluate(() => [...document.querySelectorAll('#mdBody img')].map((i) => i.naturalWidth > 0));
  expect(shown).toEqual([true, true, true, false]); // the fourth is outside the document's folder: never loaded
  const { name, html } = await exportHtml(page);
  expect(name).toBe('doc.html');
  // other.md and notes.txt stay as written: no absolute path of the reader's folders goes into the file.
  await expect(toast(page)).toHaveText('Choose where to save doc.html: 1 image could not be read; a note marks each; 2 links point at files next to the document.');
  const x = await inspect(page, html);
  expect(x.scripts).toBe(0);
  expect(x.images).toHaveLength(3);
  for (const src of x.images) expect(src).toMatch(/^data:image\/png;base64,/);
  expect(x.notes).toHaveLength(1);
  expect(x.notes[0]).toContain('../outside.png');
  const href = (text) => (x.links.find((l) => l.text === text) || {}).href;
  expect(href('Another Markdown file')).toBe('other.md');
  expect(href('The same file, at a heading')).toBe('#section-two'); // the document itself: a link within the page
  expect(html).not.toContain(FIXTURE_DIR);
  // Read through the asset protocol as images, never fetched: the app's CSP refuses nothing the export did. (The page
  // served here still links the web-font stylesheet, which the app's own build leaves out: stage-frontend.mjs.)
  const refused = await page.evaluate(() => window.__csp.filter((v) => !/fonts\.googleapis\.com/.test(v)));
  expect(refused).toEqual([]);
});
