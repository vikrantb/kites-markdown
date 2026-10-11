// ============================================
// Link previews: what a linked document is about, on hover
// ============================================
// Resting the pointer on a link to another Markdown document (or reaching it with Tab) shows, after a short
// pause, a card with that document's title (its frontmatter `title`, else its first heading, else its file
// name), its first paragraph, and where it is. Which links get one:
//   - with a folder open: a link to a Markdown file in that folder (browser and desktop app);
//   - in the desktop app without one: any link to a Markdown file, which the shell can read.
// A link to a section (#risks) previews that section: its heading and its first paragraph.
// The card replaces the link's small address tooltip while it shows, and goes away when the pointer leaves the
// link and the card, on a key that is not a modifier (Shift, Ctrl, Cmd and Alt alone leave it, so a Ctrl-click
// still sees it), on a scroll, or on a click.
//
// The other document is untrusted input like any document: its title and paragraph go through markdown-it and the
// render path's DOMPurify instance and configuration, made stricter (mdvPreviewSanitize), the card is a
// [data-mdv-document] container, its links become text, its images their alt text (they would resolve against the
// wrong folder here) and its math its TeX source, and nothing in it loads anything: no element that fetches, no
// style attribute, no attribute that holds an address. Resting on a link must not tell anyone it was rested on.
// Only the block structure of the other file is parsed (md.block.parse).
//
// What a card shows is kept for the file as it was when read, and used again only while the file's size and time
// are the same (the desktop app reads the file again each time: the shell has no cheaper look).

const MDV_PREVIEW_DELAY_MS = 380;
const MDV_PREVIEW_HIDE_MS = 180;
const MDV_PREVIEW_MAX_SOURCE = 1600; // characters of the paragraph's source rendered
const MDV_PREVIEW_MODIFIER_KEYS = new Set(['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS']);

const mdvPreview = { card: null, link: null, showTimer: 0, hideTimer: 0, seq: 0, cache: new Map() };

function mdvPreviewCard() {
  if (mdvPreview.card) return mdvPreview.card;
  const card = document.createElement('div');
  card.className = 'mdv-preview';
  card.id = 'mdvLinkPreview';
  card.setAttribute('role', 'tooltip');
  card.setAttribute('data-mdv-document', '');
  card.hidden = true;
  card.addEventListener('mouseenter', () => clearTimeout(mdvPreview.hideTimer));
  card.addEventListener('mouseleave', () => mdvPreviewScheduleHide());
  document.body.appendChild(card);
  mdvPreview.card = card;
  return card;
}

