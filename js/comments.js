// ============================================
// MDV Comments — embedded threaded annotations
// ============================================
// On-disk format (a public contract; docs/commenting.md has the details):
//   anchor marker   <!-- MDV-ANCHOR id="..." -->   on its own line, before the top-level block it marks
//   comment block   <!-- MDV-COMMENTS:v1 ... MDV-COMMENTS:end -->   at the END of the file, one JSON payload
// Both are HTML comments in the reserved MDV- namespace, so other renderers hide them.
//
// The data-safety rules this file keeps:
//   1. A comment change is written into the source (rawMarkdown) together with the in-memory list, so
//      nothing that reads the source again can lose it.
//   2. The comment block is the last top-level HTML block that opens with the block token, as markdown-it
//      reads the document. A document that merely mentions the tokens (in code, inline code, a list, a quote
//      or prose) keeps every character of its text, and so does text typed below the block in another editor.
//   3. The payload is escaped and unescaped by the JSON parser. A block that cannot be read makes the
//      comments read-only for that file; it is never rewritten or dropped.
//   4. mdvWriteDocument() is the only function that writes a document, and it never overwrites a file that
//      changed after the viewer read it.

const MDV_VERSION = 1;
const MDV_GENERATOR = 'mdv-viewer';
const MDV_RE_ANCHOR = /<!--\s*MDV-ANCHOR\s+id="([a-zA-Z0-9_-]+)"\s*-->/g;
// The comment block opens at the start of a line (CommonMark allows up to 3 spaces before an HTML block)
const MDV_RE_BLOCK_START = /(^|\n) {0,3}<!--\s*MDV-COMMENTS:v\d+/;
const MDV_RE_BLOCK_HEAD = /^ {0,3}<!--\s*MDV-COMMENTS:v(\d+)/;
const MDV_RE_BLOCK_CLOSE = /MDV-COMMENTS:end\s*-->/;
// Without markdown-it, only a block that ends the file is read
const MDV_RE_BLOCK_OPEN = /(^|\n)( {0,3})<!--\s*MDV-COMMENTS:v(\d+)/g;
const MDV_RE_BLOCK_END = /MDV-COMMENTS:end\s*-->\s*$/;

let mdvComments = [];       // flat list of {id, parent_id, anchor, author, body_md, created_at, updated_at, status}
let mdvFileHandle = null;   // FileSystemFileHandle the current document was read from (browser only), or null
let mdvWorkspaceDir = null; // FileSystemDirectoryHandle: a file opened from it is linked when its contents match
let mdvDirty = false;       // the current document has comment changes that are not in its file yet
let mdvStatusTimer = null;
let mdvAuthorName = 'You';
try { mdvAuthorName = localStorage.getItem('mdv-author-name') || 'You'; } catch (e) { /* storage blocked */ }

// Per-document state. The renderMarkdown hook at the end of this file resets it on every document load.
let mdvLoadSeq = 0;        // counts document loads, so late async work can tell its document is gone
let mdvDocVersion = 0;     // counts committed comment changes of the current document
let mdvDocName = '';
let mdvDocTitle = '';  // the title the document was rendered with (it may carry a path)
let mdvDocText = null;     // the current document as last committed (a loader replaces rawMarkdown before we hear of it)
let mdvLoadedText = null;  // the current document as it was opened, before any comment change
let mdvLockReason = null;  // why comments are read-only for the current document, or null
let mdvLockKind = null;    // 'block' (its comment block cannot be read) or 'encoding' (the file is not UTF-8 text)
let mdvOwnRender = false;  // true while this file re-renders the current document itself
// The version of a file the viewer last read or wrote, per handle: {text, gen, notUtf8}, or {overwrite: true, gen}
// for a new file the reader picked in a Save dialog. mdvWriteDocument compares the file with it before writing.
const mdvBases = new WeakMap();

// ------- SHA-256 (synchronous, so anchors also work where crypto.subtle is missing) -------
const MDV_SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function mdvSha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str));
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(total - 4, (bytes.length * 8) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const ror = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + MDV_SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

// First 8 bytes of SHA-256, as 16 hex characters (the anchor's blockHash)
function mdvHash(text) { return mdvSha256Hex(text).slice(0, 16); }

// ------- The comment block: locate / parse / serialize -------
// The comment block is the LAST top-level HTML block of the document that opens with "<!-- MDV-COMMENTS:v<n>".
// markdown-it decides what a top-level HTML block is, so the same text in code, inline code, a list item, a quote
// or a paragraph is document text, never the block. Text after the block (typed below it in another editor) is
// document text too; a save moves the block back to the end. Returns {start, end, version, payload, error} with
// [start, end) the block in the source, or null when the document has no block.
function mdvLocateBlock(src) {
  if (!MDV_RE_BLOCK_START.test(src)) return null;
  const parts = mdvSplitFrontmatter(src);
  const tokens = parts ? mdvParseMarkdown(parts.body) : null;
  if (!tokens) return mdvLocateBlockAtEnd(src);
  let start = -1;
  let stop = -1;
  tokens.forEach((t) => {
    if (t.type !== 'html_block' || t.level !== 0 || !t.map || !MDV_RE_BLOCK_HEAD.test(t.content)) return;
    start = parts.bodyStart + mdvLineOffset(parts.body, t.map[0]);
    stop = parts.bodyStart + mdvLineOffset(parts.body, t.map[1]);
  });
  if (start === -1) return null;
  const text = src.slice(start, stop);
  const head = MDV_RE_BLOCK_HEAD.exec(text);
  const close = MDV_RE_BLOCK_CLOSE.exec(text);
  if (!head) return null;
  if (!close) {
    // The HTML comment ended before its closing line (a hand edit or a merge put "-->" inside it)
    return { start, end: stop, version: Number(head[1]), payload: null, error: 'its closing "MDV-COMMENTS:end -->" line is missing' };
  }
  return { start, end: start + close.index + close[0].length, version: Number(head[1]),
    payload: text.slice(head[0].length, close.index).trim(), error: null };
}

// Without markdown-it the viewer cannot tell an HTML block from code, so only a block that ends the file counts
function mdvLocateBlockAtEnd(src) {
  const end = MDV_RE_BLOCK_END.exec(src);
  if (!end) return null;
  let open = null;
  let m;
  MDV_RE_BLOCK_OPEN.lastIndex = 0;
  while ((m = MDV_RE_BLOCK_OPEN.exec(src)) && m.index < end.index) open = m;
  if (!open) return null;
  const payloadStart = open.index + open[0].length;
  if (payloadStart > end.index) return null;
  return {
    start: open.index + open[1].length,
    end: end.index + end[0].replace(/\s+$/, '').length,
    version: Number(open[3]),
    payload: src.slice(payloadStart, end.index).trim(),
    error: null
  };
}

// Reads a located block. JSON.parse itself decodes the \u002d and \u003c escapes that mdvSerialize writes,
// so a comment whose text contains those six characters literally round-trips intact.
function mdvReadPayload(loc) {
  if (loc.error) return { comments: [], extras: null, error: loc.error };
  if (loc.version !== MDV_VERSION) {
    return { comments: [], extras: null, error: 'it uses format v' + loc.version + ', which this viewer cannot read' };
  }
  let obj;
  try { obj = JSON.parse(loc.payload); } catch (e) { return { comments: [], extras: null, error: e.message }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { comments: [], extras: null, error: 'its payload is not a JSON object' };
  }
  if (obj.version != null && obj.version !== MDV_VERSION) {
    return { comments: [], extras: null, error: 'its payload is version ' + obj.version + ', which this viewer cannot read' };
  }
  if (!Array.isArray(obj.comments)) {
    return { comments: [], extras: null, error: 'its "comments" field is not a list' };
  }
  const extras = {};
  Object.keys(obj).forEach((k) => { if (k !== 'version' && k !== 'generator' && k !== 'comments') extras[k] = obj[k]; });
  return { comments: obj.comments, extras, error: null };
}

function mdvParseFile(src) {
  src = String(src == null ? '' : src);
  const loc = mdvLocateBlock(src);
  if (!loc) return { stripped: src, comments: [], parseError: null };
  const r = mdvReadPayload(loc);
  return { stripped: src, comments: r.comments, parseError: r.error };
}

// The line ending a document already uses, so a Windows file stays CRLF throughout
function mdvEol(src) { return String(src).indexOf('\r\n') !== -1 ? '\r\n' : '\n'; }

// Returns the document with its comment block replaced by one holding `comments`, at the end of the file. Every
// character of the text around the block is kept (only the line breaks where the block was are normalized), and
// fields of the block this viewer does not know are kept too. Throws, changing nothing, when the existing block
// cannot be read (an unreadable block is never dropped) or when the new block would not be read back.
function mdvSerialize(src, comments) {
  src = String(src == null ? '' : src);
  const list = comments || [];
  const loc = mdvLocateBlock(src);
  let extras = {};
  if (loc) {
    const r = mdvReadPayload(loc);
    if (r.error) throw new Error('The comment block in this file could not be read (' + r.error + '), so it was left unchanged.');
    extras = r.extras;
  }
  if (!loc && list.length === 0) return src; // nothing to add and nothing to remove: the file is left exactly as it is
  const eol = mdvEol(src);
  let body = src;
  if (loc) {
    // Text typed below the block in another editor stays, after the text above it
    const after = src.slice(loc.end);
    const tail = /\S/.test(after) ? after.replace(/^[ \t]*(?:\r?\n)+/, '') : '';
    body = src.slice(0, loc.start).replace(/[\r\n]+$/, '') + (tail ? eol + eol + tail : '');
  }
  body = body.replace(/[\r\n]+$/, '');
  // No comments left: the block goes, unless it holds fields this viewer does not know, which stay
  if (list.length === 0 && Object.keys(extras).length === 0) return body + eol;
  const payload = Object.assign({ version: MDV_VERSION, generator: MDV_GENERATOR, comments: list }, extras);
  // Escape what could end the HTML comment early: "--" and "<". Both escapes are plain JSON string escapes,
  // so JSON.parse restores them, and no other character can appear outside a JSON string.
  const json = JSON.stringify(payload).replace(/--/g, '-\\u002d').replace(/</g, '\\u003c');
  const out = body + eol + eol + '<!-- MDV-COMMENTS:v' + MDV_VERSION + eol + json + eol + 'MDV-COMMENTS:end -->' + eol;
  // Never write a block this viewer would not read back as this block: in a document that ends inside an
  // unclosed code fence the block would be code, invisible as comments, and every save would add another.
  const check = mdvLocateBlock(out);
  if (!check || check.error || check.payload !== json || out.slice(check.end).trim() !== '') {
    throw new Error('The comments could not be stored at the end of this file (it may end inside an unclosed code block), so nothing was changed.');
  }
  return out;
}

// ------- Anchor markers in the source -------
function mdvMarker(id) { return '<!-- MDV-ANCHOR id="' + id + '" -->'; }

function mdvMarkerIds(html) {
  const ids = [];
  const re = new RegExp(MDV_RE_ANCHOR.source, 'g');
  let m;
  while ((m = re.exec(String(html)))) ids.push(m[1]);
  return ids;
}

// True for an HTML block that holds only HTML comments (anchor markers, narration, the comment block).
// Such blocks render nothing visible, so they are not numbered: inserting a marker renumbers nothing.
function mdvIsCommentOnly(html) {
  const s = String(html);
  return s.indexOf('<!--') !== -1 && s.replace(/<!--[\s\S]*?-->/g, '').trim() === '';
}

// The renderable top-level blocks of a markdown-it token list, in the order mdvAnnotateBlocks numbers them
function mdvTopBlocks(tokens) {
  return tokens.filter((t) => t.level === 0 && t.nesting !== -1 && !(t.type === 'html_block' && mdvIsCommentOnly(t.content)));
}

// Splits off YAML front matter exactly as renderMarkdown does, so source lines can be mapped
function mdvSplitFrontmatter(src) {
  let body = src;
  if (typeof parseFrontmatter === 'function') {
    try { body = parseFrontmatter(src).body; } catch (e) { return null; }
  }
  if (typeof body !== 'string' || !src.endsWith(body)) return null;
  return { bodyStart: src.length - body.length, body };
}

function mdvLineOffset(text, line) {
  let off = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', off);
    if (nl === -1) return text.length;
    off = nl + 1;
  }
  return off;
}

