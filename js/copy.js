// ============================================
// Copy as rich text
// ============================================
// Puts the selection (or, with nothing selected in the document, the whole document) on the clipboard twice: as HTML
// for email and documents, and as plain text for everything else.
// - The HTML carries its styles inline, in the light palette (mail and document editors ignore stylesheets and are
//   white): code keeps a monospace font and its colours, tables keep their borders, callouts their colour.
// - A diagram becomes a PNG image, drawn in the light palette (an SVG image of the page's drawing in a browser that
//   will not let a page draw it on a canvas), a formula its MathML, a local image a data: URI; the viewer's controls
//   and HTML comments are left out (mdvCleanSnapshot, js/snapshot.js).
// - The plain text keeps the shape: list markers, tab-separated table cells, "> " quotes, $TeX$, 2^10, the address
//   of a web link after its words, and "[Diagram: Flowchart]" where a diagram was.
// The same portable styles stand in for the stylesheets in an export from a file:// page (js/export.js).

// ---------- Portable styles ----------
// The monospace stack, with fonts every editor knows before the generic family: an editor that keeps only one name
// (some do) still gets a monospace one.
function mdvMonoStack() {
  const stack = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, Menlo, Consolas, monospace';
  return /courier new/i.test(stack) ? stack : stack.replace(/,?\s*monospace\s*$/i, '') + ', "Courier New", monospace';
}

const mdvSeen = (color) => !!color && color !== 'transparent' && !/^rgba\([^)]*,\s*0\)$/.test(color);

// A colour as #rrggbb, translucent ones over white: mail clients read hex, not oklab() or color-mix() results.
function mdvPortableColor(color) {
  if (!mdvSeen(color)) return '';
  return (typeof mdvColorHex === 'function' && mdvColorHex(color)) || color;
}

// Runs fn with the page in the light theme, for computed styles only: the theme comes back before the browser draws
// anything, so nothing on screen changes.
function mdvWithLightTheme(fn) {
  const html = document.documentElement;
  const theme = html.getAttribute('data-theme');
  if (!theme || theme === 'light') return fn();
  const light = document.getElementById('hljs-light');
  const dark = document.getElementById('hljs-dark');
  const was = [light && light.disabled, dark && dark.disabled];
  html.setAttribute('data-theme', 'light');
  if (light) light.disabled = false;
  if (dark) dark.disabled = true;
  try {
    return fn();
  } finally {
    html.setAttribute('data-theme', theme);
    if (light) light.disabled = was[0];
    if (dark) dark.disabled = was[1];
  }
}