// The #fragment of a link, decoded, or ''.
function mdvPreviewFragment(href) {
  const i = href.indexOf('#');
  if (i < 0) return '';
  const raw = href.slice(i + 1);
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

// Where a link leads, when it gets a preview: {path, label, fragment, read(), stat()} or null. stat (a browser
// file) gives the file's size and time without reading it.
function mdvPreviewTarget(a) {
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || a.classList.contains('header-anchor')) return null;
  const s = mdvFolderState;
  const shown = s.shown && s.shown.path;
  const fragment = mdvPreviewFragment(href);
  if (s.kind) {
    // A relative link in a browser needs the document's own place in the folder to resolve against.
    const from = s.kind === 'desktop' ? shown : s.current;
    if (s.kind === 'desktop' || from || href.startsWith('/')) {
      const path = mdvFolderResolve(from, href);
      if (path && (s.kind === 'desktop' || s.byPath.has(path))) {
        if (shown && mdvFolderSamePath(path, shown)) return null;
        const entry = s.byPath.get(path) || s.entries.find((e) => mdvFolderSamePath(e.path, path));
        const handle = entry && entry.handle;
        return {
          path, fragment, label: entry ? entry.rel : mdvFolderBaseName(path), read: () => mdvFolderRead(path),
          stat: handle ? () => handle.getFile().then((f) => ({ size: f.size, mtimeMs: f.lastModified })) : null,
        };
      }
    }
  }
  if (!mdvFolderIsDesktop() || !shown) return null;
  // The desktop app, outside any open folder: resolved against the document's own folder, as host.js does.
  let target = href.trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
  let abs;
  if (mdvFolderIsWindowsPath(target)) abs = mdvFolderNormalizeAbsolute(target);
  else if (scheme) {
    if (scheme[1].toLowerCase() !== 'file') return null;
    const p = mdvFolderFileUrlPath(target);
    abs = p && mdvFolderNormalizeAbsolute(p);
  } else {
    target = target.replace(/[?#].*$/, '');
    try { target = decodeURIComponent(target); } catch (e) { /* as written */ }
    if (!target) return null;
    const base = mdvFolderDirName(shown);
    abs = mdvFolderNormalizeAbsolute(target.startsWith('/') ? target : base + (mdvFolderIsWindowsPath(base) ? '\\' : '/') + target);
  }
  if (!abs || !MDV_FOLDER_MARKDOWN.test(abs) || mdvFolderSamePath(abs, shown)) return null;
  // Where it is, as seen from the document: below its folder, the path from there; elsewhere, the whole path.
  const here = mdvFolderDirName(shown);
  const label = mdvFolderInside(abs, here) ? abs.slice(here.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : abs;
  return {
    path: abs,
    label,
    fragment,
    read: () => window.mdvHost.readDocument(abs).then((d) => { if (!d) throw { code: 'not-found', message: 'not found' }; return d; }),
    stat: null,
  };
}

// The ids the render gives a document's headings (core.js: markdown-it-anchor with its slugify), by token index:
// the heading's text and code, lower-cased, every run of other characters a '-'; a repeated one gets -1, -2, …
function mdvPreviewHeadingIds(tokens) {
  const slugify = (s) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  const used = new Set();
  const ids = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const inline = tokens[i + 1];
    if (tokens[i].type !== 'heading_open' || !inline || inline.type !== 'inline') continue;
    const parsed = md.parseInline(inline.content, {});
    const children = (parsed[0] && parsed[0].children) || [];
    const base = slugify(children.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join(''));
    let id = base;
    for (let n = 1; used.has(id); n++) id = base + '-' + n;
    used.add(id);
    ids.set(i, id);
  }
  return ids;
}

// The title and first paragraph of a document's source, or with a fragment that names one of its headings, that
// section's heading and its first paragraph. Only the block structure is parsed.
function mdvPreviewExtract(text, fallbackTitle, fragment) {
  const parsed = typeof parseFrontmatter === 'function' ? parseFrontmatter(String(text)) : { body: String(text), meta: null };
  const body = parsed.body.replace(/\r\n?/g, '\n');
  const tokens = [];
  md.block.parse(body, md, {}, tokens);
  let title = parsed.meta && typeof parsed.meta.title === 'string' && parsed.meta.title.trim() ? parsed.meta.title.trim() : null;
  let titleSource = null;
  // The tokens to take the paragraph from: the whole document, or the section the fragment names (up to the next
  // heading of its level or above).
  let from = 0, to = tokens.length, sectionSource = null;
  if (fragment) {
    for (const [i, id] of mdvPreviewHeadingIds(tokens)) {
      if (id !== fragment && id !== fragment.toLowerCase()) continue;
      sectionSource = tokens[i + 1].content;
      from = i + 3;
      const level = tokens[i].tag;
      const next = tokens.findIndex((t, k) => k >= from && t.type === 'heading_open' && t.tag <= level);
      if (next >= 0) to = next;
      break;
    }
  }
  const paragraphs = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const inline = tokens[i + 1];
    if (!title && !titleSource && t.type === 'heading_open' && inline && inline.type === 'inline') titleSource = inline.content;
    if (i >= from && i < to && t.type === 'paragraph_open' && inline && inline.type === 'inline' && inline.content.trim()) paragraphs.push({ level: t.level, source: inline.content });
  }
  const words = (source) => mdvPreviewInline(source).textContent.replace(/\s+/g, ' ').trim();
  if (!title && titleSource) title = words(titleSource);
  // The first top-level paragraph that has words; else the first anywhere (a document that opens with a callout).
  paragraphs.sort((a, b) => (a.level === 0 ? 0 : 1) - (b.level === 0 ? 0 : 1));
  let paragraph = null;
  for (const p of paragraphs) {
    const frag = mdvPreviewParagraph(p.source);
    if (frag && frag.textContent.trim()) { paragraph = frag; break; }
  }
  const section = sectionSource != null ? words(sectionSource) : null;
  return { title: section || title || fallbackTitle, documentTitle: section ? title || fallbackTitle : null, paragraph };
}

// Elements a preview never holds, besides what every render drops: nothing in a preview loads anything (an image
// path would resolve against the wrong folder here anyway) or takes input. SVG and MathML go too: their attributes
// can reach other files, and a preview has no use for them (math shows as its TeX source, mdvPreviewInline).
const MDV_PREVIEW_FORBID = ['img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'use', 'feimage',
  'input', 'button', 'select', 'textarea', 'svg', 'math'];
// Attributes a preview never holds: each can load something (a style attribute through url() or image-set(), a
// table's background, an address), and resting on a link must fetch nothing.
const MDV_PREVIEW_FORBID_ATTR = ['style', 'background', 'src', 'srcset', 'href', 'xlink:href', 'poster', 'ping',
  'action', 'formaction', 'data', 'lowsrc', 'dynsrc'];

// The render path's sanitizer (render.js: the same DOMPurify instance and configuration as every document), with
// those elements and attributes removed before any of them is created in the page. Without DOMPurify, markdown-it
// already runs with raw HTML off (render.js), and mdvSanitize returns its output.
function mdvPreviewSanitize(html) {
  if (typeof mdvPurifier === 'undefined' || !mdvPurifier) return mdvSanitize(html);
  return mdvPurifier.sanitize(html, Object.assign({}, MDV_SANITIZE_CONFIG, {
    FORBID_TAGS: MDV_SANITIZE_CONFIG.FORBID_TAGS.concat(MDV_PREVIEW_FORBID),
    FORBID_ATTR: MDV_SANITIZE_CONFIG.FORBID_ATTR.concat(MDV_PREVIEW_FORBID_ATTR),
  }));
}

// Inline Markdown through the render path: markdown-it (an image becomes its alt text, math its TeX source as
// code), then the sanitizer.
function mdvPreviewInline(source, wrap) {
  const env = {};
  const tokens = md.parseInline(source, env);
  for (const t of tokens) {
    if (!t.children) continue;
    t.children = t.children.flatMap((c) => {
      if (c.type === 'math_inline' || c.type === 'math_inline_display') {
        const code = new t.constructor('code_inline', 'code', 0);
        const mark = c.type === 'math_inline' ? '$' : '$$';
        code.content = mark + c.content + mark;
        return [code];
      }
      if (c.type !== 'image') return [c];
      const text = new t.constructor('text', '', 0);
      text.content = c.content ? '[' + c.content + ']' : '';
      return [text];
    });
  }
  const html = md.renderer.render(tokens, md.options, env);
  const clean = mdvPreviewSanitize(wrap ? '<p>' + html + '</p>' : html);
  const holder = document.createElement('div');
  if (typeof clean === 'string') holder.innerHTML = clean; else holder.appendChild(clean);
  return holder;
}

// One paragraph, with its links as plain text.
function mdvPreviewParagraph(source) {
  const src = source.length > MDV_PREVIEW_MAX_SOURCE ? source.slice(0, MDV_PREVIEW_MAX_SOURCE) + '…' : source;
  const holder = mdvPreviewInline(src, true);
  for (const a of holder.querySelectorAll('a')) {
    const span = document.createElement('span');
    span.className = 'mdv-preview-link';
    span.append(...a.childNodes);
    a.replaceWith(span);
  }
  for (const el of holder.querySelectorAll('[id], input, button')) {
    if (el.matches('input, button')) el.remove(); else el.removeAttribute('id');
  }
  const frag = document.createDocumentFragment();
  frag.append(...holder.childNodes);
  return frag;
}

// What the card shows, from the file as it is now: kept per link target and used again only while the file's size
// and time are unchanged (a browser file is asked without reading it; a desktop file is read and compared).
async function mdvPreviewLoad(target) {
  const key = target.path + '#' + (target.fragment || '');
  const hit = mdvPreview.cache.get(key);
  let stat = null;
  if (target.stat) {
    try { stat = await target.stat(); } catch (e) { stat = null; }
    if (hit && stat && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit;
  }
  const doc = await target.read();
  const text = String(doc.text == null ? '' : doc.text);
  const mtimeMs = stat ? stat.mtimeMs : doc.mtimeMs;
  const size = stat ? stat.size : text.length;
  if (hit && !stat && mtimeMs != null && hit.mtimeMs === mtimeMs && hit.size === size) return hit;
  const extracted = mdvPreviewExtract(text, (doc.name || mdvFolderBaseName(target.path)).replace(MDV_FOLDER_MARKDOWN, ''), target.fragment);
  const entry = { size, mtimeMs, title: extracted.title, documentTitle: extracted.documentTitle, paragraph: extracted.paragraph };
  mdvPreview.cache.delete(key);
  mdvPreview.cache.set(key, entry);
  if (mdvPreview.cache.size > 60) mdvPreview.cache.delete(mdvPreview.cache.keys().next().value);
  return entry;
}

function mdvPreviewFill(target, content, failure) {
  const card = mdvPreviewCard();
  card.replaceChildren();
  const where = document.createElement('div');
  where.className = 'mdv-preview-where';
  // A section's card names the document it is in.
  where.textContent = content && content.documentTitle ? target.label + ' · ' + content.documentTitle : target.label;
  card.appendChild(where);
  if (failure) {
    const p = document.createElement('div');
    p.className = 'mdv-preview-note';
    p.textContent = failure;
    card.appendChild(p);
    return;
  }
  const title = document.createElement('div');
  title.className = 'mdv-preview-title';
  title.textContent = content.title;
  card.appendChild(title);
  const body = document.createElement('div');
  body.className = 'mdv-preview-body';
  if (content.paragraph) body.appendChild(content.paragraph.cloneNode(true));
  else { body.classList.add('is-empty'); body.textContent = 'No paragraph before its first list, table or code.'; }
  card.appendChild(body);
}

function mdvPreviewPlace(a) {
  const card = mdvPreview.card;
  const r = a.getBoundingClientRect();
  const width = Math.min(400, window.innerWidth - 24);
  card.style.width = width + 'px';
  const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
  const height = card.offsetHeight;
  let top = r.bottom + 8;
  if (top + height > window.innerHeight - 12 && r.top - height - 8 > 12) top = r.top - height - 8;
  card.style.left = left + 'px';
  card.style.top = Math.max(12, top) + 'px';
}

async function mdvPreviewShow(a) {
  const target = mdvPreviewTarget(a);
  if (!target) return;
  const seq = ++mdvPreview.seq;
  let content = null, failure = null;
  try {
    content = await mdvPreviewLoad(target);
  } catch (e) {
    failure = e && e.code === 'not-found' ? 'This document is not there.' : 'This document could not be read.';
  }
  if (seq !== mdvPreview.seq || mdvPreview.link !== a || !a.isConnected) return;
  mdvPreviewFill(target, content, failure);
  const card = mdvPreview.card;
  card.hidden = false;
  card.classList.remove('show');
  mdvPreviewPlace(a);
  requestAnimationFrame(() => card.classList.add('show'));
  a.setAttribute('aria-describedby', 'mdvLinkPreview');
  // The link's own small tooltip (links.js) would sit under the card: the card says more.
  const tooltip = document.getElementById('linkTooltip');
  if (tooltip) tooltip.classList.remove('visible');
}

function mdvPreviewHide() {
  clearTimeout(mdvPreview.showTimer);
  clearTimeout(mdvPreview.hideTimer);
  mdvPreview.seq++;
  if (mdvPreview.link) mdvPreview.link.removeAttribute('aria-describedby');
  mdvPreview.link = null;
  if (mdvPreview.card) { mdvPreview.card.hidden = true; mdvPreview.card.classList.remove('show'); }
}

function mdvPreviewScheduleHide() {
  clearTimeout(mdvPreview.hideTimer);
  mdvPreview.hideTimer = setTimeout(mdvPreviewHide, MDV_PREVIEW_HIDE_MS);
}

function mdvPreviewSchedule(a) {
  clearTimeout(mdvPreview.hideTimer);
  if (mdvPreview.link === a) return;
  mdvPreviewHide();
  mdvPreview.link = a;
  mdvPreview.showTimer = setTimeout(() => mdvPreviewShow(a), MDV_PREVIEW_DELAY_MS);
}

function mdvPreviewLinkOf(node) {
  const a = node && node.closest ? node.closest('a[href]') : null;
  return a && document.getElementById('mdBody').contains(a) ? a : null;
}

(function mdvPreviewWire() {
  const body = document.getElementById('mdBody');
  body.addEventListener('mouseover', (e) => {
    const a = mdvPreviewLinkOf(e.target);
    if (a) mdvPreviewSchedule(a);
  });
  body.addEventListener('mouseout', (e) => {
    const a = mdvPreviewLinkOf(e.target);
    if (!a || a !== mdvPreview.link) return;
    const to = e.relatedTarget;
    if (to && (a.contains(to) || (mdvPreview.card && mdvPreview.card.contains(to)))) return;
    if (mdvPreview.card && !mdvPreview.card.hidden) mdvPreviewScheduleHide(); else mdvPreviewHide();
  });
  body.addEventListener('focusin', (e) => {
    const a = mdvPreviewLinkOf(e.target);
    if (a) mdvPreviewSchedule(a);
  });
  body.addEventListener('focusout', (e) => { if (mdvPreviewLinkOf(e.target) === mdvPreview.link) mdvPreviewHide(); });
  body.addEventListener('click', () => mdvPreviewHide(), true);
  // Any key but a modifier on its own: the reader has moved on (Esc, a shortcut, typing). Shift, Ctrl, Cmd or Alt
  // held for a click on the link (its own window) leaves the card. Tab onto a link shows it again (focusin).
  document.addEventListener('keydown', (e) => {
    if (mdvPreview.link && !MDV_PREVIEW_MODIFIER_KEYS.has(e.key)) mdvPreviewHide();
  }, true);
  window.addEventListener('scroll', () => { if (mdvPreview.link) mdvPreviewHide(); }, { passive: true });
  // A new document: the old links are gone, and so is what was cached about the others.
  mdvFolderOn('shown', () => { mdvPreviewHide(); mdvPreview.cache.clear(); });
})();