// markdown-it's block tokens for `text`. The last parse is kept: locating the block, its markers and an insertion
// point each need one, and they ask about the same text. The tokens are only read, never changed.
let mdvParseCache = { text: null, tokens: null };
function mdvParseMarkdown(text) {
  if (typeof md === 'undefined' || !md || typeof md.parse !== 'function') return null;
  if (mdvParseCache.text === text) return mdvParseCache.tokens;
  let tokens;
  try { tokens = md.parse(text, { mdvProbe: true }); } catch (e) { return null; }
  mdvParseCache = { text, tokens };
  return tokens;
}

// Removes the anchor markers with the given ids. A marker is a line that markdown-it reads as an HTML block (at any
// depth, outside the comment block): the same text in code, inline code or front matter is document content and
// stays, and nothing else in the document changes.
function mdvRemoveMarkers(src, ids) {
  if (!ids || !ids.size) return src;
  const parts = mdvSplitFrontmatter(src);
  const tokens = parts ? mdvParseMarkdown(parts.body) : null;
  // A marker left behind is an invisible HTML comment; text removed by mistake is lost. When markers cannot be told
  // from text, none is removed.
  if (!tokens) return src;
  const ranges = [];
  tokens.forEach((t) => {
    if (t.type === 'html_block' && t.map && t.content.indexOf('MDV-ANCHOR') !== -1) {
      ranges.push([parts.bodyStart + mdvLineOffset(parts.body, t.map[0]), parts.bodyStart + mdvLineOffset(parts.body, t.map[1])]);
    }
  });
  const loc = mdvLocateBlock(src);
  const re = new RegExp(MDV_RE_ANCHOR.source, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (!ids.has(m[1])) continue;
    if (loc && m.index >= loc.start && m.index < loc.end) continue;
    if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    let s = m.index;
    let e = m.index + m[0].length;
    const lineStart = src.lastIndexOf('\n', s - 1) + 1;
    const nl = src.indexOf('\n', e);
    const lineEnd = nl === -1 ? src.length : nl;
    // A marker alone on its line takes its line break with it
    if (/^[ \t]*$/.test(src.slice(lineStart, s)) && /^[ \t\r]*$/.test(src.slice(e, lineEnd))) {
      s = lineStart;
      e = nl === -1 ? src.length : nl + 1;
    }
    if (s < last) continue;
    out += src.slice(last, s);
    last = e;
  }
  return out + src.slice(last);
}

// ------- Anchors in the rendered page -------
// A markdown-it core rule. It numbers every top-level block (data-mdv-block) and gives the block after an
// anchor marker that marker's id (data-mdv-anchor). An attribute travels with its element, so the section
// wrappers built after rendering cannot separate a thread from its block, and a block's number maps it back
// to its source line when a new thread is started.
function mdvAnnotateBlocks(state) {
  let n = 0;
  let pending = [];
  state.tokens.forEach((t) => {
    if (t.level !== 0 || t.nesting === -1) return;
    if (t.type === 'html_block' && mdvIsCommentOnly(t.content)) { pending = pending.concat(mdvMarkerIds(t.content)); return; }
    t.attrSet('data-mdv-block', String(n++));
    if (pending.length) { t.attrSet('data-mdv-anchor', pending.join(' ')); pending = []; }
  });
}

// Puts a block's number and anchors on the first element of HTML that a renderer builds itself, since such HTML
// drops token attributes: raw HTML blocks, and fences drawn by a custom renderer (Mermaid's)
function mdvWithBlockAttrs(html, token) {
  const block = token.attrGet('data-mdv-block');
  if (block == null) return html;
  const anchor = token.attrGet('data-mdv-anchor');
  const attrs = ' data-mdv-block="' + md.utils.escapeHtml(block) + '"' + (anchor ? ' data-mdv-anchor="' + md.utils.escapeHtml(anchor) + '"' : '');
  return html.replace(/^(\s*(?:<!--[\s\S]*?-->\s*)*<[a-zA-Z][\w:-]*)/, (tag) => tag + attrs);
}

if (typeof md !== 'undefined' && md && md.core && md.renderer) {
  md.core.ruler.push('mdv_blocks', mdvAnnotateBlocks);
  const mdvPrevFence = md.renderer.rules.fence;
  if (mdvPrevFence) {
    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
      const out = mdvPrevFence(tokens, idx, options, env, self);
      // markdown-it's own fence renderer already puts them on the <code> inside its <pre>
      if (/^\s*<pre[^>]*>\s*<code[^>]*\sdata-mdv-block=/.test(out)) return out;
      return mdvWithBlockAttrs(out, tokens[idx]);
    };
  }
  const mdvPrevHtmlBlock = md.renderer.rules.html_block;
  md.renderer.rules.html_block = function (tokens, idx, options, env, self) {
    const out = mdvPrevHtmlBlock ? mdvPrevHtmlBlock(tokens, idx, options, env, self) : tokens[idx].content;
    return mdvWithBlockAttrs(out, tokens[idx]);
  };
}

// Map of anchor id -> the element it marks
function mdvBuildAnchorMap(container) {
  const map = Object.create(null); // an id such as "constructor" must not find a built-in property
  if (!container) return map;
  container.querySelectorAll('[data-mdv-anchor]').forEach((el) => {
    String(el.getAttribute('data-mdv-anchor')).split(/\s+/).forEach((id) => { if (id && !map[id]) map[id] = el; });
  });
  // Markers the render could not attach (inside a list or quote, or before raw HTML that starts with text): the next element
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT);
  let node;
  while ((node = walker.nextNode())) {
    const m = node.nodeValue.match(/^\s*MDV-ANCHOR\s+id="([a-zA-Z0-9_-]+)"\s*$/);
    if (!m || map[m[1]]) continue;
    let next = node.nextSibling;
    while (next && next.nodeType !== 1) next = next.nextSibling;
    if (next) map[m[1]] = next;
  }
  return map;
}

// The text of a block as the anchor hashes it: chips excluded, so a second thread on a block sees the same text
function mdvBlockText(el) {
  if (!el) return '';
  const copy = el.cloneNode(true);
  copy.querySelectorAll('.mdv-chip').forEach((c) => c.remove());
  return (copy.textContent || '').trim();
}

// A short, readable label for a block in its thread card: no chips, code headers, MathML twins or SVG styles
function mdvBlockLabel(el) {
  if (!el) return '';
  const copy = el.cloneNode(true);
  copy.querySelectorAll('.mdv-chip, .code-header, .katex-mathml, .header-anchor, .section-toggle, style, script').forEach((c) => c.remove());
  const text = (copy.textContent || '').replace(/\s+/g, ' ').trim();
  if (copy.querySelector('svg')) return text ? 'Diagram: ' + text : 'Diagram';
  return text;
}

// Where a thread's chip goes. A marker sits before a whole list, table, quote or definition list; the thread
// was started on one item inside it, which its blockKind and blockHash (or quote) identify.
function mdvChipHost(el, anchor) {
  if (!el) return null;
  if (el.tagName === 'CODE' && el.parentElement && el.parentElement.tagName === 'PRE') el = el.parentElement;
  if (!/^(TABLE|UL|OL|DL|BLOCKQUOTE)$/.test(el.tagName)) return el;
  const kind = String((anchor && anchor.blockKind) || '').toLowerCase();
  if (/^(p|li|h[1-6]|pre|td|th|dt|dd|blockquote)$/.test(kind) && kind !== el.tagName.toLowerCase()) {
    const candidates = Array.from(el.querySelectorAll(kind));
    if (anchor.blockHash) {
      const hit = candidates.find((c) => mdvHash(mdvNormalize(mdvBlockText(c))) === anchor.blockHash);
      if (hit) return hit;
    }
    const quote = anchor.quote && anchor.quote.exact ? mdvNormalize(anchor.quote.exact) : '';
    if (quote) {
      const hit = candidates.find((c) => mdvNormalize(mdvBlockText(c)).indexOf(quote) !== -1);
      if (hit) return hit;
    }
  }
  if (el.tagName === 'TABLE') return el.querySelector('th, td') || el;
  if (el.tagName === 'UL' || el.tagName === 'OL') return el.querySelector('li') || el;
  if (el.tagName === 'DL') return el.querySelector('dt, dd') || el;
  return el;
}

// ------- Where a new thread's marker goes -------
// True when the text markdown-it renders (after math pre-processing) has the same top-level blocks as the
// source, so a rendered block's number is also its index in the source.
function mdvSameBlocks(body, blocks) {
  if (typeof renderMath !== 'function') return true;
  let processed;
  try { processed = renderMath(body); } catch (e) { return false; }
  if (processed === body) return true;
  const rendered = mdvParseMarkdown(processed);
  if (!rendered) return false;
  const other = mdvTopBlocks(rendered);
  return other.length === blocks.length && other.every((t, i) => t.type === blocks[i].type && t.tag === blocks[i].tag);
}

