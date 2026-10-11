// ============================================
// Export: the document as one HTML file, and printed
// ============================================
// The toolbar's Export menu holds four actions: Export HTML and Print / Save as PDF (this file), Copy as rich text
// (js/copy.js) and Copy link to this section (js/section-links.js). Each starts from the document as the reader sees
// it, through a copy of it (js/snapshot.js): diagrams already drawn, math already typeset, nothing rendered again.
//
// Export HTML writes ONE file that needs nothing else:
// - the viewer's own stylesheets, inlined, in the theme on screen, and KaTeX's fonts as data: URIs (only the
//   faces the document's math uses);
// - each diagram as the SVG already drawn, each formula as KaTeX's HTML (with its MathML);
// - local images as data: URIs (web images keep their web address); an image that cannot be read becomes a visible
//   note in its place, never a silent gap;
// - links to other files resolved against the document's address where it has one (mdvResolveLinks);
// - no script, and a Content Security Policy that refuses one anyway; no viewer control (fold chevrons, Copy
//   buttons, the section rail, comment chips) and no HTML comment (comment threads, anchors, narration).
// A page opened from disk (file://) may not read its own stylesheets, so its export carries the portable styles
// that rich-text copy uses (mdvPortableStyles and mdvPortableBlocks in js/copy.js) and says so.
//
// Print / Save as PDF prints through css/print.css, which also serves the browser's own Print command: no chrome,
// a title header, whole tables, code blocks, diagrams and callouts, web addresses after their links. From the menu
// and from Ctrl/Cmd+P, a sepia or dark reader gets diagrams drawn again in the light palette for the paper, then
// their theme back.

// ---------- Stylesheets ----------
// The viewer's stylesheets, read in two steps. mdvExportSheets reads the rules at once, as the page has them when the
// export starts; mdvEmbedFonts then reads KaTeX's font files, which takes time. A stylesheet inside the document
// (each diagram's own <style>) travels with its diagram; the web-font stylesheet is another site's and is left out
// (the export uses the fallback fonts, as the desktop app does). `unreadable` counts the viewer's own sheets the page
// may not read.
function mdvExportSheets() {
  const parts = [];
  let unreadable = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode;
    if (sheet.disabled || (owner && owner.closest && owner.closest('[data-mdv-document]'))) continue;
    if (sheet.href && /^https?:/i.test(sheet.href) && new URL(sheet.href).origin !== location.origin) continue;
    let rules;
    try { rules = sheet.cssRules; } catch (e) { unreadable++; continue; }
    if (!rules) { unreadable++; continue; }
    mdvCollectRules(rules, sheet.href || location.href, parts);
  }
  return { parts, unreadable, readable: parts.some((p) => typeof p !== 'string' || p.trim()) };
}

// Each rule as text, with its URLs made absolute; a @font-face as its rule and base, for mdvEmbedFonts.
function mdvCollectRules(rules, base, parts) {
  for (const rule of Array.from(rules)) {
    if (typeof CSSImportRule === 'function' && rule instanceof CSSImportRule) {
      try { if (rule.styleSheet) mdvCollectRules(rule.styleSheet.cssRules, rule.styleSheet.href || base, parts); } catch (e) { /* unreadable */ }
      continue;
    }
    if (typeof CSSFontFaceRule === 'function' && rule instanceof CSSFontFaceRule) {
      parts.push({ face: rule, base });
      continue;
    }
    parts.push(mdvAbsoluteUrls(rule.cssText, base) + '\n');
  }
}

// The stylesheets' text, with the KaTeX faces the document uses embedded (`need`, from mdvMathFonts).
async function mdvEmbedFonts(sheets, need) {
  const fonts = { need, missing: false };
  const parts = await Promise.all(sheets.parts.map((p) => (typeof p === 'string' ? p : mdvEmbeddedFontFace(p.face, p.base, fonts))));
  return { css: parts.join(''), fontsMissing: fonts.missing };
}

function mdvAbsoluteUrls(css, base) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, q, url) => {
    if (/^(data:|#|[a-z][a-z0-9+.-]*:)/i.test(url)) return m;
    try { return `url("${new URL(url, base).href}")`; } catch (e) { return m; }
  });
}

const mdvFontKey = (family, weight, style) => {
  const w = String(weight).trim();
  const num = w === 'normal' ? '400' : w === 'bold' ? '700' : w;
  return `${String(family).split(',')[0].trim().replace(/^["']|["']$/g, '')}|${num}|${String(style || 'normal').trim()}`;
};

// The font faces the document's math is set in, from the computed style of every part of every formula (folded
// sections included: their styles are computed even while they are hidden).
function mdvMathFonts() {
  const need = new Set();
  for (const el of document.querySelectorAll('#mdBody .katex-html, #mdBody .katex-html *')) {
    const cs = getComputedStyle(el);
    need.add(mdvFontKey(cs.fontFamily, cs.fontWeight, cs.fontStyle));
  }
  return need;
}

