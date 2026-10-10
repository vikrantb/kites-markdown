// ============================================
// State
// ============================================
let rawMarkdown = '';
let currentTheme = localStorage.getItem('mdv-theme') || 'light';
let fontStep = parseInt(localStorage.getItem('mdv-fontsize') || '0');
let tocVisible = true;
let allCollapsed = false;
let isExpanded = false;
let isFocusMode = false;
let searchIndex = [];
let searchFocusIdx = -1;
let narrationMap = {};  // { blockIndex: narrationText }
let currentFileName = '';

const fontSizes = [
  { label: 'XS', size: '0.92rem', lh: '1.7' },
  { label: 'S',  size: '1rem',    lh: '1.75' },
  { label: 'M',  size: '1.075rem', lh: '1.78' },
  { label: 'L',  size: '1.15rem', lh: '1.82' },
  { label: 'XL', size: '1.25rem', lh: '1.85' },
];

// ============================================
// markdown-it setup
// ============================================
const md = window.markdownit({
  html: true, linkify: true, typographer: true,
  highlight(str, lang) {
    const label = lang || 'text';
    let hl = '';
    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
      try { hl = hljs.highlight(str, { language: lang }).value; } catch (_) {}
    }
    if (!hl) hl = md.utils.escapeHtml(str);
    return `<div class="code-header"><span>${md.utils.escapeHtml(label)}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><code class="hljs language-${md.utils.escapeHtml(lang || '')}">${hl}</code>`;
  }
});

if (window.markdownItAnchor) md.use(window.markdownItAnchor, {
  permalink: markdownItAnchor.permalink.ariaHidden({ placement: 'after', symbol: '#', class: 'header-anchor' }),
  slugify: s => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, ''),
});
if (window.markdownitTaskLists) md.use(window.markdownitTaskLists, { enabled: true, label: true });
if (window.markdownitFootnote) md.use(window.markdownitFootnote);
if (window.markdownitMark) md.use(window.markdownitMark);
if (window.markdownitSub) md.use(window.markdownitSub);
if (window.markdownitSup) md.use(window.markdownitSup);
if (window.markdownitDeflist) md.use(window.markdownitDeflist);
if (window.markdownitAbbr) md.use(window.markdownitAbbr);

// Mermaid fence override
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  if (token.info.trim() === 'mermaid') {
    const id = 'mermaid-' + idx;
    return `<div class="mermaid-wrapper"><pre class="mermaid" id="${id}">${md.utils.escapeHtml(token.content)}</pre></div>`;
  }
  return defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

// KaTeX math: $..$ and $$..$$
function renderMath(src) {
  if (typeof katex === 'undefined') return src;
  src = src.replace(/\$\$([^$]+?)\$\$/gs, (_, m) => {
    try { return katex.renderToString(m.trim(), { displayMode: true, throwOnError: false }); } catch(e) { return `<pre>${m}</pre>`; }
  });
  src = src.replace(/\$([^$\n]+?)\$/g, (_, m) => {
    try { return katex.renderToString(m.trim(), { displayMode: false, throwOnError: false }); } catch(e) { return `<code>${m}</code>`; }
  });
  return src;
}

// ============================================
// Narration extraction: <!-- narrate: ... -->
// Transparent to other viewers (HTML comment).
// Place before a mermaid/image/table block.
// ============================================
function extractNarrations(src) {
  narrationMap = {};
  // Match: <!-- narrate: content --> (single or multiline)
  const re = /<!--\s*narrate:\s*([\s\S]*?)-->/gi;
  let match;
  const positions = [];
  while ((match = re.exec(src)) !== null) {
    const text = match[1].trim();
    const endPos = match.index + match[0].length;
    // Find what block follows this comment
    positions.push({ text, endPos, fullMatch: match[0] });
  }
  // Store narrations keyed by their position in source
  // We'll match them to rendered elements later
  return { cleaned: src, narrations: positions };
}