// Returns {offset, index}: the source offset of the line where the top-level block holding `elem` begins,
// and that block's number. A marker there never splits a list, a table or a quote. Null when unknown.
function mdvLocateInsertion(elem) {
  const src = String(mdvDocText || '');
  const parts = mdvSplitFrontmatter(src);
  if (!parts) return null;
  const tokens = mdvParseMarkdown(parts.body);
  if (!tokens) return null;
  const blocks = mdvTopBlocks(tokens);
  const loc = mdvLocateBlock(src);
  const inBlock = (pos) => !!loc && pos >= loc.start && pos < loc.end; // a marker never goes inside the comment block
  let target = null;
  // A fenced code block carries the number on the <code> inside its <pre>
  const top = elem && elem.closest ? (elem.closest('[data-mdv-block]') || elem.querySelector(':scope > [data-mdv-block]')) : null;
  if (top && mdvSameBlocks(parts.body, blocks)) {
    const t = blocks[Number(top.getAttribute('data-mdv-block'))];
    const tagOk = t && (t.type === 'fence' || t.type === 'code_block' || t.type === 'html_block' || t.tag === top.tagName.toLowerCase());
    if (t && t.map && tagOk) target = t;
  }
  if (!target) {
    // Fallback: the first line of the block's text, found in the source and outside code
    const probe = mdvBlockText(elem).split('\n')[0].trim().slice(0, 48);
    if (probe.length >= 6) {
      const at = parts.body.indexOf(probe);
      if (at !== -1 && !inBlock(parts.bodyStart + at)) {
        const line = parts.body.slice(0, at).split('\n').length - 1;
        target = blocks.find((t) => t.map && t.map[0] <= line && line < t.map[1] && t.type !== 'fence' && t.type !== 'code_block') || null;
      }
    }
  }
  if (!target || !target.map) return null;
  const offset = parts.bodyStart + mdvLineOffset(parts.body, target.map[0]);
  if (inBlock(offset)) return null;
  return { offset, index: blocks.indexOf(target) };
}

