// ============================================
// Block upgrades: callouts, figures, numeric table columns
// ============================================
// Icons are drawn inline (currentColor), so every callout matches its theme colour and renders the same on every
// operating system, unlike emoji.
const MDV_ICON = (paths) => `<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const CALLOUT_TYPES = {
  NOTE:      { label: 'Note',      icon: MDV_ICON('<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6"/><path d="M12 7.5v.01"/>') },
  TIP:       { label: 'Tip',       icon: MDV_ICON('<path d="M9 18.5h6"/><path d="M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-4 11.6c.7.6 1 1.3 1 2.1v.3h6v-.3c0-.8.3-1.5 1-2.1a6.5 6.5 0 0 0-4-11.6z"/>') },
  IMPORTANT: { label: 'Important', icon: MDV_ICON('<path d="M20.5 15.5a2 2 0 0 1-2 2H8l-4.5 4v-16a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M12 7.5v4"/><path d="M12 14.5v.01"/>') },
  WARNING:   { label: 'Warning',   icon: MDV_ICON('<path d="M10.3 3.6 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5"/><path d="M12 17v.01"/>') },
  CAUTION:   { label: 'Caution',   icon: MDV_ICON('<path d="M8 2.5h8l5.5 5.5v8L16 21.5H8L2.5 16V8z"/><path d="M12 7.5v5"/><path d="M12 16.5v.01"/>') },
  TLDR:      { label: 'TL;DR',     icon: MDV_ICON('<path d="M13.5 2.5 4.5 13.5h7l-1 8 9-11h-7z"/>') },
  DECISION:  { label: 'Decision',  icon: MDV_ICON('<circle cx="12" cy="12" r="9.5"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>') },
  COST:      { label: 'Cost',      icon: MDV_ICON('<path d="M3 12.6V4.5a1.5 1.5 0 0 1 1.5-1.5h8.1a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8l-7.1 7.1a2 2 0 0 1-2.8 0L3.6 14a2 2 0 0 1-.6-1.4z"/><circle cx="8" cy="8" r="1.5"/>') },
};

// renderMarkdown (render.js) runs this first among its post-processing passes, so the other block upgrades this
// file owns run here as well, each isolated so one failure cannot stop the others.
function transformCalloutBlocks() {
  const body = document.getElementById('mdBody');
  body.querySelectorAll('blockquote').forEach(bq => {
    const firstP = bq.querySelector('p');
    if (!firstP) return;
    const text = firstP.innerHTML;
    const match = text.match(/^\[!(\w+)\]\s*/);
    if (!match) return;
    const type = match[1].toUpperCase();
    const info = CALLOUT_TYPES[type];
    if (!info) return;

    // Remove the [!TYPE] marker from the text, and the paragraph if nothing else was in it.
    firstP.innerHTML = text.replace(/^\[!\w+\]\s*/, '');
    if (!firstP.textContent.trim() && !firstP.children.length) firstP.remove();

    bq.className = `callout callout-${type.toLowerCase()}`;
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.innerHTML = `${info.icon}<span>${info.label}</span>`; // fixed strings, never document text
    bq.insertBefore(title, bq.firstChild);
  });
  try { mdvCaptionImages(body); } catch (e) { console.warn('figures:', e); }
  try { mdvAlignNumericColumns(body); } catch (e) { console.warn('tables:', e); }
  try { mdvTableScrollCues(body); } catch (e) { console.warn('table scroll:', e); }
  try { mdvPolishDashboard(body); } catch (e) { console.warn('dashboard:', e); }
}

// An image alone in its paragraph becomes a figure: centred, rounded and shadowed, with its title (or, without one,
// its alt text) as a caption underneath. The paragraph stays a <p>. The caption is an empty element whose words
// CSS draws from data-caption: never text, because a comment's anchor is found by the block's text in the source
// (comments.js) and the caption's words are not on the image's line of markdown. The element also keeps a linked
// image from being turned into a text-only link card (enhanceLinks only converts a link alone in its paragraph).
function mdvCaptionImages(body) {
  for (const p of body.querySelectorAll('p')) {
    if (p.classList.contains('mdv-figure')) continue;
    const kids = [...p.childNodes].filter((n) => n.nodeType !== Node.TEXT_NODE || n.textContent.trim());
    if (kids.length !== 1 || kids[0].nodeType !== Node.ELEMENT_NODE) continue;
    let img = kids[0];
    if (img.tagName === 'A' && img.children.length === 1 && !img.textContent.trim()) img = img.firstElementChild;
    if (!img || img.tagName !== 'IMG') continue;
    p.classList.add('mdv-figure');
    const title = (img.getAttribute('title') || '').trim();
    const alt = (img.getAttribute('alt') || '').trim();
    const caption = title || (/^[\w.-]+\.(png|jpe?g|gif|svg|webp|avif)$/i.test(alt) ? '' : alt);
    if (!caption) continue;
    const cap = document.createElement('span');
    cap.className = 'mdv-figcaption';
    cap.dataset.caption = caption;
    p.appendChild(cap);
  }
}

// A column whose every filled body cell is a number (1,234.5, -3, 12%, $5, 4.2k) is right-aligned with tabular
// figures, unless the markdown already chose an alignment for it.
const MDV_NUMBER = /^[-+\u2212]?(?:[$\u20ac\u00a3\u00a5\u20b9]\s?)?\d[\d,.\u202f\u00a0 ]*(?:%|[kKMB]|ms|s|x|\u00d7)?$/;
function mdvAlignNumericColumns(body) {
  for (const table of body.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tbody tr')];
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.children.length));
    const heads = table.querySelectorAll('thead th');
    for (let c = 0; c < width; c++) {
      const cells = rows.map((r) => r.children[c]).filter(Boolean);
      if (cells.some((cell) => cell.style.textAlign)) continue;
      const filled = cells.map((cell) => cell.textContent.trim()).filter((t) => t && !/^[-\u2013\u2014]$/.test(t));
      if (!filled.length || !filled.every((t) => MDV_NUMBER.test(t))) continue;
      cells.forEach((cell) => cell.classList.add('mdv-num'));
      if (heads[c] && !heads[c].style.textAlign) heads[c].classList.add('mdv-num');
    }
  }
}

// A table wider than the column scrolls sideways inside its own box; mdv-more-left / mdv-more-right mark the sides it
// continues to, and CSS fades them, as code blocks shade theirs.
let mdvTableResize = null;
function mdvTableScrollCues(body) {
  if (mdvTableResize) { mdvTableResize.disconnect(); mdvTableResize = null; }
  const update = (t) => {
    const max = t.scrollWidth - t.clientWidth;
    t.classList.toggle('mdv-more-right', max > 1 && t.scrollLeft < max - 1);
    t.classList.toggle('mdv-more-left', max > 1 && t.scrollLeft > 1);
  };
  if (typeof ResizeObserver === 'function') mdvTableResize = new ResizeObserver((entries) => entries.forEach((e) => update(e.target)));
  for (const t of body.querySelectorAll('table')) {
    t.addEventListener('scroll', () => update(t), { passive: true });
    if (mdvTableResize) mdvTableResize.observe(t);
    update(t);
  }
}

// The frontmatter dashboard (render.js): a status written as a slug ("in-progress") reads as words, and a repository
// link's star glyph, which read as "favourite", is set apart in its own element that CSS hides (it draws a link
// icon instead). The text itself is unchanged, so anything reading the badge's text still finds it.
function mdvPolishDashboard(body) {
  const badge = body.querySelector(':scope > .fm-dashboard .fm-status-badge');
  if (badge) {
    for (const n of badge.childNodes) if (n.nodeType === Node.TEXT_NODE) n.textContent = n.textContent.replace(/(\w)[-_]+(?=\w)/g, '$1 ');
  }
  for (const a of body.querySelectorAll(':scope > .fm-dashboard a.fm-repo-badge')) {
    const t = a.firstChild;
    const m = t && t.nodeType === Node.TEXT_NODE && t.textContent.match(/^\s*\u2605/);
    if (!m) continue;
    const star = document.createElement('span');
    star.className = 'mdv-repo-star';
    star.textContent = m[0];
    t.textContent = t.textContent.slice(m[0].length);
    a.insertBefore(star, t);
  }
}

// A heading's own words: without the fold toggle, the "#" permalink markdown-it-anchor appends and a comment chip.
// Named apart from navigation.js's text helpers: classic scripts share one scope, and a later declaration with the
// same name would silently replace the earlier one for every caller.
function mdvHeadingLabel(h) {
  const copy = h.cloneNode(true);
  copy.querySelectorAll('.header-anchor, .section-toggle, .mdv-chip').forEach((el) => el.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

// ============================================
// Section Minimap
// ============================================
// A rail of the document's H2 sections (when there are three or more). It is the first thing in the document, sits in
// the space above it, and stays under the toolbar while reading, so its state is always in view: sections read,
// the current one, the ones ahead. With room, every segment carries its label; without room (many sections) the
// segments become a track, and the rail names the current section and its position instead. Labels are drawn by
// CSS from data attributes (known issue 11), so search, read-aloud and copy never pick them up, and the rail sits
// outside every section, so the blocks inside them keep their place among their siblings (comments.js records it).
const MDV_MINIMAP_MIN_LABEL = 72; // px: a segment narrower than this shows a track instead of a label
let mdvMinimap = null; // { nav, segments, headings, title, resize }

function buildSectionMinimap() {
  if (mdvMinimap && mdvMinimap.resize) mdvMinimap.resize.disconnect();
  mdvMinimap = null;
  const body = document.getElementById('mdBody');
  const h2s = [...body.querySelectorAll('h2')];
  if (h2s.length < 3) return; // Only show for docs with 3+ sections

  const nav = document.createElement('nav');
  nav.className = 'section-minimap';
  nav.setAttribute('aria-label', 'Sections');

  h2s.forEach(h => {
    const label = mdvHeadingLabel(h);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'minimap-segment';
    btn.dataset.targetId = h.id;
    btn.dataset.label = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => h.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    nav.appendChild(btn);
  });
  body.prepend(nav);

  const h1 = body.querySelector('h1');
  mdvMinimap = { nav, segments: [...nav.children], headings: h2s, title: h1 ? mdvHeadingLabel(h1) : 'Start' };
  if (typeof ResizeObserver === 'function') {
    mdvMinimap.resize = new ResizeObserver(() => mdvFitMinimap());
    mdvMinimap.resize.observe(nav);
  }
  mdvFitMinimap();
  mdvUpdateMinimap();
}

// Labels when every segment has room for one, a track otherwise.
function mdvFitMinimap() {
  const m = mdvMinimap;
  if (!m || !m.nav.isConnected) return;
  const width = m.nav.clientWidth;
  if (!width) return; // not laid out (a hidden document)
  m.nav.classList.toggle('is-track', width / m.segments.length < MDV_MINIMAP_MIN_LABEL);
}

// The current section is the last H2 above the reading line (the same line the outline uses), so the rail is right
// scrolling up as well as down. Folded headings are skipped.
function mdvUpdateMinimap() {
  const m = mdvMinimap;
  if (!m || !m.nav.isConnected) return;
  const line = Math.max(80, window.innerHeight * 0.3);
  let current = -1;
  m.headings.forEach((h, i) => {
    const r = h.getClientRects();
    if (r.length && r[0].top <= line) current = i;
  });
  m.segments.forEach((seg, i) => {
    seg.classList.toggle('active', i === current);
    seg.classList.toggle('passed', i < current);
    if (i === current) seg.setAttribute('aria-current', 'location');
    else seg.removeAttribute('aria-current');
  });
  m.nav.dataset.current = current >= 0 ? m.segments[current].dataset.label : m.title;
  m.nav.dataset.position = current >= 0 ? `${current + 1} / ${m.segments.length}` : `${m.segments.length} sections`;
}

let mdvMinimapFrame = 0;
function mdvScheduleMinimap() {
  if (!mdvMinimapFrame) mdvMinimapFrame = requestAnimationFrame(() => { mdvMinimapFrame = 0; mdvUpdateMinimap(); });
}
// One listener for the page's lifetime; each render only swaps what it reads.
window.addEventListener('scroll', mdvScheduleMinimap, { passive: true });
window.addEventListener('resize', mdvScheduleMinimap, { passive: true });

// ============================================
// Abbreviation Tooltips from frontmatter
// ============================================
// Both YAML shapes work (known issue 15):
//   abbreviations:                abbreviations:
//     API: Application ...          - API: Application ...
function applyAbbreviationTooltips(meta) {
  const abbrs = mdvFrontmatterAbbreviations(meta);
  const keys = Object.keys(abbrs).sort((a, b) => b.length - a.length); // longest first, so "API key" beats "API"
  if (!keys.length) return;

  const body = document.getElementById('mdBody');
  const SKIP = 'code, pre, kbd, samp, script, style, abbr, svg, button, .katex, .mermaid-wrapper, .callout-title, .code-header, .fm-dashboard, .section-minimap, .header-anchor';
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp('(?<![\\w])(' + escaped.join('|') + ')(?![\\w])', 'g');

  for (const node of textNodes) {
    const text = node.textContent;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      const abbr = document.createElement('abbr');
      abbr.className = 'abbr-tooltip';
      abbr.title = abbrs[m[1]];
      abbr.textContent = m[1];
      frag.appendChild(abbr);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    if (lastIdx > 0) node.parentNode.replaceChild(frag, node);
  }
}

// The abbreviation map from frontmatter, whatever shape parseFrontmatter (render.js) gave it.
function mdvFrontmatterAbbreviations(meta) {
  const out = {};
  const raw = meta && meta.abbreviations;
  const take = (k, v) => {
    k = String(k == null ? '' : k).trim();
    v = String(v == null ? '' : v).trim();
    if (k && v) out[k] = v;
  };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) take(k, v);
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') for (const [k, v] of Object.entries(item)) take(k, v);
      else if (typeof item === 'string') {
        const m = item.match(/^([^:]+):\s*(.+)$/);
        if (m) take(m[1], m[2]);
      }
    }
    // An indented map (`KEY: value` lines under `abbreviations:`) reaches us as an empty list, because the
    // frontmatter parser keeps lists and flat keys only. Read those lines from the document itself.
    if (!raw.length) Object.assign(out, mdvAbbreviationLinesFromSource(meta));
  }
  return out;
}

function mdvAbbreviationLinesFromSource(meta) {
  if (typeof rawMarkdown !== 'string' || !rawMarkdown) return {};
  // Use rawMarkdown only when it is the document being rendered: its frontmatter must parse to this same meta.
  if (typeof parseFrontmatter === 'function') {
    try {
      if (JSON.stringify(parseFrontmatter(rawMarkdown).meta) !== JSON.stringify(meta)) return {};
    } catch (_) {
      return {};
    }
  }
  const fm = rawMarkdown.replace(/\r\n?/g, '\n').match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!fm) return {};
  const out = {};
  let inMap = false;
  for (const line of fm[1].split('\n')) {
    if (/^abbreviations:\s*$/.test(line)) { inMap = true; continue; }
    if (!inMap) continue;
    if (/^\S/.test(line)) break; // the next top-level key ends the map
    const m = line.match(/^\s+([^\s:#-][^:]*?)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// ============================================
// Mermaid Click-to-Section
// ============================================
// A node whose label is exactly a heading's text links to that heading: a click, or Enter on the focused node,
// scrolls there (known issue 14). Diagrams are drawn asynchronously, after the render pass that calls this, so
// mermaid.js also calls mdvLinkDiagramNodes as each diagram is drawn. Linking is idempotent.
function setupMermaidClickToSection() {
  document.querySelectorAll('#mdBody .mermaid-wrapper').forEach((wrapper) => mdvLinkDiagramNodes(wrapper));
}

function mdvSlug(s) {
  return String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
}

function mdvHeadingTargets() {
  const map = new Map();
  document.querySelectorAll('#mdBody h1, #mdBody h2, #mdBody h3, #mdBody h4, #mdBody h5, #mdBody h6').forEach((h) => {
    if (!h.id) return;
    const slug = mdvSlug(mdvHeadingLabel(h));
    if (slug && !map.has(slug)) map.set(slug, h);
  });
  return map;
}

function mdvLinkDiagramNodes(wrapper) {
  const svg = wrapper.querySelector('.mermaid svg');
  if (!svg) return;
  const targets = mdvHeadingTargets();
  if (targets.size) {
    for (const node of svg.querySelectorAll('g.node, g.mindmap-node')) {
      if (node.hasAttribute('data-mdv-section')) continue;
      const heading = targets.get(mdvSlug(node.textContent));
      if (!heading) continue;
      const name = mdvHeadingLabel(heading);
      node.setAttribute('data-mdv-section', heading.id);
      node.classList.add('mdv-node-link');
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'link');
      node.setAttribute('aria-label', 'Go to section: ' + name);
      const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      tip.textContent = 'Go to section: ' + name;
      node.prepend(tip);
    }
  }
  if (wrapper.dataset.mdvLinksWired) return;
  wrapper.dataset.mdvLinksWired = '1';
  const follow = (e) => {
    const link = e.target.closest && e.target.closest('[data-mdv-section]');
    if (!link || !wrapper.contains(link)) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    mdvJumpToSection(link.getAttribute('data-mdv-section'));
  };
  wrapper.addEventListener('click', follow);
  wrapper.addEventListener('keydown', follow);
}

// Scroll to a heading, unfolding any collapsed section around it, then flash it so the eye finds it.
function mdvJumpToSection(id) {
  const target = id && document.getElementById(id);
  if (!target) return;
  for (let el = target.parentElement; el && el.id !== 'mdBody'; el = el.parentElement) {
    if (el.classList.contains('section-content') && el.classList.contains('collapsed')) {
      el.classList.remove('collapsed');
      const heading = el.previousElementSibling;
      const toggle = heading && heading.querySelector('.section-toggle');
      if (toggle) toggle.classList.remove('collapsed');
    }
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (target.hasAttribute('tabindex')) target.focus({ preventScroll: true });
  target.classList.remove('mdv-flash');
  void target.offsetWidth; // restart the animation when the same heading is chosen twice
  target.classList.add('mdv-flash');
  target.addEventListener('animationend', () => target.classList.remove('mdv-flash'), { once: true });
}
