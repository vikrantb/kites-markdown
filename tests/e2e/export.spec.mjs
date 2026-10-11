// Export and copy (js/export.js, js/copy.js, css/print.css): Export HTML, Print / Save as PDF, Copy as rich text and
// Copy link to this section, from the toolbar's Export menu and from each heading's "#".
//
// In a browser, and in the desktop app through a stand-in for its shell (as desktop.spec.mjs does it: Tauri's
// injected API, the app's own Content Security Policy). The real shell's part (where a download is saved, the print
// sheet) is the app's own; see docs/features.md.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectProblems, openDocument, waitForLayoutSettled } from './support/viewer.mjs';
import { THEMES, renderSource, waitForDiagrams } from './visuals-helpers.mjs';

const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const SECTIONS = 'tests/fixtures/export/sections.md';
const IMAGES = 'tests/fixtures/export/images.md';

async function openDoc(page, file, theme = 'light') {
  await page.addInitScript((t) => { try { localStorage.setItem('mdv-theme', t); } catch (_) { /* default theme */ } }, theme);
  await page.route(/example\.invalid/, (route) => route.abort());
  await openDocument(page, file);
}

async function menu(page, action) {
  await page.locator('#mdvExportBtn').click();
  await expect(page.locator('#mdvExportDD')).toBeVisible();
  await page.locator(`#mdvExportDD [data-action="${action}"]`).click();
}

async function exportHtml(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'export-html')]);
  return { download, name: download.suggestedFilename(), html: readFileSync(await download.path(), 'utf8') };
}