// ------- Anchor utilities -------
function mdvShortId() {
  return 'c_' + Math.random().toString(36).slice(2, 12);
}
function mdvNewCommentId() {
  return 'cm_' + Math.random().toString(36).slice(2, 12);
}
function mdvNormalize(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function mdvComputeAnchor(elem, selectionText) {
  const blockText = mdvBlockText(elem);
  const blockHash = mdvHash(mdvNormalize(blockText));
  const sibIdx = Array.from(elem.parentNode ? elem.parentNode.children : []).indexOf(elem);
  const id = mdvShortId();
  let quote = null;
  if (selectionText) {
    const i = blockText.indexOf(selectionText);
    quote = i >= 0
      ? { exact: selectionText, prefix: blockText.slice(Math.max(0, i - 32), i), suffix: blockText.slice(i + selectionText.length, i + selectionText.length + 32) }
      : { exact: selectionText, prefix: '', suffix: '' };
  }
  return { id, blockKind: elem.tagName.toLowerCase(), blockHash, sibIdx, quote };
}

// ------- File handle persistence (IndexedDB) -------
const MDV_DB = 'mdv-viewer';
const MDV_STORE = 'handles';
function mdvOpenDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(MDV_DB, 1);
    r.onupgradeneeded = (e) => e.target.result.createObjectStore(MDV_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function mdvPutHandle(key, h) {
  const db = await mdvOpenDb();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction(MDV_STORE, 'readwrite');
      tx.objectStore(MDV_STORE).put(h, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function mdvGetHandle(key) {
  let db;
  try {
    db = await mdvOpenDb();
    return await new Promise((res, rej) => {
      const r = db.transaction(MDV_STORE, 'readonly').objectStore(MDV_STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch (e) {
    return null;
  } finally {
    if (db) db.close();
  }
}

// ------- The single save seam -------
function mdvIsDesktop() { return !!(window.mdvHost && window.mdvHost.kind === 'desktop'); }

// Each version of a file that the viewer takes as its base by READING it gets a new generation number: opening or
// reloading the file, linking it, and every document load that keeps it linked. The viewer's own writes keep the
// number. A queued save carries the generation its text was made from, and is refused ('stale') once the file was
// read again, so a change made before a reload can never be written over the version the reload showed.
let mdvGen = 0;
// The desktop window's file: {path, text, mtimeMs, gen}. `text` is the version the document on screen was made from;
// `mtimeMs` is the file's mtime when the viewer last read or wrote exactly that text, or null until it has checked.
let mdvDesktopBase = null;
// Comment changes the reader chose to discard ("Reload from disk"): {key, loadSeq}. Their saves end quietly.
const mdvDiscarded = [];
function mdvIsDiscarded(key, loadSeq) { return !!key && mdvDiscarded.some((d) => d.key === key && d.loadSeq === loadSeq); }

// What a save of the current document writes to: the desktop window's file, or a File System Access handle
function mdvCurrentTarget() {
  if (mdvIsDesktop()) {
    const b = mdvDesktopBase;
    return window.mdvHost.currentPath && b && b.path === window.mdvHost.currentPath ? { kind: 'desktop', key: 'desktop', gen: b.gen } : null;
  }
  if (!mdvFileHandle) return null;
  const base = mdvBases.get(mdvFileHandle);
  return { kind: 'handle', handle: mdvFileHandle, key: mdvFileHandle, gen: base ? base.gen : undefined };
}

// THE ONLY FUNCTION THAT WRITES A DOCUMENT.
//   Desktop app: mdvHost.saveDocument(mdvHost.currentPath, text, mtime), with the mtime of the version the viewer read
//   or last wrote. A version it has not checked yet (a new document load, or one the app saw change) is first read
//   with mdvHost.readDocument and compared with the text the document was made from.
//   Browser: the File System Access handle the document was read from, after reading the file and comparing it with
//   the version the viewer read or last wrote.
// On a conflict nothing is written: the reader is told, and the edit stays in memory (the document on screen and the
// notice in the sidebar keep it). opts: {handle, overwrite, disk, gen, loadSeq, version, name}. `overwrite` is only
// ever set by the reader's own choice in a conflict notice, and replaces `disk`, the version that notice showed, and
// no newer one. `gen`, `loadSeq` and `version` say which change of which document the text holds (the save queue
// sets them). Resolves {ok: true} or {ok: false, reason, message}; reason is 'conflict', 'permission', 'no-target',
// 'unverified', 'encoding', 'stale', 'not-allowed' or 'io'. A conflict also carries `disk`, the version found.
let mdvWriteLock = Promise.resolve(); // no two writes ever overlap, whoever calls

async function mdvWriteDocument(text, opts) {
  opts = Object.assign({}, opts);
  text = String(text);
  const desktop = mdvIsDesktop();
  if (!desktop) opts.handle = opts.handle || mdvFileHandle; // the file is the one linked now, not when the write runs
  const ctx = {
    text,
    name: opts.name || mdvDownloadName(),
    handle: desktop ? null : opts.handle,
    key: desktop ? 'desktop' : opts.handle,
    loadSeq: opts.loadSeq != null ? opts.loadSeq : mdvLoadSeq,
    version: opts.version != null ? opts.version : (text === mdvDocText ? mdvDocVersion : -1),
    gen: opts.gen
  };
  const run = mdvWriteLock.then(() => (desktop ? mdvWriteDesktop(text, opts) : mdvWriteHandle(text, opts)));
  mdvWriteLock = run.catch(() => {});
  let res;
  try {
    res = await run;
  } catch (e) {
    res = { ok: false, reason: 'io', message: (e && e.message) || String(e) };
  }
  mdvReportWrite(res, ctx);
  return res;
}

function mdvStale() { return { ok: false, reason: 'stale', message: 'The file was read again after this change was made.' }; }

// Reads the desktop window's file: {doc}, or {res}, the failure to report
async function mdvReadDesktop(path) {
  const host = window.mdvHost;
  if (typeof host.readDocument !== 'function') {
    return { res: { ok: false, reason: 'unverified', message: 'The app cannot read the file back, so the viewer will not overwrite it.' } };
  }
  let doc;
  try {
    doc = await host.readDocument(path);
  } catch (e) {
    return { res: { ok: false, reason: 'io', message: 'The file could not be read: ' + ((e && (e.message || e.code)) || String(e)) } };
  }
  if (!doc || typeof doc.text !== 'string') return { res: { ok: false, reason: 'io', message: 'The file could not be read.' } };
  return { doc };
}

async function mdvWriteDesktop(text, opts) {
  const host = window.mdvHost;
  const path = host.currentPath;
  const base = mdvDesktopBase;
  if (!path || !base || base.path !== path) return { ok: false, reason: 'no-target', message: 'This window has no file to save into.' };
  if (opts.gen != null && opts.gen !== base.gen) return mdvStale();
  let expected = base.mtimeMs;
  if (opts.overwrite || !Number.isFinite(expected) || expected !== host.currentMtimeMs) {
    // A version of the file the viewer has not checked (or one the reader asked to replace): read it first
    const read = await mdvReadDesktop(path);
    if (read.res) return read.res;
    const disk = { text: read.doc.text, mtimeMs: read.doc.mtimeMs };
    const wanted = opts.overwrite ? (opts.disk && typeof opts.disk.text === 'string' ? opts.disk.text : disk.text) : base.text;
    if (disk.text !== wanted) {
      return { ok: false, reason: 'conflict', message: 'The file on disk is not the version the viewer read.', currentMtimeMs: disk.mtimeMs, disk };
    }
    expected = disk.mtimeMs;
  }
  if (!Number.isFinite(expected)) {
    return { ok: false, reason: 'unverified', message: 'The app did not say which version of the file is on disk, so the viewer will not overwrite it.' };
  }
  if (mdvDesktopBase !== base) return mdvStale(); // the window's file was read again while this save waited
  const r = await host.saveDocument(path, text, expected);
  if (r && r.ok) {
    const mtime = Number(r.mtimeMs);
    if (mdvDesktopBase === base) { base.text = text; base.mtimeMs = Number.isFinite(mtime) ? mtime : null; }
    if (Number.isFinite(mtime)) { try { host.currentMtimeMs = mtime; } catch (e) { /* the bridge keeps it itself */ } }
    return { ok: true };
  }
  const res = { ok: false, reason: (r && r.reason) || 'io', message: (r && r.message) || 'The file could not be saved.', currentMtimeMs: r ? r.currentMtimeMs : undefined };
  if (res.reason === 'conflict') {
    // The version the reader is told about, so "Overwrite the file" replaces that one and no newer one
    const read = await mdvReadDesktop(path);
    if (read.doc) {
      res.disk = { text: read.doc.text, mtimeMs: read.doc.mtimeMs };
      if (!Number.isFinite(res.currentMtimeMs)) res.currentMtimeMs = read.doc.mtimeMs;
    }
  }
  return res;
}

// Decodes a file's bytes. A file that is not valid UTF-8 is still shown (invalid bytes become U+FFFD), but `utf8` is
// false and the viewer never writes it: rewriting it would replace those bytes for good. A UTF-8 byte order mark is
// reported (and left out of `text`), so a save can keep it.
function mdvDecode(buffer) {
  const bytes = new Uint8Array(buffer);
  const bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bom, utf8: true };
  } catch (e) {
    return { text: new TextDecoder('utf-8').decode(bytes), bom, utf8: false };
  }
}

// Reads a file through its handle: {file, text, bom, utf8}, or {changing: true} when it keeps changing while it is
// read (Chrome refuses to read a File snapshot of a file that changed after the snapshot was taken)
async function mdvReadHandle(handle) {
  for (let i = 0; i < 3; i++) {
    const file = await handle.getFile();
    try {
      return Object.assign({ file }, mdvDecode(await file.arrayBuffer()));
    } catch (e) {
      if (!e || e.name !== 'NotReadableError') throw e;
    }
  }
  return { changing: true };
}

async function mdvWriteHandle(text, opts) {
  const handle = opts.handle;
  if (!handle) return { ok: false, reason: 'no-target', message: 'There is no file to save into yet.' };
  if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    return { ok: false, reason: 'permission', message: 'The browser has not allowed saving into this file yet.' };
  }
  const base = mdvBases.get(handle);
  if (!base) return { ok: false, reason: 'unverified', message: 'The viewer does not know which version of this file was opened, so it will not overwrite it.' };
  if (opts.gen != null && opts.gen !== base.gen) return mdvStale();
  let bom = false;
  let checked = null;
  if (!base.overwrite) {
    // The file must hold the version this text was made from (for "Overwrite", the version the reader was shown).
    // The text is always compared: a time stamp can stay the same through an edit.
    const disk = await mdvReadHandle(handle);
    if (disk.changing) return { ok: false, reason: 'conflict', message: 'The file kept changing while the viewer read it.', disk: null };
    if (!disk.utf8) {
      return { ok: false, reason: 'encoding', message: '"' + (handle.name || 'The file') + '" is not UTF-8 text, so the viewer will not rewrite it: its other characters would be replaced.' };
    }
    const wanted = opts.overwrite ? (opts.disk && typeof opts.disk.text === 'string' ? opts.disk.text : disk.text) : base.text;
    if (disk.text !== wanted) return { ok: false, reason: 'conflict', message: 'The file on disk is not the version the viewer read.', disk: { text: disk.text } };
    bom = disk.bom;
    checked = disk.file;
  }
  if (mdvBases.get(handle) !== base) return mdvStale(); // the file was read again while this save waited
  const w = await handle.createWritable();
  try {
    await w.write(bom ? '\uFEFF' + text : text);
    // Just before the write lands, the file must still be the one that was checked, and still this version
    const now = checked ? await handle.getFile() : null;
    if (now && (now.lastModified !== checked.lastModified || now.size !== checked.size)) {
      await w.abort();
      return { ok: false, reason: 'conflict', message: 'The file changed on disk while the viewer was saving.', disk: null };
    }
    if (mdvBases.get(handle) !== base) { await w.abort(); return mdvStale(); }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch (_) { /* already closed */ }
    throw e;
  }
  mdvBases.set(handle, { text, gen: base.gen }); // the next save compares the file with this text again
  return { ok: true };
}

// Tells the reader how a write went. A write the reader discarded ("Reload from disk"), or one that a newer read
// of its file made stale, says nothing: the save queue keeps its text when it still matters.
function mdvReportWrite(res, ctx) {
  if (res.reason === 'stale' || mdvIsDiscarded(ctx.key, ctx.loadSeq)) {
    if (mdvWritesQueued <= 1 && !mdvDirty) mdvSetStatus('');
    return;
  }
  const key = ctx.key;
  if (res.ok) {
    // A successful write settles a notice only when it holds every change that notice keeps: the same file, the
    // same document load, and a version at least as new
    if (key) mdvRemoveNotices((n) => n.key === key && (n.kind === 'conflict' || n.kind === 'error') && n.loadSeq === ctx.loadSeq && n.version <= ctx.version);
    mdvSetStatus('Saved ✓');
    clearTimeout(mdvStatusTimer);
    mdvStatusTimer = setTimeout(() => { if (!mdvDirty) mdvSetStatus(''); }, 3000);
    return;
  }
  const notice = { key, name: ctx.name, text: ctx.text, handle: ctx.handle, loadSeq: ctx.loadSeq, version: ctx.version, gen: ctx.gen };
  if (res.reason === 'conflict') {
    mdvSetStatus('Not saved: the file changed on disk', 'error');
    mdvAddNotice(Object.assign(notice, { kind: 'conflict', disk: res.disk || null }));
    mdvToggleSidebar(true);
  } else if (res.reason === 'permission') {
    mdvSetStatus('Not saved: click 📄 or press Cmd/Ctrl+S to allow saving', 'error');
  } else if (res.reason === 'no-target') {
    mdvSetStatus('Not saved: click 📄 or press Cmd/Ctrl+S to choose where to save', 'error');
  } else if (res.reason === 'encoding') {
    mdvSetStatus('Not saved: the file is not UTF-8 text', 'error');
    mdvAddNotice(Object.assign(notice, { kind: 'error', message: res.message, retry: false }));
  } else {
    mdvSetStatus('Not saved', 'error');
    console.error('MDV save failed:', res.reason, res.message);
    mdvAddNotice(Object.assign(notice, { kind: 'error', message: res.message }));
  }
}

// Writes queue up one after another, each bound to the file and the version of it that its text was made from, so
// switching documents cannot send one document's text to another's file, and a reload cannot be overwritten by a
// change made before it. A write that a newer change of the same document load supersedes is skipped.
let mdvWriteChain = Promise.resolve();
let mdvWritesQueued = 0;
const mdvNewestJob = new Map();
let mdvQueuedVersion = {}; // {loadSeq, version} of the newest change handed to the queue

function mdvEnqueueWrite(job) {
  mdvNewestJob.set(job.target.key, job);
  mdvQueuedVersion = { loadSeq: job.loadSeq, version: job.version };
  mdvWritesQueued++;
  mdvSetStatus('Saving…', 'saving');
  const run = mdvWriteChain.then(async () => {
    const newest = mdvNewestJob.get(job.target.key);
    if (newest !== job && newest && newest.loadSeq === job.loadSeq && newest.gen === job.gen) return { ok: true, superseded: true };
    if (newest === job) mdvNewestJob.delete(job.target.key);
    const res = await mdvWriteDocument(job.text, { handle: job.target.handle, name: job.name, gen: job.gen, loadSeq: job.loadSeq, version: job.version });
    const current = job.loadSeq === mdvLoadSeq;
    if (res.ok) {
      if (current && job.version === mdvDocVersion) mdvDirty = false;
    } else if (!mdvIsDiscarded(job.target.key, job.loadSeq)) {
      // The change is not in the file. If its document is still on screen it stays dirty, and leaving it later
      // keeps it in a notice; if the reader already moved on (or the file was read again), keep it in a notice now.
      if (mdvQueuedVersion.loadSeq === job.loadSeq && mdvQueuedVersion.version === job.version) mdvQueuedVersion = {};
      const kept = mdvNotices.some((n) => n.text === job.text);
      if (!current && !kept) mdvAddNotice({ kind: 'unsaved', key: null, name: job.name, text: job.text, loadSeq: job.loadSeq, version: job.version });
    }
    return res;
  });
  mdvWriteChain = run.catch(() => {}).then(() => { mdvWritesQueued--; });
  return run;
}

// Resolves once every queued write has finished
function mdvFlushWrites() { return mdvWriteChain; }

// Called after every comment change: writes the committed document to its file, if it has one
function mdvRequestSave() {
  const target = mdvCurrentTarget();
  if (!target || mdvDocText == null) {
    mdvSetStatus(('showSaveFilePicker' in window)
      ? 'Not saved: click 📄 or press Cmd/Ctrl+S to choose where to save'
      : 'Not saved: press Cmd/Ctrl+S to download a copy with your comments', 'error');
    return Promise.resolve({ ok: false, reason: 'no-target' });
  }
  return mdvEnqueueWrite({ text: mdvDocText, target, name: mdvDownloadName(), loadSeq: mdvLoadSeq, version: mdvDocVersion, gen: target.gen });
}

// Save now (Cmd/Ctrl+S, the toolbar, linking a file). allowPrompt: we are inside a user gesture, so a Save
// dialog or a permission prompt may open.
async function mdvSaveFile(opts) {
  opts = opts || {};
  const allowPrompt = opts.allowPrompt === true;
  if (mdvLockReason) {
    mdvSetStatus('Not saved: comments are read-only for this file', 'error');
    return false;
  }
  if (!mdvIsDesktop()) {
    let handle = mdvFileHandle;
    if (!handle && allowPrompt && 'showSaveFilePicker' in window) handle = await mdvEnsureWritableHandle();
    if (!handle) {
      if (!('showSaveFilePicker' in window)) {
        // Firefox and Safari cannot write into a file: an explicit save downloads a copy; an automatic one never does
        if (allowPrompt) return mdvDownloadFallback();
        mdvSetStatus('Not saved: press Cmd/Ctrl+S to download a copy with your comments', 'error');
        return false;
      }
      mdvSetStatus('Not saved: click 📄 or press Cmd/Ctrl+S to choose where to save', 'error');
      return false;
    }
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if (!allowPrompt) {
        mdvSetStatus('Not saved: click 📄 or press Cmd/Ctrl+S to allow saving', 'error');
        return false;
      }
      try {
        if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
          mdvSetStatus('Not saved: permission denied', 'error');
          return false;
        }
      } catch (e) {
        mdvSetStatus('Not saved: permission required', 'error');
        return false;
      }
    }
  }
  const res = await mdvRequestSave();
  return !!(res && res.ok);
}

// The file name of the current document, for downloads and the Save dialog
function mdvDownloadName() {
  const name = String(mdvDocName || currentFileName || 'document').trim() || 'document';
  return /\.[a-z0-9]{1,10}$/i.test(name) ? name : name + '.md';
}

function mdvDownloadText(text, name) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name || 'document.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function mdvDownloadFallback() {
  mdvDownloadText(mdvDocText == null ? rawMarkdown : mdvDocText, mdvDownloadName());
  mdvDirty = false; // the comments are safe in the downloaded copy
  mdvSetStatus('Downloaded a copy: replace the original with it to keep your comments');
  return true;
}

function mdvSetStatus(text, kind) {
  const el = document.getElementById('mdvSaveStatus');
  if (!el) return;
  el.style.display = text ? '' : 'none';
  el.textContent = text;
  el.className = 'mdv-save-status' + (kind === 'saving' ? ' mdv-status-saving' : (kind === 'error' ? ' mdv-status-error' : ''));
}

// ------- Notices: what the reader must decide about, shown at the top of the sidebar -------
let mdvNotices = [];
let mdvNoticeSeq = 0;

function mdvAddNotice(n) {
  // A newer notice replaces an older one only when it holds every change of that one: the same file, the same
  // document load, and a version at least as new
  const holdsAll = (x) => n.key && x.key === n.key && x.loadSeq === n.loadSeq && x.version >= 0 && n.version >= x.version;
  mdvNotices = mdvNotices.filter((x) => !holdsAll(x));
  n.id = 'mdvn' + (++mdvNoticeSeq);
  mdvNotices.push(n);
  mdvRenderNotices();
}

function mdvRemoveNotices(pred) {
  const before = mdvNotices.length;
  mdvNotices = mdvNotices.filter((n) => !pred(n));
  if (mdvNotices.length !== before) mdvRenderNotices();
}

function mdvNoticeButton(label, onClick, primary) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mdv-btn' + (primary ? ' mdv-btn-primary' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function mdvNoticeElement(n) {
  const box = document.createElement('div');
  box.className = 'mdv-notice mdv-notice-' + n.kind;
  box.setAttribute('role', n.kind === 'locked' ? 'status' : 'alert');
  box.style.cssText = 'margin:10px 12px 0;padding:10px 12px;border-radius:var(--radius-sm,6px);' +
    'border:1px solid var(--accent-warn,#C4873B);background:color-mix(in srgb,var(--accent-warn,#C4873B) 11%,var(--bg-card,#fff));' +
    'color:var(--text-primary,#2C2F3A);font:0.8rem/1.5 var(--font-ui,sans-serif)';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:3px';
  const text = document.createElement('div');
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px';
  const name = '"' + (n.name || 'this file') + '"';
  const current = mdvNoticeIsCurrent(n);
  if (n.kind === 'locked') {
    title.textContent = 'Comments are read-only for this file';
    text.textContent = n.lockKind === 'encoding'
      ? name + ' is not UTF-8 text. Saving comments would replace its other characters, so the viewer never writes it. ' +
        'Save it as UTF-8 in a text editor, then open it again.'
      : 'The comment block of ' + name + ' could not be read: ' + n.reason +
        '. It is kept exactly as it is, so nothing is lost. Fix or remove it in a text editor, then open the file again.';
  } else if (n.kind === 'conflict') {
    title.textContent = 'Not saved: the file changed on disk';
    text.textContent = name + ' on disk is not the version the viewer opened: another program changed it, or it is a different file. ' +
      'Your comment changes are kept here until you choose:';
    // Reloading or overwriting is for the document on screen; an earlier one's changes can be downloaded
    if (current) actions.appendChild(mdvNoticeButton('Reload from disk', () => mdvNoticeReload(n)));
    actions.appendChild(mdvNoticeButton('Download my version', () => mdvDownloadText(n.text, n.name)));
    if (current) actions.appendChild(mdvNoticeButton('Overwrite the file', () => mdvNoticeOverwrite(n), true));
    else actions.appendChild(mdvNoticeButton('Dismiss', () => mdvRemoveNotices((x) => x.id === n.id)));
  } else if (n.kind === 'unsaved') {
    title.textContent = 'Comment changes not saved';
    text.textContent = name + ' was closed or read again before its comment changes were saved into a file.';
    actions.appendChild(mdvNoticeButton('Download ' + (n.name || 'it'), () => mdvDownloadText(n.text, n.name), true));
    actions.appendChild(mdvNoticeButton('Dismiss', () => mdvRemoveNotices((x) => x.id === n.id)));
  } else {
    title.textContent = 'Not saved';
    text.textContent = (n.message || 'The file could not be saved.') + ' Your comment changes are kept here.';
    if (current && n.retry !== false) actions.appendChild(mdvNoticeButton('Try again', () => mdvRequestSave(), true));
    actions.appendChild(mdvNoticeButton('Download my version', () => mdvDownloadText(n.text, n.name)));
    actions.appendChild(mdvNoticeButton('Dismiss', () => mdvRemoveNotices((x) => x.id === n.id)));
  }
  box.appendChild(title);
  box.appendChild(text);
  if (actions.childNodes.length) box.appendChild(actions);
  return box;
}

function mdvRenderNotices() {
  const list = document.getElementById('mdvThreadList');
  if (!list || !list.parentNode) return;
  let area = document.getElementById('mdvNotices');
  if (!area) {
    area = document.createElement('div');
    area.id = 'mdvNotices';
    area.style.flexShrink = '0';
    list.parentNode.insertBefore(area, list);
  }
  area.textContent = '';
  const items = (mdvLockReason ? [{ kind: 'locked', lockKind: mdvLockKind, name: mdvDocName, reason: mdvLockReason }] : []).concat(mdvNotices);
  area.style.display = items.length ? '' : 'none';
  items.forEach((n) => area.appendChild(mdvNoticeElement(n)));
}

// True when a notice is about the document on screen: the same document load, and its file is the save target
function mdvNoticeIsCurrent(n) {
  if (n.loadSeq !== mdvLoadSeq) return false;
  return mdvIsDesktop() ? n.key === 'desktop' : (!!n.handle && n.handle === mdvFileHandle);
}

async function mdvNoticeReload(n) {
  if (!confirm('Show the version on disk? Your unsaved comment changes will be discarded (use "Download my version" first to keep them).')) return;
  const wasDirty = mdvDirty;
  const seq = mdvLoadSeq;
  mdvDirty = false; // the reader chose to discard them: the reload must not keep them as "unsaved"
  mdvRemoveNotices((x) => x.id === n.id);
  let ok = false;
  try { ok = await mdvReloadFromDisk(); } catch (e) { ok = false; }
  if (ok) {
    // The changes of that document load are discarded: its saves still queued or running end quietly
    mdvDiscarded.push({ key: n.key, loadSeq: n.loadSeq });
    mdvRemoveNotices((x) => x.key === n.key && x.loadSeq === n.loadSeq && (x.kind === 'conflict' || x.kind === 'error'));
    return;
  }
  // Nothing is discarded when the file's version could not be shown
  if (mdvLoadSeq === seq) mdvDirty = wasDirty;
  mdvAddNotice(n);
  mdvShowToast(mdvLoadSeq === seq
    ? 'The file could not be read again; your comment changes are still here.'
    : 'The file was read again but could not be shown; your comment changes are kept in the comments panel.', 'error');
}

async function mdvNoticeOverwrite(n) {
  if (!confirm('Replace ' + (n.name ? '"' + n.name + '"' : 'the file') + ' on disk with your version? Changes made to it in the other program will be lost.')) return;
  const res = await mdvWriteDocument(n.text, { handle: n.handle, overwrite: true, disk: n.disk, name: n.name, loadSeq: n.loadSeq, version: n.version });
  if (res.ok) {
    mdvRemoveNotices((x) => x.id === n.id);
    if (mdvNoticeIsCurrent(n) && n.text === mdvDocText) mdvDirty = false;
  }
}

// Reads the current document again from its file and shows it. False when it could not be read or shown.
async function mdvReloadFromDisk() {
  if (mdvIsDesktop()) {
    const host = window.mdvHost;
    if (!host.currentPath) return false;
    const read = await mdvReadDesktop(host.currentPath);
    if (read.res) return false;
    const doc = read.doc;
    try { host.currentMtimeMs = doc.mtimeMs; } catch (e) { /* the bridge keeps it itself */ }
    rawMarkdown = doc.text;
    currentFileName = doc.name || currentFileName;
    try {
      renderMarkdown(doc.text, doc.name || mdvDocName);
    } catch (e) {
      console.warn('MDV: the version on disk could not be shown:', e);
      return false;
    }
    // The version just read is the window's file: the next save needs no second read
    if (mdvDesktopBase && mdvDesktopBase.text === doc.text && Number.isFinite(doc.mtimeMs)) mdvDesktopBase.mtimeMs = doc.mtimeMs;
    return true;
  }
  if (!mdvFileHandle) return false;
  try {
    return await mdvOpenWithHandle(mdvFileHandle, { prompt: false });
  } catch (e) {
    console.warn('MDV: the version on disk could not be read or shown:', e);
    return false;
  }
}

// ------- Opening files and linking them for saving -------
const MDV_PICKER_TYPES = [{ description: 'Markdown', accept: { 'text/plain': ['.md', '.markdown', '.txt'] } }];

async function mdvPickFile() {
  if (mdvIsDesktop()) {
    if (typeof window.mdvHost.openDialog === 'function') await window.mdvHost.openDialog();
    return;
  }
  if (!('showOpenFilePicker' in window)) {
    mdvShowToast('This browser cannot save into a file. Open the file, then press Cmd/Ctrl+S to download a copy with your comments.', 'error');
    const input = document.getElementById('fileInput');
    if (input) input.click();
    return;
  }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ multiple: false, types: MDV_PICKER_TYPES });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw e;
  }
  await mdvOpenWithHandle(handle);
}

