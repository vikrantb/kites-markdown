// ============================================
// Render markdown
// ============================================
// renderMarkdown is the one entry point that puts a document on the page. A document is untrusted
// input, so:
// - its HTML goes through DOMPurify before it reaches the page (mdvSanitize, below);
// - Mermaid runs at securityLevel 'strict' (mdvPinMermaidSecurity);
// - frontmatter of any shape renders, and a document that still cannot be rendered is shown as an
//   error with its text, never as a blank page or a "not found" prompt (mdvRenderErrorHtml).
function parseFrontmatter(src) {
  const match = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { body: src, meta: null };
  const yamlStr = match[1];
  const body = src.slice(match[0].length);

  // Simple YAML parser for our structured frontmatter
  const meta = {};
  let currentKey = null;
  let currentList = null;
  let currentItem = null;

  for (const line of yamlStr.split('\n')) {
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    const listItemMatch = line.match(/^\s+-\s+(.*)/);
    const nestedKvMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)/);

    if (topMatch && !line.startsWith(' ')) {
      currentKey = topMatch[1];
      const val = topMatch[2].replace(/^["']|["']$/g, '').trim();
      if (val) {
        meta[currentKey] = val;
        currentList = null;
      } else {
        meta[currentKey] = [];
        currentList = meta[currentKey];
        currentItem = null;
      }
    } else if (listItemMatch && currentList !== null) {
      const val = listItemMatch[1].trim();
      // Check if it's "key: value" format
      const kvMatch = val.match(/^(\w[\w-]*):\s*(.*)/);
      if (kvMatch) {
        currentItem = {};
        currentItem[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, '').trim();
        currentList.push(currentItem);
      } else {
        currentList.push(val.replace(/^["']|["']$/g, ''));
        currentItem = null;
      }
    } else if (nestedKvMatch && currentItem) {
      currentItem[nestedKvMatch[1]] = nestedKvMatch[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { body, meta };
}

// The frontmatter reader above is not a YAML library: a key with no value ("status:") becomes an
// empty list, and list items can be strings or objects. Read every dashboard field as text.
function mdvFrontmatterText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(mdvFrontmatterText).filter(Boolean).join(', ');
  return '';
}

function renderFrontmatterDashboard(meta) {
  if (!meta) return '';
  const status = mdvFrontmatterText(meta.status);
  const date = mdvFrontmatterText(meta.date);
  const metrics = Array.isArray(meta.metrics) ? meta.metrics : [];
  const repos = Array.isArray(meta.repos) ? meta.repos : [];

  if (!status && !metrics.length && !repos.length) return '';

  const statusClass = status.toLowerCase().replace(/[^a-z-]/g, '').replace('in-progress', 'in-progress') || 'draft';
  const statusNorm = statusClass.includes('ship') ? 'shipped' : statusClass.includes('progress') ? 'in-progress' : statusClass.includes('block') ? 'blocked' : 'draft';
  const dot = statusNorm === 'shipped' ? '&#9679;' : statusNorm === 'in-progress' ? '&#9675;' : statusNorm === 'blocked' ? '&#9679;' : '&#9675;';

  let html = '<div class="fm-dashboard"><div class="fm-top-row">';
  if (status) html += `<span class="fm-status-badge ${statusNorm}">${dot} ${escapeHtml(status)}</span>`;
  if (date) html += `<span class="fm-date">${escapeHtml(date)}</span>`;
  html += '</div>';

  if (metrics.length) {
    html += '<div class="fm-metrics">';
    for (const m of metrics) {
      const item = m && typeof m === 'object' ? m : { label: m };
      html += `<div class="fm-metric"><span class="fm-metric-value">${escapeHtml(mdvFrontmatterText(item.value))}</span><span class="fm-metric-label">${escapeHtml(mdvFrontmatterText(item.label))}</span></div>`;
    }
    html += '</div>';
  }

  if (repos.length) {
    html += '<div class="fm-repos">';
    for (const r of repos) {
      const repo = r && typeof r === 'object' ? r : { name: r };
      const name = mdvFrontmatterText(repo.name) || 'repo';
      const link = mdvFrontmatterText(repo.github);
      // A web address or a relative path; any other scheme (javascript:, data:) is not a link.
      if (link && (/^https?:\/\//i.test(link) || !/^[a-z][a-z0-9+.-]*:/i.test(link))) {
        html += `<a class="fm-repo-badge" href="${mdvEscapeAttr(link)}" target="_blank" rel="noopener">&#9733; ${escapeHtml(name)}</a>`;
      } else {
        html += `<span class="fm-repo-badge">${escapeHtml(name)}</span>`;
      }
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderMarkdown(source, title) {
  const body = document.getElementById('mdBody');
  const welcome = document.getElementById('welcomeScreen');

  // Build the page content. Nothing in here may stop the document from showing: a failure is
  // reported in its place (callers such as loadFromUrl must never mistake it for a missing file).
  let meta = null;
  let content;
  window._frontmatter = null;
  window._narrations = [];
  try {
    // Parse and strip YAML frontmatter
    const parsed = parseFrontmatter(source);
    meta = parsed.meta;
    window._frontmatter = meta;

    // Extract narrations before rendering
    window._narrations = extractNarrations(parsed.body).narrations;

    let dashboardHtml = '';
    try { dashboardHtml = renderFrontmatterDashboard(meta); } catch (e) { console.warn('frontmatter dashboard:', e); }
    content = mdvSanitize(dashboardHtml + md.render(parsed.body));
  } catch (err) {
    console.error('Render error:', err);
    content = mdvRenderErrorHtml(err, source);
  }
  if (typeof content === 'string') body.innerHTML = content;
  else body.replaceChildren(content);
  body.style.display = 'block';
  welcome.style.display = 'none';
  document.getElementById('fabContainer').style.display = 'flex';
  document.getElementById('foldBtn').style.display = '';
  document.getElementById('ttsToggleBtn').style.display = '';

  // Title
  const name = (title || 'Untitled').split('/').pop();
  const path = title && title.includes('/') ? title : '';
  document.getElementById('titleText').textContent = name;
  document.getElementById('breadcrumb').textContent = path;

  // Reading stats
  const text = body.textContent;
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  const mins = Math.max(1, Math.ceil(words / 230));
  document.getElementById('readingMeta').textContent = `${words.toLocaleString()} words ~ ${mins} min read`;

  // Post-process (each wrapped so one failure doesn't block the rest)
  try { transformCalloutBlocks(); } catch(e) { console.warn('callouts:', e); }
  try { addSectionToggles(); } catch(e) { console.warn('addSectionToggles:', e); }
  try { buildToc(); } catch(e) { console.warn('buildToc:', e); }
  try { buildSectionMinimap(); } catch(e) { console.warn('minimap:', e); }
  try { buildSearchIndex(); } catch(e) { console.warn('buildSearchIndex:', e); }
  try { buildTtsSections(); } catch(e) { console.warn('buildTtsSections:', e); }
  try { renderMermaidDiagrams(); } catch(e) { console.warn('renderMermaidDiagrams:', e); }
  try { setupScrollSpy(); } catch(e) { console.warn('setupScrollSpy:', e); }
  try { setupImageLightbox(); } catch(e) { console.warn('setupImageLightbox:', e); }
  try { enhanceLinks(); } catch(e) { console.warn('enhanceLinks:', e); }
  try { applyAbbreviationTooltips(meta); } catch(e) { console.warn('abbreviations:', e); }
  try { setupMermaidClickToSection(); } catch(e) { console.warn('mermaidClick:', e); }

  // Show toolbar buttons
  try { document.getElementById('linksPanelBtn').style.display = ''; } catch(e) {}

  // Reset state
  allCollapsed = false;
  window.scrollTo({ top: 0 });
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// For a value inside a double-quoted attribute: escapeHtml leaves quotes alone.
function mdvEscapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

// What a reader sees instead of a document that could not be rendered: the error, then the text.
function mdvRenderErrorHtml(err, source) {
  const message = (err && err.message) || String(err);
  return '<blockquote class="callout callout-caution"><div class="callout-title">&#128308; Caution</div>' +
    '<p><strong>This document could not be rendered.</strong> The error was: <code>' + escapeHtml(message) + '</code>. ' +
    'Its text is shown below, exactly as it is in the file.</p></blockquote>' +
    '<pre><code>' + escapeHtml(source) + '</code></pre>';
}

// ============================================
// Sanitizing: what a document may put on the page
// ============================================
// DOMPurify (vendor/purify.min.js) removes scripts, every on* attribute, javascript: and vbscript:
// URLs, frames, plugins and forms. Kept on purpose:
// - HTML comments: comment anchors (MDV-ANCHOR) and narration (narrate:) are read from them;
// - KaTeX output, including its MathML (<semantics>, <annotation>) and style attributes;
// - the viewer's own markup: classes, ids, data-* (data-action on code-block buttons), aria-*;
// - inline SVG, minus its scripts and handlers.
// Also removed: <style>, which would restyle the whole viewer, and any id or name that would take
// over one of the viewer's own elements (a document's <div id="ttsPlayer"> would otherwise
// capture the player's updates).
const MDV_SANITIZE_CONFIG = {
  ADD_TAGS: ['#comment', 'semantics', 'annotation'],
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['style', 'form', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'link'],
  FORCE_BODY: true,            // parse as <body> content, so a comment that starts the file is kept
  RETURN_DOM_FRAGMENT: true,   // insert the sanitized nodes themselves: no second HTML parse
};

// Without DOMPurify the viewer shows raw HTML as text (markdown-it's html: false) instead of
// trusting it. render.js reports the missing library below.
const mdvPurifier = (window.DOMPurify && typeof window.DOMPurify === 'function' && window.DOMPurify.isSupported)
  ? window.DOMPurify(window) : null;
let mdvSanitizeChromeIds = null;

if (mdvPurifier) {
  mdvPurifier.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName !== 'id' && data.attrName !== 'name') return;
    if (mdvSanitizeChromeIds && mdvSanitizeChromeIds.has(data.attrValue)) {
      data.keepAttr = false;
      return;
    }
    // DOMPurify drops every id that names a document property, which would strip the heading
    // ids "images", "links" and "title" and break links to them. Only named <img>, <form>,
    // <embed>, <object> and <iframe> elements can shadow such a property, and only <img> gets
    // through this config, so every other element keeps its id.
    if (data.attrName === 'id' && node.nodeName !== 'IMG') data.forceKeepAttr = true;
  });
  mdvPurifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute && node.hasAttribute('target')) node.setAttribute('rel', 'noopener noreferrer');
  });
} else {
  try { md.set({ html: false }); } catch (e) { /* markdown-it itself is missing; reported below */ }
}

// The ids of the viewer's own elements: everything outside the [data-mdv-document] containers.
function mdvChromeIds() {
  const ids = new Set();
  for (const el of document.querySelectorAll('[id]')) {
    if (!el.closest('[data-mdv-document]')) ids.add(el.id);
  }
  return ids;
}

// Returns a DocumentFragment, or, without DOMPurify, the HTML string markdown-it produced with raw
// HTML disabled (every tag in it was written by markdown-it or the viewer, from escaped text).
function mdvSanitize(html) {
  if (!mdvPurifier) return html;
  mdvSanitizeChromeIds = mdvChromeIds();
  try {
    return mdvPurifier.sanitize(html, MDV_SANITIZE_CONFIG);
  } finally {
    mdvSanitizeChromeIds = null;
  }
}

// Mermaid draws diagrams from document text. At securityLevel 'strict' it sanitizes labels,
// ignores click directives and refuses javascript: links; 'loose' allows all three, and through
// them script. The level is pinned here, at the library boundary, so no call can loosen it.
(function mdvPinMermaidSecurity() {
  if (typeof mermaid === 'undefined' || typeof mermaid.initialize !== 'function') return;
  const initialize = mermaid.initialize.bind(mermaid);
  mermaid.initialize = (config) => initialize(Object.assign({}, config, { securityLevel: 'strict' }));
  initialize({ startOnLoad: false, securityLevel: 'strict' });
})();

// ============================================
// Libraries: say so when a feature is off
// ============================================
// Every library is vendored and loaded by a plain <script> tag. When one does not load (a missing
// or renamed file), its global stays undefined and the feature that needs it switches off. Say so
// once, in the console and in a small notice, instead of failing silently.
const MDV_LIBRARIES = [
  { global: 'markdownit', feature: 'Markdown rendering' },
  { global: 'DOMPurify', feature: 'Raw HTML (shown as text: the sanitizer did not load)' },
  { global: 'markdownItAnchor', feature: 'Heading links' },
  { global: 'markdownitTaskLists', feature: 'Task-list checkboxes' },
  { global: 'markdownitFootnote', feature: 'Footnotes' },
  { global: 'markdownitMark', feature: 'Highlighted text' },
  { global: 'markdownitSub', feature: 'Subscript' },
  { global: 'markdownitSup', feature: 'Superscript' },
  { global: 'markdownitDeflist', feature: 'Definition lists' },
  { global: 'markdownitAbbr', feature: 'Abbreviations' },
  { global: 'diff_match_patch', feature: 'Fuzzy matching of comment anchors' },
  { global: 'hljs', feature: 'Code highlighting' },
  { global: 'mermaid', feature: 'Mermaid diagrams' },
  { global: 'katex', feature: 'Math' },
];

function mdvMissingLibraries() {
  return MDV_LIBRARIES.filter((lib) => typeof window[lib.global] === 'undefined');
}

function mdvShowNotice(text) {
  const notice = document.createElement('div');
  notice.className = 'mdv-notice';
  notice.setAttribute('role', 'status');
  Object.assign(notice.style, {
    position: 'fixed', top: 'calc(var(--toolbar-height) + 10px)', left: '50%', transform: 'translateX(-50%)',
    zIndex: '150', display: 'flex', alignItems: 'center', gap: '10px',
    maxWidth: 'min(640px, calc(100vw - 32px))', boxSizing: 'border-box', padding: '8px 8px 8px 14px',
    background: 'var(--bg-card)', color: 'var(--text-primary)', font: '500 0.82rem/1.45 var(--font-ui)',
    border: '1px solid var(--border-primary)', borderLeft: '4px solid var(--accent-warn)',
    borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)',
  });
  const message = document.createElement('span');
  message.textContent = text;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.dataset.action = 'dismiss-notice';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.title = 'Dismiss';
  dismiss.textContent = '\u00d7';
  Object.assign(dismiss.style, {
    flex: 'none', border: '0', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
    font: '400 1.15rem/1 var(--font-ui)', padding: '4px 8px', borderRadius: 'var(--radius-sm)',
  });
  notice.append(message, dismiss);
  document.body.appendChild(notice);
  return notice;
}

(function mdvReportMissingLibraries() {
  const missing = mdvMissingLibraries();
  if (!missing.length) return;
  for (const lib of missing) {
    console.warn(`${lib.feature} is off: the library that provides window.${lib.global} did not load (check vendor/).`);
  }
  mdvShowNotice((missing.length === 1 ? 'Off because its library did not load: ' : 'Off because their libraries did not load: ') +
    missing.map((lib) => lib.feature).join('; ') + '.');
})();