// What an exported file holds, parsed as a browser parses it.
const inspect = (page, html) => page.evaluate((h) => {
  const d = new DOMParser().parseFromString(h, 'text/html');
  const attrs = [...d.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`));
  return {
    scripts: d.querySelectorAll('script').length,
    handlers: attrs.filter((a) => /^on/i.test(a)),
    jsUrls: attrs.filter((a) => /^\s*[^=]+=\s*javascript:/i.test(a)),
    actions: d.querySelectorAll('[data-action]').length,
    diagrams: d.querySelectorAll('.mermaid > svg').length,
    controls: d.querySelectorAll('button, .section-toggle, .copy-btn, .diagram-expand-btn, .section-minimap, .mdv-chip').length,
    stylesheetLinks: d.querySelectorAll('link').length,
    style: [...d.querySelectorAll('head style')].map((s) => s.textContent).join('\n'),
    csp: (d.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '',
    theme: d.documentElement.getAttribute('data-theme'),
    title: d.title,
    images: [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')),
    notes: [...d.querySelectorAll('.mdv-export-missing')].map((n) => n.textContent),
    headings: [...d.querySelectorAll('h1, h2')].map((h) => h.id),
  };
}, html);

const readClipboard = (page) => page.evaluate(async () => {
  const [item] = await navigator.clipboard.read();
  const read = async (type) => (item.types.includes(type) ? (await item.getType(type)).text() : null);
  return { types: item.types.slice().sort(), html: await read('text/html'), text: await read('text/plain') };
});

const toast = (page) => page.locator('.mdv-toast').last();

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
  await expect(toast(page)).toHaveText('Downloading kitchen-sink.html.');
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
  // No comment thread, anchor or narration, and nothing that points back at the server it came from.
  expect(html).not.toContain('<!--');
  expect(html).not.toContain(new URL(baseURL).origin);

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

test('Export HTML from a page opened as a file (file://) carries portable styles instead of the stylesheets', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto(new URL('../../markdown-viewer.html', import.meta.url).href);
  await page.locator('#fileInput').setInputFiles(repo('samples/kitchen-sink.md'));
  await page.waitForSelector('#mdBody h1');
  await waitForDiagrams(page);
  // The instrument: here the page really cannot read its own stylesheet.
  expect(await page.evaluate(() => { try { return document.querySelector('link[href="css/viewer.css"]').sheet.cssRules.length; } catch (e) { return e.name; } })).toBe('SecurityError');
  const diagrams = await page.evaluate(() => document.querySelectorAll('#mdBody .mermaid > svg').length);
  const { html } = await exportHtml(page);
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
        introKept: getComputedStyle(document.querySelector('#mdBody pre:not(.mermaid)').previousElementSibling).breakAfter,
        web: cs('#mdBody a[href="https://example.com/releases/checklist"]', '::after').content,
        mail: cs('#mdBody a[href="mailto:release@example.com"]', '::after').content,
        bare: cs('#mdBody a[href="https://example.com/tracker"]', '::after').content,
      };
    });
    expect(paper).toEqual({
      header: true, headerTitle: 'Release handoff', headerMeta: expect.stringMatching(/^sections\.md · /),
      page: 'rgb(255, 255, 255)', text: 'rgb(17, 17, 17)', folded: true,
      firstH1: 'auto', secondH1: 'page', h2After: 'avoid',
      table: 'avoid', diagram: 'avoid', pre: 'avoid', codeWraps: 'pre-wrap', introKept: 'avoid',
      web: '" (https://example.com/releases/checklist)"', mail: '" (release@example.com)"', bare: 'none',
    });
  });
}

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
  await expect(toast(page)).toHaveText('Copied the document as rich text.');
  const clip = await readClipboard(page);
  expect(clip.types).toEqual(['text/html', 'text/plain']);

  const html = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    return {
      title: (d.querySelector('h1') || {}).textContent,
      diagramImages: [...d.querySelectorAll('img')].filter((i) => /^data:image\/png;base64,/.test(i.src)).map((i) => i.alt),
      preFont: (d.querySelector('pre') || { style: {} }).style.fontFamily,
      inlineCodeFont: (d.querySelector('p code') || { style: {} }).style.fontFamily,
      cellBorder: (d.querySelector('td') || { style: {} }).style.border,
      math: d.querySelectorAll('math').length,
      tex: d.querySelectorAll('annotation').length,
      viewerBits: d.querySelectorAll('button, svg.callout-icon, .mermaid svg, .section-toggle, .header-anchor, .code-header, [data-action], [data-tex]').length,
    };
  }, clip.html);
  expect(html.title).toBe('Offline Sync Design Review');
  expect(html.diagramImages).toEqual(expect.arrayContaining(labels));
  expect(html.diagramImages.filter((a) => labels.includes(a))).toHaveLength(labels.length);
  expect(html.preFont).toMatch(/monospace/);
  expect(html.inlineCodeFont).toMatch(/monospace/);
  expect(html.cellBorder).toMatch(/1px solid/);
  expect(html.math).toBeGreaterThan(0);
  expect(html.tex).toBe(0);
  expect(html.viewerBits).toBe(0);
  expect(clip.html).not.toMatch(/<script|MDV-ANCHOR|oklab\(|color-mix\(/i);

  expect(clip.text).toContain('Offline Sync Design Review\n\nThis review describes');
  for (const label of labels) expect(clip.text).toContain(`[Diagram: ${label}]`);
  expect(clip.text).toContain('body\ttext\tCRDT\tcharacter-level');
  expect(clip.text).toMatch(/^- \[x\] /m);
  expect(clip.text).toMatch(/\$[^$\n]+\$/);
  expect(clip.text).toContain('2^10 entries');
  expect(clip.text.split('\n')).not.toContain('Copy');
  expect(problems, problems.join('\n')).toEqual([]);
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

  // Part of one line of code: it is still code, in a code block, on the clipboard.
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

test('Copy as rich text from the dark theme pastes in the light palette, and leaves the page dark', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, 'samples/kitchen-sink.md', 'dark');
  await menu(page, 'copy-rich-text');
  await expect(toast(page)).toHaveText('Copied the document as rich text.');
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
// Links to sections
// ---------------------------------------------------------------------------------------------------------------

test('a heading\'s "#" copies the address of its section, and the address opens the document there', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, SECTIONS);
  await page.evaluate(() => document.getElementById('timeline').scrollIntoView({ block: 'center', behavior: 'instant' }));
  await waitForLayoutSettled(page);
  const before = await page.evaluate(() => scrollY);
  await page.locator('#timeline').hover();
  await page.locator('#timeline .header-anchor').click();
  const link = `${baseURL}markdown-viewer.html?file=${SECTIONS}#timeline`;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await expect(toast(page)).toHaveText('Link to “Timeline” copied.');
  expect(await page.evaluate(() => location.hash)).toBe('#timeline');
  expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThanOrEqual(1); // copied, not jumped

  // Opened: the section is at the top once the document and its diagrams (drawn after the first paint, above the
  // section) have settled.
  const other = await context.newPage();
  await other.goto(link);
  await other.waitForSelector('#mdBody h1');
  await waitForDiagrams(other);
  await waitForLayoutSettled(other);
  const place = await other.evaluate(() => ({
    top: document.getElementById('timeline').getBoundingClientRect().top,
    padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
    scrolled: scrollY,
  }));
  expect(place.scrolled).toBeGreaterThan(0);
  expect(Math.abs(place.top - place.padding)).toBeLessThanOrEqual(4);

  // The layout above the section keeps changing after it opens (a late diagram, an image). Chrome's scroll anchoring
  // would hide a drift; WebKit (Safari, the desktop app on a Mac) has none, so turn it off: the section must stay put.
  await other.evaluate(() => {
    document.documentElement.style.overflowAnchor = 'none';
    const late = document.createElement('div');
    late.style.height = '600px';
    document.querySelector('#mdBody .section-content').prepend(late);
  });
  await other.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await other.evaluate(() => document.getElementById('timeline').getBoundingClientRect().top);
  expect(Math.abs(after - place.padding)).toBeLessThanOrEqual(4);
});

test('a link to a section inside a closed <details> opens it there', async ({ page }) => {
  await page.goto(`markdown-viewer.html?file=${SECTIONS}#inside-the-details`);
  await page.waitForSelector('#mdBody h1');
  await waitForDiagrams(page);
  await waitForLayoutSettled(page);
  const r = await page.evaluate(() => {
    const h = document.getElementById('inside-the-details');
    return { open: h.closest('details').open, top: h.getBoundingClientRect().top, padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) };
  });
  expect(r.open).toBe(true);
  expect(Math.abs(r.top - r.padding)).toBeLessThanOrEqual(4);
});