// Opens a file through its handle and links the document to it. opts.prompt === false: never ask for
// permission (no user gesture, e.g. the startup restore). opts.ifSeq: give up if another document was opened
// since that load count.
async function mdvOpenWithHandle(handle, opts) {
  opts = opts || {};
  let perm = 'prompt';
  try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* treat as not granted */ }
  if (perm !== 'granted' && opts.prompt !== false) {
    try { perm = await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { /* stays read-only */ }
    if (perm !== 'granted') mdvShowToast('Opened read-only: comments will not save into this file.', 'error');
  }
  const disk = await mdvReadHandle(handle);
  if (disk.changing) {
    mdvShowToast('"' + (handle.name || 'The file') + '" kept changing while it was read. Try again in a moment.', 'error');
    return false;
  }
  if (opts.ifSeq != null && opts.ifSeq !== mdvLoadSeq) return false;
  // A file that is not UTF-8 is shown, and its comments are read-only (see the renderMarkdown hook)
  mdvBases.set(handle, { text: disk.text, gen: ++mdvGen, notUtf8: !disk.utf8 });
  mdvFileHandle = handle;
  rawMarkdown = disk.text;
  currentFileName = disk.file.name;
  renderMarkdown(disk.text, disk.file.name);
  mdvPutHandle('current', handle).catch(() => { /* remembering it is a convenience; IndexedDB may be off */ });
  if (perm !== 'granted') mdvSetStatus('Read-only: press Cmd/Ctrl+S to allow saving into this file', 'error');
  return true;
}

// True when the document on screen was read from a file (drag-and-drop, the Open button, a ?file= link or a
// handle). Pasted text and the demo were not: they have no file of their own.
function mdvDocHasFile() { return mdvDocTitle !== 'Pasted Content' && mdvDocTitle !== 'Demo Document'; }