// Inline styles from the page's computed styles, element by element: what a pasted copy (or an export from a file://
// page, `page`) needs to keep the document's look without any stylesheet. SVG and MathML keep their own styling.
function mdvPortableStyles(root, liveOf, { page = false } = {}) {
  const mono = mdvMonoStack();
  const c = mdvPortableColor;
  const rule = c(getComputedStyle(document.documentElement).getPropertyValue('--border-primary')) || '#d0d7de';
  for (const el of root.querySelectorAll('*')) {
    if (el.namespaceURI !== MDV_XHTML_NS) continue;
    const live = liveOf.get(el);
    if (!live) continue;
    const cs = getComputedStyle(live);
    const tag = el.localName;
    const diagram = !!live.closest('.mermaid-wrapper');
    const inPre = !diagram && !!live.closest('pre');
    const s = {};
    if (diagram) {
      // A diagram's <pre> is its frame, not code: the card is the image's own background.
      if (el.classList.contains('mermaid-wrapper')) Object.assign(s, { 'text-align': 'center', margin: '1em 0' });
    } else if (tag === 'pre') {
      Object.assign(s, { 'background-color': c(cs.backgroundColor), color: c(cs.color), border: `1px solid ${c(cs.borderTopColor) || rule}`,
        'border-radius': '8px', padding: '12px 14px', margin: '0 0 1em', 'font-family': mono, 'font-size': '13px',
        'line-height': '1.5', 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' });
    } else if (tag === 'code' && inPre) {
      Object.assign(s, { 'font-family': mono, 'white-space': 'pre-wrap', color: c(cs.color) });
    } else if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
      Object.assign(s, { 'font-family': mono, 'font-size': '0.9em', 'background-color': c(cs.backgroundColor), color: c(cs.color),
        padding: '0.1em 0.35em', 'border-radius': '4px' });
    } else if (inPre && tag === 'span') {
      s.color = c(cs.color);
      if (cs.fontStyle === 'italic') s['font-style'] = 'italic';
      if (Number(cs.fontWeight) >= 600) s['font-weight'] = 'bold';
    } else if (tag === 'table') {
      Object.assign(s, { 'border-collapse': 'collapse', margin: '0 0 1em' });
    } else if (tag === 'th' || tag === 'td') {
      Object.assign(s, { border: `1px solid ${c(cs.borderBottomColor) || rule}`, padding: '6px 10px',
        'text-align': cs.textAlign === 'start' ? 'left' : cs.textAlign, 'vertical-align': 'top' });
      if (tag === 'th') Object.assign(s, { 'background-color': c(cs.backgroundColor), 'font-weight': '600' });
    } else if (tag === 'blockquote') {
      Object.assign(s, { 'border-left': `4px solid ${c(cs.borderLeftColor) || rule}`, padding: '8px 14px',
        margin: '0 0 1em', color: c(cs.color), 'background-color': c(cs.backgroundColor), 'border-radius': '0 8px 8px 0' });
    } else if (el.classList.contains('callout-title')) {
      Object.assign(s, { 'font-weight': '600', color: c(cs.color), margin: '0 0 4px' });
    } else if (tag === 'img') {
      Object.assign(s, { 'max-width': '100%', height: 'auto' });
    } else if (tag === 'hr') {
      Object.assign(s, { border: '0', 'border-top': `1px solid ${rule}`, margin: '1.5em 0' });
    } else if (tag === 'mark') {
      Object.assign(s, { 'background-color': c(cs.backgroundColor), color: c(cs.color) });
    } else if (page && /^h[1-6]$/.test(tag)) {
      Object.assign(s, { 'font-family': cs.fontFamily, 'font-size': cs.fontSize, 'font-weight': cs.fontWeight, color: c(cs.color),
        'letter-spacing': cs.letterSpacing, 'border-bottom': cs.borderBottomStyle !== 'none' ? `${cs.borderBottomWidth} solid ${c(cs.borderBottomColor) || rule}` : '',
        'padding-bottom': cs.paddingBottom });
    } else if (page && tag === 'a') {
      s.color = c(cs.color);
    }
    for (const [k, v] of Object.entries(s)) if (v) el.style.setProperty(k, v);
  }
}

// The page around an export made from a file:// page: the reading column, fonts and colours of the theme on screen,
// diagrams on their card, math as MathML (KaTeX's stylesheet is one of the sheets the page could not read).
function mdvPortablePageCss() {
  const body = document.getElementById('mdBody');
  const cs = getComputedStyle(body);
  const root = getComputedStyle(document.documentElement);
  const token = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
  const page = getComputedStyle(document.body);
  return `
body { margin: 0; background: ${page.backgroundColor}; color: ${cs.color}; }
.mdv-export .content { max-width: ${token('--content-max-width', '760px')}; margin: 0 auto; padding: 44px 32px 96px; }
.md-body { font-family: ${cs.fontFamily}; font-size: ${cs.fontSize}; line-height: ${cs.lineHeight}; overflow-wrap: break-word; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 { line-height: 1.25; margin: 1.8em 0 0.6em; }
.md-body h1 { margin-top: 0; }
.md-body p, .md-body ul, .md-body ol, .md-body dl { margin: 0 0 1.1em; }
.md-body ul, .md-body ol { padding-left: 1.55em; }
.md-body li.task-list-item { list-style: none; }
.md-body img { max-width: 100%; height: auto; }
.mermaid-wrapper { margin: 1.8em 0; padding: 24px; text-align: center; overflow-x: auto; border-radius: 14px;
  background: ${token('--diagram-bg', '#ffffff')}; border: 1px solid ${token('--border-primary', '#d0d7de')}; }
.mermaid-wrapper svg { max-width: 100%; height: auto; }
.katex .katex-html { display: none; }
.md-body details { margin: 0 0 1.1em; }
.mdv-export-missing { display: inline-block; padding: 0.55em 0.85em; border: 1px dashed ${token('--border-accent', '#9a9a9a')}; border-radius: 8px; }
`;
}

// Shapes a pasted copy or a file:// export cannot style become plain HTML: a link card a link, a checkbox a ballot
// box, a formula its MathML (its TeX kept for the plain text), a figure caption text, a callout without its icon.
// For the clipboard (`clipboard`), a <details> also becomes its summary in bold and its content.
function mdvPortableBlocks(root, liveOf, { clipboard = false } = {}) {
  for (const chip of root.querySelectorAll('a.link-chip')) {
    const a = document.createElement('a');
    a.setAttribute('href', chip.getAttribute('href') || '');
    const title = chip.querySelector('.link-chip-title');
    a.textContent = (title ? title.textContent : chip.textContent).trim();
    const p = document.createElement('p');
    p.appendChild(a);
    chip.replaceWith(p);
  }
  for (const box of root.querySelectorAll('input[type="checkbox"]')) {
    const live = liveOf.get(box);
    const checked = live ? live.checked : box.hasAttribute('checked');
    box.replaceWith(document.createTextNode(checked ? '\u2611 ' : '\u2610 '));
  }
  for (const k of root.querySelectorAll('.katex')) {
    const annotation = k.querySelector('annotation[encoding="application/x-tex"]');
    const math = k.querySelector('.katex-mathml math') || k.querySelector('math');
    if (annotation) k.setAttribute('data-tex', annotation.textContent.trim());
    if (!math) continue;
    math.querySelectorAll('annotation, annotation-xml').forEach((a) => a.remove());
    const sem = math.querySelector(':scope > semantics');
    if (sem && sem.children.length === 1) sem.replaceWith(...sem.childNodes);
    k.replaceChildren(math);
  }
  for (const cap of root.querySelectorAll('.mdv-figcaption[data-caption]')) {
    const text = document.createElement('span');
    text.textContent = cap.getAttribute('data-caption');
    text.setAttribute('style', 'display:block;font-size:0.9em;opacity:0.75;margin-top:4px');
    cap.replaceWith(text);
  }
  root.querySelectorAll('.callout-title svg, .code-header').forEach((el) => el.remove());
  for (const dash of root.querySelectorAll('.fm-dashboard')) {
    const parts = [];
    const status = dash.querySelector('.fm-status-badge');
    const date = dash.querySelector('.fm-date');
    const line = document.createElement('p');
    if (status) { const b = document.createElement('strong'); b.textContent = status.textContent.replace(/^[\u25cf\u25cb\s]+/, '').trim(); line.appendChild(b); }
    if (date) line.append((status ? ' \u00b7 ' : '') + date.textContent.trim());
    if (line.childNodes.length) parts.push(line);
    const metrics = dash.querySelectorAll('.fm-metric');
    if (metrics.length) {
      const ul = document.createElement('ul');
      for (const m of metrics) {
        const li = document.createElement('li');
        const v = document.createElement('strong');
        v.textContent = (m.querySelector('.fm-metric-value') || {}).textContent || '';
        li.append(v, ' ' + (((m.querySelector('.fm-metric-label') || {}).textContent) || ''));
        ul.appendChild(li);
      }
      parts.push(ul);
    }
    const repos = dash.querySelectorAll('.fm-repo-badge');
    if (repos.length) {
      const p = document.createElement('p');
      repos.forEach((r, i) => {
        if (i) p.append(' \u00b7 ');
        const name = r.textContent.replace(/^\s*\u2605\s*/, '').trim();
        if (r.getAttribute('href')) { const a = document.createElement('a'); a.setAttribute('href', r.getAttribute('href')); a.textContent = name; p.appendChild(a); }
        else p.append(name);
      });
      parts.push(p);
    }
    dash.replaceWith(...parts);
  }
  if (!clipboard) return;
  for (const d of root.querySelectorAll('details')) {
    const div = document.createElement('div');
    const summary = d.querySelector(':scope > summary');
    if (summary) {
      const p = document.createElement('p');
      const b = document.createElement('strong');
      b.append(...summary.childNodes);
      p.appendChild(b);
      summary.remove();
      div.appendChild(p);
    }
    div.append(...d.childNodes);
    d.replaceWith(div);
  }
}

// ---------- Diagrams as images ----------
function mdvBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Each drawn diagram becomes an <img> of its SVG (what the clipboard can carry), sized as on the page. Returns the
// images with what upgrading each to a PNG needs.
function mdvDiagramImages(root, liveOf) {
  const out = [];
  for (const svg of root.querySelectorAll('.mermaid > svg')) {
    const live = liveOf.get(svg);
    const box = live ? live.getBoundingClientRect() : null;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    let width = box && box.width ? box.width : vb && vb.width ? vb.width : 600;
    let height = box && box.height ? box.height : vb && vb.height ? vb.height : 400;
    width = Math.round(width); height = Math.round(height);
    const copy = svg.cloneNode(true);
    copy.setAttribute('xmlns', MDV_SVG_NS);
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    copy.removeAttribute('style'); // max-width only; the image has its own size
    const xml = new XMLSerializer().serializeToString(copy);
    const wrapper = live && live.closest('.mermaid-wrapper');
    const label = wrapper ? wrapper.getAttribute('data-diagram-label') || 'Diagram' : 'Diagram';
    const img = document.createElement('img');
    img.setAttribute('src', 'data:image/svg+xml;base64,' + mdvBase64(xml));
    img.setAttribute('width', String(width));
    img.setAttribute('height', String(height));
    img.setAttribute('alt', label);
    img.setAttribute('style', 'max-width:100%;height:auto');
    // The diagram's <pre> is only its frame: a mail client could style it as code.
    const frame = svg.parentElement;
    if (frame && frame.localName === 'pre') {
      const div = document.createElement('div');
      div.className = frame.className;
      frame.replaceWith(div);
      div.appendChild(img);
    } else {
      svg.replaceWith(img);
    }
    // The card the diagram was drawn for, until it is drawn again in the light palette (mdvLightDiagrams).
    const background = wrapper ? getComputedStyle(wrapper).backgroundColor : '';
    const source = live && live.parentElement ? live.parentElement.getAttribute('data-mdv-source') : null;
    out.push({ img, xml, width, height, source, background: mdvSeen(background) ? background : '#ffffff' });
  }
  return out;
}

// Diagrams drawn again in the light palette, off screen, for a paste (mail and documents are white) when the page
// shows another theme. Each goes through the page's own Mermaid setup (js/mermaid.js), queued behind the page's
// own drawing so the two never share Mermaid's global configuration at once; the page's next pass sets its own
// again. A diagram that cannot be drawn so keeps the page's drawing and its card.
async function mdvLightDiagrams(diagrams) {
  const theme = document.documentElement.getAttribute('data-theme');
  const ready = typeof mermaid !== 'undefined' && typeof mdvMermaidConfig === 'function' && typeof mdvDiagramPalette === 'function' &&
    typeof mdvIsolateSvgIds === 'function' && typeof mdvMermaidQueue !== 'undefined';
  if (!theme || theme === 'light' || !ready || !diagrams.some((d) => d.source)) return;
  const palette = mdvWithLightTheme(() => mdvDiagramPalette());
  const width = typeof mdvDiagramContentWidth === 'function' ? mdvDiagramContentWidth() : undefined;
  const job = async () => {
    const stage = document.createElement('div');
    stage.setAttribute('aria-hidden', 'true');
    stage.style.cssText = 'position:absolute;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none';
    document.body.appendChild(stage);
    try {
      mermaid.initialize(mdvMermaidConfig(palette, width));
      for (const d of diagrams) {
        if (!d.source) continue;
        try {
          const id = 'mdv-mermaid-' + (++mdvMermaidSeq);
          const { svg, diagramType } = await mermaid.render(id, d.source);
          stage.innerHTML = svg; // Mermaid's own output at securityLevel 'strict', as the page inserts it
          const el = stage.querySelector('svg');
          if (!el) continue;
          mdvIsolateSvgIds(el, id + '-', true);
          if (typeof mdvFinishDiagram === 'function') { try { mdvFinishDiagram(el, diagramType, palette); } catch (e) { /* as drawn */ } }
          const vb = el.viewBox && el.viewBox.baseVal;
          if (vb && vb.width) d.height = Math.round(d.width * vb.height / vb.width);
          el.setAttribute('xmlns', MDV_SVG_NS);
          el.setAttribute('width', String(d.width));
          el.setAttribute('height', String(d.height));
          el.removeAttribute('style');
          d.xml = new XMLSerializer().serializeToString(el);
          d.background = palette.bg;
        } catch (e) {
          // keeps the page's drawing
        }
      }
    } finally {
      stage.remove();
    }
  };
  const run = mdvMermaidQueue.then(job, job);
  mdvMermaidQueue = run.catch(() => {});
  await run;
}

async function mdvDiagramToPng({ img, xml, width, height, background }) {
  try {
    const picture = new Image();
    picture.src = 'data:image/svg+xml;base64,' + mdvBase64(xml);
    await picture.decode();
    const scale = 2;
    const pad = 16;
    const canvas = document.createElement('canvas');
    canvas.width = (width + pad * 2) * scale;
    canvas.height = (height + pad * 2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(picture, pad * scale, pad * scale, width * scale, height * scale);
    img.setAttribute('src', canvas.toDataURL('image/png'));
    img.setAttribute('width', String(width + pad * 2));
    img.setAttribute('height', String(height + pad * 2));
  } catch (e) {
    // A browser that taints the canvas for an SVG with HTML labels: the SVG image stays.
  }
}

// ---------- Plain text ----------
const MDV_TEXT_BLOCK = /^(address|article|aside|blockquote|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|ul)$/;

function mdvPlainText(root) {
  return mdvTextBlocks(root).join('\n\n')
    .replace(/\u2610 ?/g, '[ ] ').replace(/\u2611 ?/g, '[x] ')
    .replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// The block-level pieces of a container, each a string of one or more lines.
function mdvTextBlocks(container) {
  const blocks = [];
  let inline = '';
  const flush = () => {
    const t = inline.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (t) blocks.push(t);
    inline = '';
  };
  for (const node of container.childNodes) {
    if (node.nodeType === 1 && mdvIsTextBlock(node)) {
      flush();
      const b = mdvBlockText(node);
      if (b) blocks.push(b);
    } else {
      inline += mdvInlineText(node);
    }
  }
  flush();
  return blocks;
}

function mdvIsTextBlock(el) {
  return MDV_TEXT_BLOCK.test(el.localName) || el.classList.contains('mermaid-wrapper') || el.classList.contains('katex-display');
}

function mdvBlockText(el) {
  const tag = el.localName;
  if (el.classList.contains('mermaid-wrapper')) {
    const img = el.querySelector('img[alt]');
    return `[Diagram: ${(img && img.getAttribute('alt')) || el.getAttribute('data-diagram-label') || 'Diagram'}]`;
  }
  if (el.classList.contains('katex-display')) {
    const k = el.querySelector('[data-tex]');
    return k ? `$$${k.getAttribute('data-tex')}$$` : mdvInlineText(el).trim();
  }
  if (tag === 'hr') return '---';
  if (tag === 'pre') return el.textContent.replace(/\n$/, '');
  if (tag === 'ul' || tag === 'ol') return mdvListText(el);
  if (tag === 'table') {
    return Array.from(el.rows).map((row) => Array.from(row.cells)
      .map((cell) => mdvInlineText(cell).replace(/\s+/g, ' ').trim()).join('\t')).join('\n');
  }
  if (tag === 'blockquote') return mdvTextBlocks(el).join('\n\n').split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
  return mdvTextBlocks(el).join('\n\n');
}

function mdvListText(list) {
  let n = Number(list.getAttribute('start')) || 1;
  const lines = [];
  for (const li of list.children) {
    if (li.localName !== 'li') continue;
    const marker = list.localName === 'ol' ? `${n++}. ` : '- ';
    const [first, ...rest] = mdvTextBlocks(li).join('\n').split('\n');
    lines.push(marker + (first || ''));
    for (const line of rest) lines.push(' '.repeat(marker.length) + line);
  }
  return lines.join('\n');
}

function mdvInlineText(node) {
  if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';
  const el = node;
  const tag = el.localName;
  if (tag === 'br') return '\n';
  if (el.hasAttribute('data-tex')) return `$${el.getAttribute('data-tex')}$`;
  if (tag === 'img') {
    const alt = (el.getAttribute('alt') || '').trim();
    return alt ? `[${alt}]` : '[image]';
  }
  if (tag === 'style' || tag === 'script') return '';
  let s = '';
  for (const c of el.childNodes) s += mdvInlineText(c);
  // 2^10, not 210; a footnote mark (a link alone in its <sup>) stays [1].
  if (tag === 'sup' && !(el.children.length === 1 && el.firstElementChild.localName === 'a')) return '^' + s;
  if (tag === 'a') {
    const href = el.getAttribute('href') || '';
    const bare = (x) => x.replace(/^(https?:)?\/\//i, '').replace(/\/+$/, '').trim().toLowerCase();
    if (/^https?:\/\//i.test(href) && bare(s) !== bare(href)) s += ` <${href}>`;
  }
  return s;
}

// ---------- Copy as rich text ----------
// A selection inside the document, or null (nothing selected, or a selection elsewhere: copy the whole document).
function mdvSelectionInDocument() {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const body = document.getElementById('mdBody');
  return body.contains(range.commonAncestorContainer) && range.toString().trim() ? range : null;
}

const mdvClipboardHtml = (root) => `<meta charset="utf-8"><div>${root.innerHTML}</div>`;

async function mdvCopyRichText() {
  closeDropdowns();
  if (!mdvHasDocument()) { mdvToast('Open a document first.'); return; }
  const range = mdvSelectionInDocument();
  // Everything that reads the page happens now, inside the click: the selection, the styles, each diagram's size.
  const snap = mdvSnapshot(range);
  mdvCleanSnapshot(snap.root, { clipboard: true });
  mdvWithLightTheme(() => mdvPortableStyles(snap.root, snap.liveOf));
  mdvPortableBlocks(snap.root, snap.liveOf, { clipboard: true });
  for (const note of snap.root.querySelectorAll('.mdv-export-missing')) note.setAttribute('style', 'font-style:italic');
  const diagrams = mdvDiagramImages(snap.root, snap.liveOf);
  const text = mdvPlainText(snap.root);
  for (const el of snap.root.querySelectorAll('[data-tex], [data-mdv-print-url], [data-mdv-section]')) {
    el.removeAttribute('data-tex');
    el.removeAttribute('data-mdv-print-url');
    el.removeAttribute('data-mdv-section');
  }
  // Right away: diagrams as SVG images, images where the page loaded them. Then, when ready: diagrams as PNG, local
  // images embedded. The clipboard API takes the second; the copy command (no clipboard API) the first.
  for (const img of snap.root.querySelectorAll('img')) {
    const live = snap.liveOf.get(img);
    if (live && live.currentSrc && !/^data:/i.test(img.getAttribute('src') || '')) img.setAttribute('src', live.currentSrc);
  }
  const now = mdvClipboardHtml(snap.root);
  const later = (async () => {
    try {
      await mdvLightDiagrams(diagrams);
      await Promise.all(diagrams.map(mdvDiagramToPng));
      await mdvInlineImages(snap.root, snap.liveOf, { noteStyle: 'font-style:italic' });
      return mdvClipboardHtml(snap.root);
    } catch (e) {
      return now;
    }
  })();
  const copied = await mdvWriteRichClipboard(later, now, text);
  if (copied) mdvToast(range ? 'Copied the selection as rich text.' : 'Copied the document as rich text.');
  else mdvToast('The browser did not allow copying.', 'error');
}

async function mdvWriteRichClipboard(later, now, text) {
  if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem === 'function') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': later.then((html) => new Blob([html], { type: 'text/html' })),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return true;
    } catch (e) {
      console.warn('copy: the clipboard API refused; using the copy command', e);
    }
  }
  return mdvCopyWithCommand(now, text);
}

// The copy command, with both kinds of data set in its copy event.
function mdvCopyWithCommand(html, text) {
  let done = false;
  const onCopy = (e) => {
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    e.stopImmediatePropagation();
    done = true;
  };
  document.addEventListener('copy', onCopy, true);
  try { document.execCommand('copy'); } catch (e) { done = false; } finally { document.removeEventListener('copy', onCopy, true); }
  return done;
}

mdvRegisterActions({
  'copy-rich-text': { click: () => mdvCopyRichText() },
});