test('the Export menu copies a link to the section being read', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, SECTIONS);
  await page.evaluate(() => document.getElementById('risks').scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => mdvSpy.active && mdvSpy.active.id)).toBe('risks');
  await menu(page, 'copy-section-link');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\?file=tests\/fixtures\/export\/sections\.md#risks$/);
  await expect(toast(page)).toHaveText('Link to “Risks” copied.');
});

test('a "#" that a document writes itself copies nothing; the viewer\'s own does', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDoc(page, SECTIONS);
  // The forged one even guesses at the mark the viewer gives its own permalinks.
  await renderSource(page, '# Two kinds of permalink\n\n<h2 id="forged">Forged <a class="header-anchor" href="#forged" data-mdv-permalink="0123456789abcdef0123456789abcdef">#</a></h2>\n\nText.\n\n## Genuine\n\nText.\n');
  await page.evaluate(() => navigator.clipboard.writeText('clipboard before'));
  await page.locator('#forged').hover();
  await page.locator('#forged .header-anchor').click({ force: true });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('clipboard before');
  // Positive control: the permalink markdown-it made for a heading of the same document.
  await page.locator('#genuine').hover();
  await page.locator('#genuine .header-anchor').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/#genuine$/);
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
});

// ---------------------------------------------------------------------------------------------------------------
// The desktop app (stand-in shell, the app's CSP)
// ---------------------------------------------------------------------------------------------------------------