// Gives the document on screen a writable file. Runs inside a user gesture (Chromium blocks a dialog otherwise).
// Returns the handle (now also in mdvFileHandle and IndexedDB), or null.
//   - A document read from a file links only to that file: the reader picks it in an Open dialog, and the first save
//     checks that it still holds the version that was opened. A file changed since, or a different file, is never
//     overwritten; the conflict notice lets the reader decide. (A Save dialog cannot be used for this: the browser
//     empties the file picked there before the viewer could check it.)
//   - A document with no file of its own (pasted text, the demo) gets a new file from a Save dialog.
async function mdvEnsureWritableHandle() {
  if (mdvIsDesktop()) return null;
  if (mdvFileHandle) {
    if ((await mdvFileHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      try {
        const p = await mdvFileHandle.requestPermission({ mode: 'readwrite' });
        if (p !== 'granted') return null;
      } catch (e) { return null; }
    }
    return mdvFileHandle;
  }
  if (mdvLockReason) {
    mdvSetStatus('Not saved: comments are read-only for this file', 'error');
    return null;
  }
  return mdvDocHasFile() ? mdvLinkOpenedFile() : mdvSaveAsNewFile();
}

async function mdvLinkOpenedFile() {
  if (!('showOpenFilePicker' in window)) return null;
  const seq = mdvLoadSeq;
  const opened = mdvLoadedText;
  mdvShowToast('Choose "' + mdvDownloadName() + '", the file this document was opened from, so comments save into it.');
  let h;
  try {
    [h] = await window.showOpenFilePicker({ multiple: false, types: MDV_PICKER_TYPES });
  } catch (e) {
    if (e.name !== 'AbortError') console.error('mdvLinkOpenedFile error:', e);
    return null;
  }
  let perm = 'prompt';
  try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { /* not granted */ }
  if (perm !== 'granted') {
    try { perm = await h.requestPermission({ mode: 'readwrite' }); } catch (e) { /* not granted */ }
  }
  if (perm !== 'granted') {
    mdvSetStatus('Not saved: the browser did not allow saving into ' + (h.name || 'that file'), 'error');
    return null;
  }
  if (seq !== mdvLoadSeq || mdvFileHandle) return null; // another document was opened, or a file linked, meanwhile
  mdvBases.set(h, { text: opened, gen: ++mdvGen }); // the version that was opened: the first save compares the file with it
  mdvFileHandle = h;
  mdvPutHandle('current', h).catch(() => {});
  return h;
}

async function mdvSaveAsNewFile() {
  if (!('showSaveFilePicker' in window)) return null;
  const seq = mdvLoadSeq;
  let h;
  try {
    h = await window.showSaveFilePicker({ suggestedName: mdvDownloadName(), types: MDV_PICKER_TYPES });
  } catch (e) {
    if (e.name !== 'AbortError') console.error('mdvSaveAsNewFile error:', e);
    return null;
  }
  if (seq !== mdvLoadSeq || mdvFileHandle) return null;
  mdvBases.set(h, { overwrite: true, gen: ++mdvGen }); // the reader chose this file (and confirmed replacing it) in the dialog
  mdvFileHandle = h;
  mdvPutHandle('current', h).catch(() => {});
  return h;
}

// ----- Workspace folder (pick once; files opened from it link without a prompt) -----
async function mdvPickWorkspace() {
  if (mdvIsDesktop()) {
    mdvShowToast('The desktop app saves every file in place; no workspace folder is needed.');
    return null;
  }
  if (!('showDirectoryPicker' in window)) {
    mdvShowToast('This browser does not support workspace folders. Use Chrome, Edge or Brave.', 'error');
    return null;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return null;
    console.error(e);
    return null;
  }
  if ((await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const p = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') {
      mdvShowToast('Workspace permission denied.', 'error');
      return null;
    }
  }
  mdvWorkspaceDir = dirHandle;
  try { await mdvPutHandle('workspace', dirHandle); } catch (e) { /* remembered for this session only */ }
  mdvShowToast('Workspace set to "' + dirHandle.name + '". Files opened from it save without a prompt.');
  // Link the open document if this folder holds the same file: same name AND the same contents
  if (mdvDocName && !mdvFileHandle && mdvLoadedText != null) {
    const seq = mdvLoadSeq;
    const fh = (await mdvMatchInFolder(dirHandle, mdvDocName, mdvLoadedText)).handle;
    if (fh && seq === mdvLoadSeq && !mdvFileHandle) {
      mdvFileHandle = fh;
      mdvPutHandle('current', fh).catch(() => {});
      await mdvSaveFile({ allowPrompt: false });
    } else if (!fh) {
      mdvShowToast('"' + mdvDocName + '" was not linked: this folder has no file with that name and the same contents.', 'error');
    }
  }
  return dirHandle;
}

// Looks for `name` in `dir`. {handle} only when that file is UTF-8 text holding exactly `text` (its version becomes
// the save base); {differs: true} when a file of that name holds something else (notUtf8 when it is not UTF-8 text);
// {} when there is none.
async function mdvMatchInFolder(dir, name, text) {
  let h;
  try { h = await dir.getFileHandle(name); } catch (e) { return {}; }
  try {
    const disk = await mdvReadHandle(h);
    if (disk.changing) return { differs: true };
    if (!disk.utf8) return { differs: true, notUtf8: true };
    if (disk.text !== text) return { differs: true };
    mdvBases.set(h, { text: disk.text, gen: ++mdvGen });
    return { handle: h };
  } catch (e) {
    return { differs: true };
  }
}

// Called when a file arrives by drag-and-drop or the file input. Links it to the workspace file of the same
// name only when the contents are identical, so a different file that happens to share the name (another
// folder's README.md) can never be overwritten. `text` defaults to the document being loaded: the loader sets
// rawMarkdown before it calls this.
async function mdvTryWorkspaceMatch(filename, text) {
  const expected = typeof text === 'string' ? text : rawMarkdown;
  if (!mdvWorkspaceDir || !filename) return null;
  try {
    if ((await mdvWorkspaceDir.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
  } catch (e) { return null; }
  const match = await mdvMatchInFolder(mdvWorkspaceDir, filename, expected);
  if (match.differs) {
    mdvShowToast('"' + filename + '" in your workspace folder ' + (match.notUtf8 ? 'is not UTF-8 text' : 'has different contents') +
      ', so this copy was not linked to it.', 'error');
  }
  return match.handle || null;
}

// Toolbar button: link the open document to its file, or open a file (writable). A browser that cannot write
// files, and a document whose comments are read-only, get the file chooser: nothing can be saved into a file there.
async function mdvOpenOrSetSaveLocation() {
  if (mdvIsDesktop() || !('showOpenFilePicker' in window)) return mdvPickFile();
  if (rawMarkdown && !mdvFileHandle && !mdvLockReason) {
    const h = await mdvEnsureWritableHandle();
    if (h) {
      mdvShowToast('Linked to ' + (h.name || 'the file') + ': comments save into it.');
      // A file picked in the Open dialog already holds the document; a new one from the Save dialog is empty
      const base = mdvBases.get(h);
      if (mdvDirty || (base && base.overwrite)) await mdvSaveFile({ allowPrompt: false });
    }
    return;
  }
  await mdvPickFile();
}

// ------- Restore the workspace and the last-opened file at startup -------
// Never in the desktop app (the window's own document is authoritative), never over an explicit ?file= link
// or #demo, and never over a document opened while the restore was running.
window.addEventListener('load', async () => {
  if (mdvIsDesktop()) return;
  try {
    const ws = await mdvGetHandle('workspace');
    if (ws && (await ws.queryPermission({ mode: 'read' })) === 'granted') mdvWorkspaceDir = ws;
  } catch (e) { /* ignore */ }
  const url = new URL(window.location.href);
  const linked = url.searchParams.get('file');
  if (!linked && url.hash === '#demo') return;
  if (rawMarkdown) return;
  const seq = mdvLoadSeq;
  try {
    const handle = await mdvGetHandle('current');
    if (!handle) return;
    // A ?file= link wins. On file:// it cannot load at all, so the remembered file of that very name stands in.
    if (linked && !(window.location.protocol === 'file:' && handle.name === linked.split('/').pop())) return;
    if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') return;
    if (seq !== mdvLoadSeq || rawMarkdown) return;
    await mdvOpenWithHandle(handle, { prompt: false, ifSeq: seq });
  } catch (e) { /* IndexedDB or the file is unavailable */ }
});

// ------- UI -------
function mdvShowToast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'mdv-toast' + (kind === 'error' ? ' mdv-toast-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
}

function mdvEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mdvThreadTree() {
  const byId = Object.create(null); // ids come from the file: "__proto__" must be an ordinary key
  mdvComments.forEach((c) => {
    if (c && typeof c === 'object' && c.id != null) byId[c.id] = Object.assign({}, c, { replies: [] });
  });
  const roots = [];
  Object.values(byId).forEach((c) => {
    if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(c);
    else if (!c.parent_id) roots.push(c);
  });
  const sortFn = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));
  roots.sort(sortFn);
  Object.values(byId).forEach((c) => c.replies.sort(sortFn));
  return roots;
}

function mdvToggleSidebar(force) {
  const sb = document.getElementById('mdvSidebar');
  if (!sb) return;
  const willOpen = (force === true) || (force == null && !sb.classList.contains('open'));
  sb.classList.toggle('open', willOpen);
  document.body.classList.toggle('mdv-sidebar-open', willOpen);
  const btn = document.getElementById('mdvToggleBtn');
  if (btn) btn.classList.toggle('mdv-active', willOpen);
  sb.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
}

function mdvRenderSidebar() {
  const list = document.getElementById('mdvThreadList');
  if (!list) return;
  mdvRenderNotices();
  const status = document.getElementById('mdvSidebarStatus');
  // Keep what the reader is typing in a reply box (and where) across the redraw
  const drafts = {};
  let focused = null;
  list.querySelectorAll('.mdv-thread').forEach((card) => {
    const box = card.querySelector('.mdv-reply-input');
    if (!box) return;
    if (box.value) drafts[card.dataset.threadId] = box.value;
    if (document.activeElement === box) focused = { id: card.dataset.threadId, start: box.selectionStart, end: box.selectionEnd };
  });
  list.innerHTML = '';
  const roots = mdvThreadTree();
  if (roots.length === 0) {
    list.innerHTML = mdvLockReason
      ? '<div class="mdv-empty">No comments can be shown or added for this file.</div>'
      : '<div class="mdv-empty">No comments yet.<br>Right-click any paragraph or select text to add one.</div>';
    if (status) status.textContent = '';
  } else if (status) {
    status.textContent = roots.length + ' thread' + (roots.length === 1 ? '' : 's');
  }
  const idMap = mdvBuildAnchorMap(document.getElementById('mdBody'));
  roots.forEach((thread) => {
    const card = document.createElement('div');
    card.className = 'mdv-thread' + (thread.status === 'resolved' ? ' mdv-resolved' : '');
    // The list is a column flexbox of fixed height and a card hides its overflow: without this, cards shrink
    // to fit once there are several, and their reply box and buttons are cut off.
    card.style.flexShrink = '0';
    card.dataset.threadId = thread.id;
    const host = thread.anchor && mdvChipHost(idMap[thread.anchor.id], thread.anchor);
    const isOrphan = !host && !!thread.anchor;
    if (isOrphan) card.classList.add('mdv-orphan');
    card.innerHTML = mdvRenderThreadCard(thread, isOrphan, host);
    list.appendChild(card);
    const ta = card.querySelector('.mdv-reply-input');
    if (ta && drafts[thread.id]) ta.value = drafts[thread.id];
    if (ta && focused && focused.id === String(thread.id)) {
      ta.focus();
      try { ta.setSelectionRange(focused.start, focused.end); } catch (e) { /* not a text selection */ }
    }
    const replyBtn = card.querySelector('.mdv-reply-btn');
    if (replyBtn) replyBtn.onclick = () => mdvPostReply(thread.id, ta);
    if (ta) ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') mdvPostReply(thread.id, ta);
    });
    const resBtn = card.querySelector('.mdv-resolve-btn');
    if (resBtn) resBtn.onclick = () => mdvResolveThread(thread.id);
    const delBtn = card.querySelector('.mdv-delete-btn');
    if (delBtn) delBtn.onclick = () => mdvDeleteThread(thread.id);
    if (host) {
      const quote = card.querySelector('.mdv-quote');
      if (quote) {
        quote.style.cursor = 'pointer';
        quote.title = 'Show in the document';
        quote.addEventListener('click', () => host.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
    }
  });
  mdvRenderChips(idMap);
  const badge = document.getElementById('mdvBadge');
  if (badge) {
    const open = roots.filter((t) => t.status !== 'resolved').length;
    badge.textContent = open || '';
    badge.style.display = open ? '' : 'none';
  }
  // Show the toggle button now that a document is loaded
  const tgl = document.getElementById('mdvToggleBtn');
  if (tgl) tgl.style.display = '';
}

function mdvRenderThreadCard(thread, isOrphan, host) {
  // The quote: the selected text; else the start of the block the thread is on
  let quote = (thread.anchor && thread.anchor.quote && thread.anchor.quote.exact) || '';
  if (!quote && host) quote = mdvBlockLabel(host);
  if (!quote) quote = '(block)';
  let html = '<div class="mdv-thread-head">';
  html += '<div class="mdv-quote' + (isOrphan ? ' mdv-quote-orphan' : '') + '">' + mdvEscape(quote.length > 140 ? quote.slice(0, 139) + '…' : quote) + '</div>';
  html += '</div>';
  html += '<div class="mdv-replies">';
  html += mdvRenderCommentBody(thread);
  thread.replies.forEach((r) => { html += mdvRenderCommentBody(r); });
  html += '</div>';
  if (thread.status !== 'resolved') {
    html += '<div class="mdv-reply-row">';
    html += '<textarea class="mdv-reply-input" placeholder="Reply… (Cmd+Enter to send)"></textarea>';
    html += '<div class="mdv-reply-actions">';
    html += '<button class="mdv-btn mdv-delete-btn" title="Delete thread">Delete</button>';
    html += '<button class="mdv-btn mdv-resolve-btn">Resolve</button>';
    html += '<button class="mdv-btn mdv-btn-primary mdv-reply-btn">Reply</button>';
    html += '</div></div>';
  } else {
    html += '<div class="mdv-reply-row"><div class="mdv-reply-actions">';
    html += '<button class="mdv-btn mdv-resolve-btn">Reopen</button>';
    html += '</div></div>';
  }
  return html;
}

function mdvRenderCommentBody(c) {
  const author = c.author && c.author.name != null ? c.author.name : 'Anon';
  const kind = String((c.author && c.author.kind) || 'human').replace(/[^a-zA-Z0-9_-]/g, '');
  const when = c.created_at ? new Date(c.created_at).toLocaleString() : '';
  return '<div class="mdv-comment mdv-kind-' + mdvEscape(kind) + '" data-comment-id="' + mdvEscape(c.id) + '">' +
         '<div class="mdv-author"><span class="mdv-author-name">' + mdvEscape(author) + '</span>' +
         '<span class="mdv-when">' + mdvEscape(when) + '</span></div>' +
         '<div class="mdv-body">' + mdvEscape(c.body_md || '') + '</div></div>';
}

function mdvRenderChips(idMap) {
  document.querySelectorAll('.mdv-chip').forEach((c) => c.remove());
  idMap = idMap || mdvBuildAnchorMap(document.getElementById('mdBody'));
  // Find every host before adding any chip: a chip inside a block would change the text the next one hashes
  const placed = mdvThreadTree()
    .filter((t) => t.anchor)
    .map((t) => ({ thread: t, host: mdvChipHost(idMap[t.anchor.id], t.anchor) }))
    .filter((p) => p.host);
  placed.forEach(({ thread, host }) => {
    const count = 1 + thread.replies.length;
    const chip = document.createElement('span');
    chip.className = 'mdv-chip' + (thread.status === 'resolved' ? ' mdv-chip-resolved' : '');
    chip.textContent = '💬 ' + count;
    chip.title = 'Open thread';
    chip.dataset.threadId = thread.id;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', 'Comment thread, ' + count + ' message' + (count === 1 ? '' : 's'));
    chip.onclick = (e) => { e.stopPropagation(); mdvFocusThread(thread.id); };
    host.appendChild(chip);
  });
}

function mdvFocusThread(id) {
  mdvToggleSidebar(true);
  setTimeout(() => {
    const card = document.querySelector('.mdv-thread[data-thread-id="' + CSS.escape(String(id)) + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid rgb(107,143,113)';
      setTimeout(() => { card.style.outline = ''; }, 1200);
    }
  }, 80);
}

// Refuses a change while the comment block cannot be read; returns true when it refused
function mdvRefuseIfLocked() {
  if (!mdvLockReason) return false;
  mdvShowToast(mdvLockKind === 'encoding'
    ? 'Comments are read-only for this file: it is not UTF-8 text.'
    : 'Comments are read-only for this file: its comment block could not be read.', 'error');
  return true;
}

// True while another document is being opened: its loader has replaced rawMarkdown but the page still shows this
// document, so a change now would mix the two
function mdvDocumentChanging() { return rawMarkdown !== mdvDocText; }

// Refuses a change while another document is being opened; returns true when it refused
function mdvRefuseIfChanging() {
  if (!mdvDocumentChanging()) return false;
  mdvShowToast('Another document is being opened, so nothing was changed.', 'error');
  return true;
}

// Every comment change goes through here: the new list and the source that holds it change together
function mdvCommit(text, comments) {
  rawMarkdown = text;
  mdvComments = comments;
  mdvDocText = text;
  mdvDocVersion++;
  mdvDirty = true;
}

// Commits a change whose new source `makeText` builds, or tells the reader why it could not be stored (mdvSerialize
// refuses rather than lose text). Returns true when the change was made.
function mdvApplyChange(makeText, comments) {
  let text;
  try {
    text = makeText();
  } catch (e) {
    mdvShowToast('Nothing was changed: ' + ((e && e.message) || e), 'error');
    return false;
  }
  mdvCommit(text, comments);
  return true;
}

// ------- Add comment popup -------
async function mdvShowAddPopup(elem, selectionText) {
  if (mdvRefuseIfLocked()) return;
  document.querySelectorAll('.mdv-add-popup').forEach((p) => p.remove());
  const rect = elem.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'mdv-add-popup';
  pop.innerHTML = '<div class="mdv-add-head">Add comment</div>' +
                  '<textarea class="mdv-add-input" placeholder="Type your comment… (Cmd+Enter to save, Esc to cancel)"></textarea>' +
                  '<div class="mdv-add-actions">' +
                  '<button class="mdv-btn mdv-add-cancel">Cancel</button>' +
                  '<button class="mdv-btn mdv-btn-primary mdv-add-save">Save</button></div>';
  // The popup is position:absolute, so it is placed in page coordinates, kept inside the visible part of the
  // page. (Clamping against the window height alone put it near the top of a long page, and focusing it then
  // scrolled the reader away from the block they were commenting on.)
  const left = Math.min(window.scrollX + window.innerWidth - 340, Math.max(window.scrollX + 8, rect.left + window.scrollX));
  const top = Math.max(window.scrollY + 8, Math.min(window.scrollY + window.innerHeight - 200, rect.bottom + window.scrollY + 6));
  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';
  document.body.appendChild(pop);
  const ta = pop.querySelector('textarea');
  ta.focus({ preventScroll: true });
  pop.querySelector('.mdv-add-cancel').onclick = () => pop.remove();
  const seq = mdvLoadSeq; // the document this popup belongs to
  let saving = false;
  pop.querySelector('.mdv-add-save').onclick = async () => {
    if (saving) return;
    const body = ta.value.trim();
    if (!body) { pop.remove(); return; }
    // Another document replaced this one while the reader typed: no dialog may link a file to the wrong document
    if (seq !== mdvLoadSeq || !elem.isConnected || mdvDocumentChanging()) {
      mdvShowToast('The document changed while you were typing; your text is still in the box.', 'error');
      return;
    }
    saving = true;
    try {
      // Get a writable file inside the click's user gesture, so a dialog may open
      if (!mdvIsDesktop() && !mdvFileHandle && ('showOpenFilePicker' in window || 'showSaveFilePicker' in window)) {
        const h = await mdvEnsureWritableHandle();
        if (!h) {
          mdvShowToast('Not saved: no file was chosen. Your comment is still in the box.', 'error');
          return; // the popup stays open with the text
        }
      }
      await mdvAddComment(elem, selectionText, body);
      pop.remove(); // only now: if adding failed, the typed text is still here
      await mdvFlushWrites();
    } catch (e) {
      console.error('MDV add comment failed:', e);
      mdvShowToast('The comment was not added: ' + ((e && e.message) || e), 'error');
    } finally {
      saving = false;
    }
  };
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') pop.querySelector('.mdv-add-save').click();
    if (e.key === 'Escape') pop.remove();
  });
}

