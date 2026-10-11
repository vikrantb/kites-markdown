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
// - no script, and a Content Security Policy that refuses one anyway; no viewer control (fold chevrons, Copy
//   buttons, the section rail, comment chips) and no HTML comment (comment threads, anchors, narration).
// A page opened from disk (file://) may not read its own stylesheets, so its export carries the portable styles
// that rich-text copy uses (mdvPortableStyles in js/copy.js) and says so.
//
// Print / Save as PDF prints through css/print.css, which also serves the browser's own Print command: no chrome,
// a title header, whole tables, code blocks, diagrams and callouts, web addresses after their links. From the menu,
// a sepia or dark reader gets diagrams drawn again in the light palette for the paper, then their theme back.

// ---------- Stylesheets ----------
// The viewer's stylesheets as text, with KaTeX's fonts embedded. A stylesheet inside the document (each diagram's
// own <style>) travels with its diagram; the web-font stylesheet is another site's and is left out (the export uses
// the fallback fonts, as the desktop app does). `unreadable` counts the viewer's own sheets the page may not read.
async function mdvExportCss() {
  const fonts = { need: mdvMathFonts(), missing: false };
  const parts = [];
  let unreadable = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode;
    if (sheet.disabled || (owner && owner.closest && owner.closest('[data-mdv-document]'))) continue;
    if (sheet.href && /^https?:/i.test(sheet.href) && new URL(sheet.href).origin !== location.origin) continue;
    let rules;
    try { rules = sheet.cssRules; } catch (e) { unreadable++; continue; }
    if (!rules) { unreadable++; continue; }
    parts.push(await mdvRulesText(rules, sheet.href || location.href, fonts));
  }
  return { css: parts.join('\n'), unreadable, fontsMissing: fonts.missing };
}

async function mdvRulesText(rules, base, fonts) {
  let text = '';
  for (const rule of Array.from(rules)) {
    if (typeof CSSImportRule === 'function' && rule instanceof CSSImportRule) {
      try { if (rule.styleSheet) text += await mdvRulesText(rule.styleSheet.cssRules, rule.styleSheet.href || base, fonts); } catch (e) { /* unreadable */ }
      continue;
    }
    if (typeof CSSFontFaceRule === 'function' && rule instanceof CSSFontFaceRule) {
      text += await mdvEmbeddedFontFace(rule, base, fonts);
      continue;
    }
    text += mdvAbsoluteUrls(rule.cssText, base) + '\n';
  }
  return text;
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
async function mdvBuildExportHtml() {
  // Every diagram drawn (a render pass may still be running), so the export has the SVG, not the source.
  if (typeof renderMermaidDiagrams === 'function') {
    try { await renderMermaidDiagrams(); } catch (e) { /* a diagram that cannot be drawn keeps its error box */ }
  }
  const { root, liveOf } = mdvSnapshot(null);
  mdvCleanSnapshot(root);
  mdvStaticDiagramLinks(root);
  root.querySelectorAll('input[type="checkbox"]').forEach((box) => box.setAttribute('disabled', ''));
  const missing = await mdvInlineImages(root, liveOf);

  const sheets = await mdvExportCss();
  // file://: the page may not read its own stylesheets. The portable styles (js/copy.js) go inline instead.
  const portable = !sheets.css.trim() && sheets.unreadable > 0 && typeof mdvPortableStyles === 'function';
  let css;
  if (portable) {
    mdvPortableStyles(root, liveOf, { page: true });
    css = mdvPortablePageCss();
  } else {
    css = sheets.css + MDV_EXPORT_PAGE_CSS + (sheets.fontsMissing ? MDV_EXPORT_MATHML_CSS : '');
  }

  const html = document.documentElement;
  const vars = ['--reading-size', '--reading-lh']
    .map((name) => [name, html.style.getPropertyValue(name).trim()])
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value}`).join('; ');
  const theme = html.getAttribute('data-theme') || 'light';
  const title = mdvExportTitle();
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: http: https:; font-src data:; media-src data: http: https:";
  const out = '<!DOCTYPE html>\n' +
    `<html lang="${mdvEscapeAttr(html.lang || 'en')}" data-theme="${mdvEscapeAttr(theme)}"${vars ? ` style="${mdvEscapeAttr(vars)}"` : ''}>\n` +
    '<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>\n${css.replace(/<\/(style)/gi, '<\\/$1')}\n</style>\n</head>\n` +
    `<body class="mdv-export${portable ? ' mdv-export-portable' : ''}">\n` +
    '<div class="content-wrapper full-width"><main class="content">' +
    `<article class="md-body">${root.innerHTML}</article></main></div>\n</body>\n</html>\n`;
  return { html: out, missing, portable, title };
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

async function mdvExportHtml() {
  closeDropdowns();
  if (!mdvHasDocument()) { mdvToast('Open a document first.'); return; }
  try {
    const result = await mdvBuildExportHtml();
    const name = mdvExportFileName('.html');
    mdvSaveDownload(new Blob([result.html], { type: 'text/html;charset=utf-8' }), name);
    const notes = [];
    if (result.missing.length) notes.push(`${result.missing.length} image${result.missing.length === 1 ? '' : 's'} could not be read; a note marks each`);
    if (result.portable) notes.push('styled simply, because a page opened as a file cannot read its own stylesheets');
    // Handed over, not yet saved: the browser's or the app's Save dialog can still be cancelled.
    const desktop = window.mdvHost && window.mdvHost.kind === 'desktop';
    mdvToast(`${desktop ? 'Choose where to save' : 'Downloading'} ${name}${notes.length ? ': ' + notes.join('; ') + '.' : '.'}`);
  } catch (e) {
    console.error('export:', e);
    mdvToast('The export failed: ' + ((e && e.message) || e), 'error');
  }
}

// ---------- Print ----------
// The title header that print.css shows at the top of the first page, kept beside #mdBody (never inside it, where
// search, read-aloud and comments would see it).
function mdvUpdatePrintHeader() {
  const content = document.getElementById('content');
  const body = document.getElementById('mdBody');
  if (!content || !body) return;
  let header = document.getElementById('mdvPrintHeader');
  if (!header) {
    header = document.createElement('header');
    header.id = 'mdvPrintHeader';
    header.className = 'mdv-print-header';
    header.setAttribute('aria-hidden', 'true');
    header.append(document.createElement('span'), document.createElement('span'));
    header.firstChild.className = 'mdv-print-title';
    header.lastChild.className = 'mdv-print-meta';
  }
  if (header.nextSibling !== body) content.insertBefore(header, body);
  header.firstChild.textContent = mdvExportTitle();
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const source = mdvExportSourceName();
  header.lastChild.textContent = source ? `${source} · ${date}` : date;
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