const FIXTURE_DIR = '/desktop/tests/fixtures/linked';
const FIXTURE = readFileSync(repo('desktop/tests/fixtures/linked/doc.md'), 'utf8');
const APP_CSP = Object.entries(JSON.parse(readFileSync(repo('desktop/src-tauri/tauri.conf.json'), 'utf8')).app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`).join('; ');

// Just enough of the shell for these tests: the window's document, the commands the page sends (recorded), and the
// asset protocol (convertFileSrc), served with the app's Content Security Policy.
async function openInApp(page, text) {
  await page.route('**/markdown-viewer.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: Object.assign({}, response.headers(), { 'content-security-policy': APP_CSP }) });
  });
  const doc = { path: `${FIXTURE_DIR}/doc.md`, name: 'doc.md', text, mtimeMs: 1000, version: 'v-1000', readOnly: null, reason: 'initial' };
  await page.addInitScript((doc) => {
    try { localStorage.setItem('mdv-theme', 'light'); } catch (_) { /* default theme */ }
    window.__calls = [];
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'doc-1' }, currentWebview: { label: 'doc-1' } } };
    window.__TAURI__ = {
      core: {
        convertFileSrc: (path) => location.origin + path.split('/').map(encodeURIComponent).join('/'),
        async invoke(cmd, args) {
          window.__calls.push({ cmd, args: args || {} });
          if (cmd === 'mdv_initial_document') return doc;
          return null;
        },
      },
      event: { async listen() { return () => {}; } },
    };
  }, doc);
  await page.goto('markdown-viewer.html');
  await page.waitForSelector('#mdBody h1');
  await page.waitForFunction(() => [...document.querySelectorAll('#mdBody img')].every((i) => i.complete));
  await waitForLayoutSettled(page);
}

test('in the desktop app a section link is the document\'s path, and following it there goes to the section', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The path form: a link in any document can take it (a file: link is dropped by markdown-it and the sanitizer).
  const own = `${FIXTURE_DIR}/doc.md#section-two`;
  await openInApp(page, `${FIXTURE}\n\n## Further down\n\n${'A paragraph of words to read. '.repeat(60)}\n\n${'Another paragraph of words. '.repeat(60)}\n\n[Back to section two](${own})\n`);
  const start = page.url();
  await page.locator('#section-two').hover();
  await page.locator('#section-two .header-anchor').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(own);
  expect(page.url()).toBe(start); // the app has no address bar to update

  // The app's own way of following a link (js/host.js) takes it to the section, in this window.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.locator('#mdBody a', { hasText: 'Back to section two' }).click();
  await expect.poll(() => page.evaluate(() => {
    const top = document.getElementById('section-two').getBoundingClientRect().top;
    return top >= 0 && top < innerHeight / 2;
  })).toBe(true);
  expect(await page.evaluate(() => window.__calls.filter((c) => c.cmd === 'mdv_open_path'))).toEqual([]);
});

test('in the desktop app Export HTML embeds the images the window shows and notes the one it cannot read', async ({ page }) => {
  await openInApp(page, FIXTURE);
  const shown = await page.evaluate(() => [...document.querySelectorAll('#mdBody img')].map((i) => i.naturalWidth > 0));
  expect(shown).toEqual([true, true, true, false]); // the fourth is outside the document's folder: never loaded
  const { name, html } = await exportHtml(page);
  expect(name).toBe('doc.html');
  await expect(toast(page)).toHaveText('Choose where to save doc.html: 1 image could not be read; a note marks each.');
  const x = await inspect(page, html);
  expect(x.scripts).toBe(0);
  expect(x.images).toHaveLength(3);
  for (const src of x.images) expect(src).toMatch(/^data:image\/png;base64,/);
  expect(x.notes).toHaveLength(1);
  expect(x.notes[0]).toContain('../outside.png');
  // Read through the asset protocol as images, never fetched: the app's CSP refuses nothing the export did. (The page
  // served here still links the web-font stylesheet, which the app's own build leaves out: stage-frontend.mjs.)
  const refused = await page.evaluate(() => window.__csp.filter((v) => !/fonts\.googleapis\.com/.test(v)));
  expect(refused).toEqual([]);
});