async function mdvAddComment(elem, selectionText, body) {
  if (mdvLockReason) throw new Error('comments are read-only for this file');
  // The block must still be on the page: if the document was reloaded or replaced while the reader typed,
  // its position would point into a different text.
  if (!elem || !elem.isConnected || mdvDocumentChanging()) throw new Error('the document changed while you were typing; your text is still in the box');
  const anchor = mdvComputeAnchor(elem, selectionText);
  const src = String(mdvDocText || '');
  const at = mdvLocateInsertion(elem);
  const withMarker = at ? src.slice(0, at.offset) + mdvMarker(anchor.id) + mdvEol(src) + src.slice(at.offset) : src;
  const now = new Date().toISOString();
  const comment = {
    id: mdvNewCommentId(),
    parent_id: null,
    anchor: anchor,
    author: { name: mdvAuthorName, kind: 'human' },
    body_md: String(body),
    created_at: now,
    updated_at: now,
    status: 'open'
  };
  const next = mdvComments.concat([comment]);
  mdvCommit(mdvSerialize(withMarker, next), next); // throws before changing anything if the block is unreadable
  // Attach the thread on the page directly: no re-render, so the reader keeps their place
  const live = at && document.querySelector('#mdBody [data-mdv-block="' + at.index + '"]');
  if (live) {
    live.setAttribute('data-mdv-anchor', ((live.getAttribute('data-mdv-anchor') || '') + ' ' + anchor.id).trim());
  } else if (at) {
    mdvRerender();
  } else {
    console.warn('MDV: could not place an anchor marker for', anchor.id, '— the thread is saved unattached.');
    mdvShowToast('Saved, but its place in the file could not be marked, so the thread is listed as unattached.', 'error');
  }
  mdvRenderSidebar();
  mdvToggleSidebar(true);
  mdvFocusThread(comment.id);
  mdvRequestSave();
  return comment;
}