// A @font-face the document uses, with its WOFF2 file as a data: URI; '' for any other face. When the file cannot
// be read, fonts.missing is set and the export shows math as MathML instead.
async function mdvEmbeddedFontFace(rule, base, fonts) {
  const st = rule.style;
  const key = mdvFontKey(st.getPropertyValue('font-family'), st.getPropertyValue('font-weight') || '400', st.getPropertyValue('font-style') || 'normal');
  if (!fonts.need.has(key)) return '';
  const src = st.getPropertyValue('src');
  const m = src.match(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/i) || src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
  let data = null;
  if (m) {
    if (/^data:/i.test(m[1])) data = m[1];
    else {
      try { data = await mdvFetchFontAsDataUrl(new URL(m[1], base).href); } catch (e) { data = null; }
    }
  }
  if (!data) { fonts.missing = true; return ''; }
  const format = /woff2/i.test(m[1]) ? ' format("woff2")' : '';
  return `@font-face { font-family: ${st.getPropertyValue('font-family')}; src: url("${data}")${format}; ` +
    `font-weight: ${st.getPropertyValue('font-weight') || 'normal'}; font-style: ${st.getPropertyValue('font-style') || 'normal'}; }\n`;
}

async function mdvFetchFontAsDataUrl(url) {
  if (/^file:/i.test(url)) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  // A server (the desktop app's among them) may label a font application/octet-stream; name it what it is.
  const woff2 = /\.woff2(?:[?#]|$)/i.test(url);
  return mdvBlobToDataUrl(woff2 && blob.type !== 'font/woff2' ? new Blob([blob], { type: 'font/woff2' }) : blob);
}

// For the exported page only: no toolbar above the anchors, the reading column centred, a note for each image
// that could not be read.
const MDV_EXPORT_PAGE_CSS = `
html { scroll-padding-top: 24px; }
body.mdv-export .content-wrapper { margin-left: 0; }
.mdv-export-missing { display: inline-block; max-width: 100%; padding: 0.55em 0.85em; border: 1px dashed var(--border-accent, #9a9a9a);
  border-radius: 8px; background: var(--bg-secondary, #f6f6f4); color: var(--text-secondary, #555);
  font: 500 0.82em/1.45 var(--font-ui, system-ui, sans-serif); }
`;

// Math shown as MathML, which browsers draw with their own math fonts, when KaTeX's fonts could not be embedded.
const MDV_EXPORT_MATHML_CSS = `
.katex .katex-mathml { position: static; clip: auto; width: auto; height: auto; overflow: visible; padding: 0; border: 0; }
.katex .katex-html { display: none; }
`;

// ---------- Export HTML ----------
// Everything that reads the page happens at one moment, right after the diagrams are drawn: the copy of the
// document, its name, title and theme, the stylesheets, the fonts its math needs, the address its paths are read
// from and, for a page opened as a file, the computed styles. Only reading files (images, KaTeX's fonts) comes
// after, so a document opened while they are read cannot mix into this export.
async function mdvBuildExportHtml() {
  // Every diagram drawn (a render pass may still be running), so the export has the SVG, not the source.
  if (typeof renderMermaidDiagrams === 'function') {
    try { await renderMermaidDiagrams(); } catch (e) { /* a diagram that cannot be drawn keeps its error box */ }
  }
  const html = document.documentElement;
  const page = {
    name: mdvExportFileName('.html'),
    title: mdvExportTitle(),
    theme: html.getAttribute('data-theme') || 'light',
    lang: html.lang || 'en',
    vars: ['--reading-size', '--reading-lh']
      .map((name) => [name, html.style.getPropertyValue(name).trim()])
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}: ${value}`).join('; '),
  };
  const address = mdvDocumentAddress();
  const { root, liveOf } = mdvSnapshot(null);
  mdvCleanSnapshot(root);
  mdvStaticDiagramLinks(root);
  // A box the reader ticked is ticked in the export: a tick changes the page's box, not its markup.
  for (const box of root.querySelectorAll('input[type="checkbox"]')) {
    const live = liveOf.get(box);
    if (live ? live.checked : box.hasAttribute('checked')) box.setAttribute('checked', '');
    else box.removeAttribute('checked');
    box.setAttribute('disabled', '');
  }
  const sheets = mdvExportSheets();
  const need = mdvMathFonts();
  // file://: the page may not read its own stylesheets. The portable styles (js/copy.js) go inline instead, and the
  // shapes they cannot style (a callout's icon, the frontmatter card) become plain HTML.
  const portable = !sheets.readable && sheets.unreadable > 0 && typeof mdvPortableStyles === 'function';
  let portableCss = '';
  if (portable) {
    mdvPortableStyles(root, liveOf, { page: true });
    if (typeof mdvPortableBlocks === 'function') mdvPortableBlocks(root, liveOf);
    portableCss = mdvPortablePageCss();
  }
  const links = mdvResolveLinks(root, { address });

  const [missing, fonts] = await Promise.all([
    mdvInlineImages(root, liveOf, { address }),
    portable ? Promise.resolve(null) : mdvEmbedFonts(sheets, need),
  ]);
  const css = portable ? portableCss : fonts.css + MDV_EXPORT_PAGE_CSS + (fonts.fontsMissing ? MDV_EXPORT_MATHML_CSS : '');
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: http: https:; font-src data:; media-src data: http: https:";
  const out = '<!DOCTYPE html>\n' +
    `<html lang="${mdvEscapeAttr(page.lang)}" data-theme="${mdvEscapeAttr(page.theme)}"${page.vars ? ` style="${mdvEscapeAttr(page.vars)}"` : ''}>\n` +
    '<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    `<title>${escapeHtml(page.title)}</title>\n` +
    `<style>\n${css.replace(/<\/(style)/gi, '<\\/$1')}\n</style>\n</head>\n` +
    `<body class="mdv-export${portable ? ' mdv-export-portable' : ''}">\n` +
    '<div class="content-wrapper full-width"><main class="content">' +
    `<article class="md-body">${root.innerHTML}</article></main></div>\n</body>\n</html>\n`;
  return { html: out, missing, portable, links, title: page.title, name: page.name };
}

// Hands the file to the browser as a download. The link is never added to the page: the desktop app's link
// handler (js/host.js) would refuse a blob: link there, and its shell asks where to save a download instead.
function mdvSaveDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// What the confirmation says about links that will not open everywhere (counts from mdvResolveLinks).
function mdvLinkNotes(links) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const notes = [];
  if (links.local) notes.push(n(links.local, 'link goes to a file on this computer', 'links go to files on this computer'));
  if (links.kept) notes.push(n(links.kept, 'link points at a file next to the document', 'links point at files next to the document'));
  if (links.text) notes.push(n(links.text, 'link to another file became plain text', 'links to other files became plain text'));
  return notes;
}

async function mdvExportHtml() {
  closeDropdowns();
  if (!mdvHasDocument()) { mdvToast('Open a document first.'); return; }
  try {
    const result = await mdvBuildExportHtml();
    mdvSaveDownload(new Blob([result.html], { type: 'text/html;charset=utf-8' }), result.name);
    const notes = [];
    if (result.missing.length) notes.push(`${result.missing.length} image${result.missing.length === 1 ? '' : 's'} could not be read; a note marks each`);
    notes.push(...mdvLinkNotes(result.links));
    if (result.portable) notes.push('styled simply: a page opened as a file cannot read its own stylesheets');
    // Handed over, not yet saved: the browser's or the app's Save dialog can still be cancelled.
    const desktop = window.mdvHost && window.mdvHost.kind === 'desktop';
    mdvToast(`${desktop ? 'Choose where to save' : 'Downloading'} ${result.name}${notes.length ? ': ' + notes.join('; ') + '.' : '.'}`);
  } catch (e) {
    console.error('export:', e);
    mdvToast('The export failed: ' + ((e && e.message) || e), 'error');
  }
}

// ---------- Print ----------
// The title header that print.css shows at the top of the first page, kept beside #mdBody (never inside it, where
// search, read-aloud and comments would see it). It is made now, before any document renders, and held here rather
// than looked up by its id: the sanitizer reserves the ids of the viewer's own elements (mdvChromeIds in
// js/render.js), so a document's own id="mdvPrintHeader" is dropped instead of being taken for this one and moved
// out of the document.
const mdvPrintHeader = (function () {
  const header = document.createElement('header');
  header.id = 'mdvPrintHeader';
  header.className = 'mdv-print-header';
  header.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'mdv-print-title';
  const meta = document.createElement('span');
  meta.className = 'mdv-print-meta';
  header.append(title, meta);
  const content = document.getElementById('content');
  const body = document.getElementById('mdBody');
  if (content && body && body.parentNode === content) content.insertBefore(header, body);
  return { header, title, meta };
})();

function mdvUpdatePrintHeader() {
  const content = document.getElementById('content');
  const body = document.getElementById('mdBody');
  if (!content || !body || body.parentNode !== content) return;
  const { header, title, meta } = mdvPrintHeader;
  if (header.parentNode !== content || header.nextSibling !== body) content.insertBefore(header, body);
  title.textContent = mdvExportTitle();
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  // The document as the toolbar names it: its path when the address loaded it, so ten agents' STATUS.md differ.
  const source = mdvDocumentLabel();
  meta.textContent = source ? `${source} · ${date}` : date;
}

// A web or mail link prints its address after its words, unless the words already are the address (a pasted URL, a
// link card, a badge in the frontmatter card). The address goes in data-mdv-print-url, which print.css shows: nothing
// changes on screen.
function mdvMarkPrintUrls(body) {
  const bare = (s) => s.replace(/^(https?:)?\/\//i, '').replace(/^mailto:/i, '').replace(/\/+$/, '').toLowerCase();
  for (const a of body.querySelectorAll('a[href]')) {
    a.removeAttribute('data-mdv-print-url');
    if (a.closest('.header-anchor, .link-chip, .fm-dashboard, svg')) continue;
    const href = a.getAttribute('href') || '';
    const mail = /^mailto:/i.test(href);
    if (!mail && !/^(https?:)?\/\//i.test(href)) continue;
    const words = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!words || bare(words) === bare(href.split('?')[0])) continue;
    a.setAttribute('data-mdv-print-url', mail ? href.replace(/^mailto:/i, '').split('?')[0] : href.replace(/^\/\//, 'https://'));
  }
}

mdvOnRender((body) => {
  mdvUpdatePrintHeader();
  mdvMarkPrintUrls(body);
  const menu = document.getElementById('mdvExportWrap');
  if (menu) menu.style.display = '';
});

// The browser names a saved PDF after the page's title: the document's, while printing.
let mdvTitleBeforePrint = null;
window.addEventListener('beforeprint', () => {
  if (!mdvHasDocument()) return;
  mdvUpdatePrintHeader();
  if (mdvTitleBeforePrint === null) mdvTitleBeforePrint = document.title;
  document.title = mdvExportTitle();
});
window.addEventListener('afterprint', () => {
  if (mdvTitleBeforePrint === null) return;
  document.title = mdvTitleBeforePrint;
  mdvTitleBeforePrint = null;
});

// Prints in the light palette whatever the theme: the page's colours are light on paper already (css/viewer.css), and
// diagrams, drawn in the theme's palette, are drawn again in the light one first. The theme comes back afterwards:
// once the print dialog closes (window.print returns when it does in a browser), or, in the desktop app, where
// window.print hands the job to the shell and returns at once, when printing ends or the reader next uses the page.
async function mdvPrintDocument() {
  closeDropdowns();
  if (!mdvHasDocument()) { mdvToast('Open a document first.'); return; }
  const theme = typeof currentTheme === 'string' ? currentTheme : 'light';
  const swap = theme !== 'light' && typeof setTheme === 'function';
  if (swap) {
    setTheme('light');
    if (typeof renderMermaidDiagrams === 'function') {
      try { await renderMermaidDiagrams(); } catch (e) { /* print what is drawn */ }
    }
  }
  mdvUpdatePrintHeader();
  let restored = !swap;
  const inputs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  const restore = () => {
    if (restored) return;
    restored = true;
    window.removeEventListener('afterprint', restore);
    for (const t of inputs) window.removeEventListener(t, restore, true);
    setTheme(theme);
  };
  if (swap) window.addEventListener('afterprint', restore);
  let pending = null;
  try {
    pending = window.print();
  } catch (e) {
    restore();
    mdvToast('Printing is not available here.', 'error');
    return;
  }
  if (pending && typeof pending.then === 'function') {
    pending.then(
      () => setTimeout(() => {
        if (restored) return;
        for (const t of inputs) window.addEventListener(t, restore, true);
      }, 400),
      () => { restore(); mdvToast('Printing is not available here.', 'error'); },
    );
  } else {
    restore();
  }
}

mdvRegisterActions({
  'export-html':    { click: () => mdvExportHtml() },
  'print-document': { click: () => mdvPrintDocument() },
});

// Ctrl/Cmd+P prints the way the menu does, so a reader's habit gets the same paper: light diagrams from any theme.
// With no document on screen, the key stays the browser's. Registered once every script has loaded: through the
// shortcut table's own function when it has one (wave 2, js/app.js), else as a row of that table, which the key
// handler and the ? sheet both read.
document.addEventListener('DOMContentLoaded', () => {
  const print = () => {
    if (!mdvHasDocument()) return false;
    mdvPrintDocument();
    return true;
  };
  if (typeof mdvRegisterShortcut === 'function') {
    mdvRegisterShortcut('Mod+P', print, 'Print or save as PDF');
  } else if (typeof MDV_SHORTCUTS !== 'undefined' && Array.isArray(MDV_SHORTCUTS)) {
    const help = MDV_SHORTCUTS.findIndex((s) => s.key === '?');
    MDV_SHORTCUTS.splice(help < 0 ? MDV_SHORTCUTS.length : help, 0, { mod: true, key: 'p', label: 'Print or save as PDF', run: print });
  }
});