function mdvPostReply(threadId, textareaEl) {
  const body = (textareaEl.value || '').trim();
  if (!body || mdvRefuseIfLocked() || mdvRefuseIfChanging()) return;
  const now = new Date().toISOString();
  const next = mdvComments.concat([{
    id: mdvNewCommentId(),
    parent_id: threadId,
    author: { name: mdvAuthorName, kind: 'human' },
    body_md: body,
    created_at: now,
    updated_at: now,
    status: 'open'
  }]);
  if (!mdvApplyChange(() => mdvSerialize(mdvDocText, next), next)) return;
  textareaEl.value = '';
  mdvRenderSidebar();
  mdvRequestSave();
}

function mdvResolveThread(threadId) {
  if (mdvRefuseIfLocked() || mdvRefuseIfChanging()) return;
  const now = new Date().toISOString();
  let found = false;
  const next = mdvComments.map((c) => {
    if (!c || c.id !== threadId) return c;
    found = true;
    return Object.assign({}, c, { status: c.status === 'resolved' ? 'open' : 'resolved', updated_at: now });
  });
  if (!found) return;
  if (!mdvApplyChange(() => mdvSerialize(mdvDocText, next), next)) return;
  mdvRenderSidebar();
  mdvRequestSave();
}

function mdvDeleteThread(threadId) {
  if (mdvRefuseIfLocked()) return;
  if (!confirm('Delete this thread? It will be permanently removed.')) return;
  if (mdvRefuseIfChanging()) return;
  const root = mdvComments.find((c) => c && c.id === threadId);
  // The thread and every reply under it
  const gone = new Set([threadId]);
  let grew = true;
  while (grew) {
    grew = false;
    mdvComments.forEach((c) => {
      if (c && c.parent_id != null && gone.has(c.parent_id) && !gone.has(c.id)) { gone.add(c.id); grew = true; }
    });
  }
  const next = mdvComments.filter((c) => !(c && gone.has(c.id)));
  const anchorIds = new Set();
  if (root && root.anchor && root.anchor.id && !next.some((c) => c && c.anchor && c.anchor.id === root.anchor.id)) {
    anchorIds.add(root.anchor.id);
  }
  if (!mdvApplyChange(() => mdvSerialize(mdvRemoveMarkers(mdvDocText, anchorIds), next), next)) return;
  anchorIds.forEach((id) => {
    document.querySelectorAll('#mdBody [data-mdv-anchor]').forEach((el) => {
      const rest = el.getAttribute('data-mdv-anchor').split(/\s+/).filter((x) => x && x !== id);
      if (rest.length) el.setAttribute('data-mdv-anchor', rest.join(' '));
      else el.removeAttribute('data-mdv-anchor');
    });
  });
  mdvRenderSidebar();
  mdvRequestSave();
}

// Re-renders the current document in place (its comments are already in rawMarkdown), keeping the scroll
function mdvRerender() {
  const y = window.scrollY;
  mdvOwnRender = true;
  try { renderMarkdown(rawMarkdown, mdvDocTitle || mdvDocName); } finally { mdvOwnRender = false; }
  window.scrollTo(0, y);
}

// ------- Right-click + selection UX -------
const MDV_BLOCK_TAGS = ['P','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','TD','TH','DT','DD'];

function mdvFindBlock(node) {
  let el = node && (node.nodeType === 3 ? node.parentElement : node);
  while (el && !MDV_BLOCK_TAGS.includes(el.tagName)) el = el.parentElement;
  return el;
}

function mdvAttachContextMenu() {
  const content = document.getElementById('mdBody');
  if (!content || content.__mdvWired) return;
  content.__mdvWired = true;
  content.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return; // shift-right-click yields native menu
    const elem = mdvFindBlock(e.target);
    if (!elem) return;
    e.preventDefault();
    const sel = window.getSelection();
    const selText = sel && !sel.isCollapsed ? sel.toString().trim() : null;
    mdvShowContextMenu(e.clientX, e.clientY, elem, selText);
  });
}

// Wire mouseup ONCE at document level (not on every render) so we can
// guard against the popover-self-click case.
if (!window.__mdvMouseupWired) {
  window.__mdvMouseupWired = true;
  document.addEventListener('mouseup', (e) => {
    // Don't re-evaluate selection when the click landed inside any MDV UI:
    // the popover/menu/popup/sidebar handles its own actions and we must
    // not destroy them or reset selection here.
    if (e.target && e.target.closest && e.target.closest(
      '.mdv-sel-popover, .mdv-add-popup, .mdv-ctx-menu, .mdv-sidebar'
    )) return;
    mdvHandleSelection();
  });
}

function mdvShowContextMenu(x, y, elem, selectionText) {
  document.querySelectorAll('.mdv-ctx-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'mdv-ctx-menu';
  menu.innerHTML = '<button class="mdv-ctx-item">💬 Add comment' + (selectionText ? ' on selection' : '') + '</button>';
  menu.style.left = Math.min(window.innerWidth - 200, x) + 'px';
  menu.style.top = Math.min(window.innerHeight - 60, y) + 'px';
  document.body.appendChild(menu);
  menu.querySelector('button').onclick = () => {
    menu.remove();
    mdvShowAddPopup(elem, selectionText);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', function close(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
    });
  }, 10);
}

function mdvHandleSelection() {
  // Tear down any existing popover before we decide whether to re-show.
  document.querySelectorAll('.mdv-sel-popover').forEach((p) => p.remove());
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const mdBody = document.getElementById('mdBody');
  if (!mdBody || !mdBody.contains(range.commonAncestorContainer)) return;
  const text = sel.toString().trim();
  if (text.length < 3) return;
  // Capture geometry + the element + text NOW (closure) — selection may collapse
  // by the time the user clicks the popover, but our captured values stay valid.
  const elem = mdvFindBlock(range.startContainer);
  if (!elem) return;
  const rect = range.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'mdv-sel-popover';
  pop.textContent = '💬 Comment';
  pop.style.left = (rect.left + window.scrollX) + 'px';
  pop.style.top = (rect.top + window.scrollY - 36) + 'px';
  // Stop the mousedown that would (a) deselect the text and (b) also bubble to
  // the document mousedown cleaner. We still allow click to fire on this elem.
  pop.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.remove();
    mdvShowAddPopup(elem, text);
  });
  document.body.appendChild(pop);
}

// ------- Keyboard shortcut -------
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+Shift+C — toggle comments sidebar
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault();
    mdvToggleSidebar();
  }
  // Ctrl/Cmd+S — save (prompt for location if no handle yet)
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    if (rawMarkdown) {
      e.preventDefault();
      mdvSaveFile({ allowPrompt: true });
    }
  }
});

// Leaving the page with comment changes that are not in a file yet asks first
function mdvHasUnsavedWork() {
  return mdvDirty || mdvWritesQueued > 0 || mdvNotices.some((n) => n.kind !== 'locked');
}
window.addEventListener('beforeunload', (e) => {
  if (!mdvHasUnsavedWork()) return;
  e.preventDefault();
  e.returnValue = '';
});

// ------- Hook into renderMarkdown: every document load starts here -------
// A new document resets the per-document state. Its comments come from its source; if the previous
// document had comment changes that never reached a file, they are kept in a notice to download.
function mdvBeginDocument(source, title) {
  const queued = mdvQueuedVersion.loadSeq === mdvLoadSeq && mdvQueuedVersion.version === mdvDocVersion;
  const kept = mdvNotices.some((n) => n.text === mdvDocText);
  if (mdvDirty && mdvDocText != null && !queued && !kept) {
    mdvAddNotice({ kind: 'unsaved', key: null, name: mdvDownloadName(), text: mdvDocText });
  }
  mdvLoadSeq++;
  mdvDocVersion = 0;
  mdvDirty = false;
  mdvDocTitle = title;
  mdvDocName = String(title || currentFileName || 'document.md').split('/').pop();
  mdvDocText = source;
  mdvLoadedText = source;
  if (mdvIsDesktop()) {
    // The window's file as far as this document goes: the first save reads the file and compares it with this
    // text, so a document that is not the file's (pasted, or opened some other way) is never written over it
    mdvDesktopBase = { path: window.mdvHost.currentPath || null, text: source, mtimeMs: null, gen: ++mdvGen };
  }
  // A document is only linked to the file it was read from. A loader that left an older file linked is
  // caught here, before a comment save could write this document over that file.
  if (mdvFileHandle) {
    const base = mdvBases.get(mdvFileHandle);
    if (!base) {
      mdvBases.set(mdvFileHandle, { text: source, gen: ++mdvGen }); // checked against the file before the first write
    } else if (base.overwrite || base.text !== source) {
      mdvFileHandle = null;
      mdvSetStatus('Not linked to a file: click 📄 to choose where comments save', 'error');
    } else {
      // The same file shown again: saves still queued from the earlier load are stale
      mdvBases.set(mdvFileHandle, Object.assign({}, base, { gen: ++mdvGen }));
    }
  }
}

// Comments are read-only for a linked file that is not UTF-8 text: a save would replace its other characters
function mdvEncodingLock() {
  const base = mdvFileHandle ? mdvBases.get(mdvFileHandle) : null;
  return base && base.notUtf8 ? { kind: 'encoding', reason: 'it is not UTF-8 text' } : null;
}

(function () {
  const orig = window.renderMarkdown;
  window.renderMarkdown = function (source, title) {
    source = String(source == null ? '' : source);
    if (!mdvOwnRender) mdvBeginDocument(source, title);
    const parsed = mdvParseFile(source);
    mdvComments = parsed.comments;
    const wasLocked = mdvLockReason;
    const lock = parsed.parseError ? { kind: 'block', reason: parsed.parseError } : mdvEncodingLock();
    mdvLockReason = lock ? lock.reason : null;
    mdvLockKind = lock ? lock.kind : null;
    if (lock && (!mdvOwnRender || !wasLocked)) {
      mdvShowToast(lock.kind === 'encoding'
        ? 'Comments are read-only for this file: it is not UTF-8 text, so the viewer never rewrites it.'
        : 'Comments are read-only for this file: its comment block could not be read (' + lock.reason + ').', 'error');
    }
    // The markers stay in the source, so they render as DOM comments and data-mdv-anchor attributes. The sidebar
    // follows the document even when rendering it fails part way.
    try {
      orig(source, title);
    } finally {
      setTimeout(() => {
        mdvAttachContextMenu();
        mdvRenderSidebar();
      }, 50);
    }
  };
})();

// #mdBody survives every render (only its contents are replaced), so the right-click menu is wired once, now,
// rather than after the first render
mdvAttachContextMenu();

// A document rendered before this script loaded (the #demo page) is rendered again through the hook
if (rawMarkdown) {
  const titleEl = document.getElementById('titleText');
  window.renderMarkdown(rawMarkdown, (titleEl && titleEl.textContent) || 'Untitled');
}

// Handlers used by the toolbar markup, and the save seam for the desktop bridge
window.mdvPickFile = mdvPickFile;
window.mdvPickWorkspace = mdvPickWorkspace;
window.mdvOpenOrSetSaveLocation = mdvOpenOrSetSaveLocation;
window.mdvToggleSidebar = mdvToggleSidebar;
window.mdvSaveFile = mdvSaveFile;
window.mdvWriteDocument = mdvWriteDocument;
