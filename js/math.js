// ============================================
// Math: $...$ and $$...$$, parsed by markdown-it and typeset by KaTeX
// ============================================
// Dollar math follows Pandoc's rules (its tex_math_dollars extension):
// - Inline math is $...$. The opening $ must be followed by a non-space character, and the closing
//   $ must be preceded by one and must not be followed by a digit. The first unescaped $ after the
//   opener decides: if it cannot close, the text is not math. So "costs $5 and $10" stays text.
// - Display math is $$...$$: inside a paragraph, or as a block that starts a line with $$ and ends
//   a later line with $$. It may not contain a blank line.
// - \$ is a literal dollar sign, inside math and outside it.
// Math is a markdown-it rule, so it never applies inside code: a code span or code block is parsed
// before any dollar sign in it is seen, and inline math may not contain a backtick (a code span
// that starts inside a would-be formula wins). HTML comments win the same way: a comment on its own
// line is a block, never inline text, and inline math may not contain "<!--", so a narration or
// comment marker that mentions dollars is left alone even after a lone $ ("$x <!-- y$ -->").

function mdvIsMathSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D;
}

function mdvIsMathDigit(code) {
  return code >= 0x30 && code <= 0x39;
}

// Whether src has an HTML comment opening, "<!--", at pos.
function mdvIsCommentStart(src, pos) {
  return src.charCodeAt(pos) === 0x3C && src.startsWith('!--', pos + 1);
}

// Index of the first unescaped "$$" at or after `from` and before `max`, or -1.
function mdvFindDoubleDollar(src, from, max) {
  for (let pos = from; pos < max - 1; pos++) {
    const code = src.charCodeAt(pos);
    if (code === 0x5C) { pos++; continue; }
    if (code === 0x24 && src.charCodeAt(pos + 1) === 0x24) return pos;
  }
  return -1;
}

function mdvMathInline(state, silent) {
  const src = state.src;
  const start = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(start) !== 0x24) return false;

  // $$...$$ inside a paragraph: display math.
  if (src.charCodeAt(start + 1) === 0x24) {
    const close = mdvFindDoubleDollar(src, start + 2, max);
    if (close < 0) return false;
    const tex = src.slice(start + 2, close);
    if (!tex.trim() || tex.includes('`') || tex.includes('<!--')) return false;
    if (!silent) {
      const token = state.push('math_inline_display', 'math', 0);
      token.content = tex;
      token.markup = '$$';
    }
    state.pos = close + 2;
    return true;
  }

  // $...$: Pandoc's rules.
  if (start + 1 >= max || mdvIsMathSpace(src.charCodeAt(start + 1))) return false;
  let pos = start + 1;
  while (pos < max) {
    const code = src.charCodeAt(pos);
    if (code === 0x5C) { pos += 2; continue; }   // an escaped character, \$ included, never closes
    if (code === 0x60) return false;             // a backtick: code spans win over math
    if (mdvIsCommentStart(src, pos)) return false;   // so do HTML comments
    if (code === 0x24) break;
    pos++;
  }
  if (pos >= max) return false;
  if (mdvIsMathSpace(src.charCodeAt(pos - 1))) return false;
  if (pos + 1 < max && mdvIsMathDigit(src.charCodeAt(pos + 1))) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = src.slice(start + 1, pos);
    token.markup = '$';
  }
  state.pos = pos + 1;
  return true;
}

// A display block: a line that starts with $$, up to the first line that ends with $$.
// $$ x $$ on one line is a block too. Anything else starting with $$ is left to the paragraph.
function mdvMathBlock(state, startLine, endLine, silent) {
  const src = state.src;
  const lineText = (line) => src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;   // an indented code block
  const first = lineText(startLine);
  if (!first.startsWith('$$')) return false;
  const afterOpen = first.slice(2).trimEnd();

  let tex;
  let closeLine = startLine;
  if (afterOpen.endsWith('$$') && afterOpen.length > 2) {
    tex = afterOpen.slice(0, -2);
    if (mdvFindDoubleDollar(tex, 0, tex.length) >= 0) return false;
  } else {
    if (mdvFindDoubleDollar(afterOpen, 0, afterOpen.length) >= 0) return false;
    const lines = [afterOpen];
    let found = false;
    for (let line = startLine + 1; line < endLine; line++) {
      if (state.isEmpty(line)) return false;                           // no blank lines in display math
      if (state.sCount[line] < state.blkIndent) return false;          // the enclosing block ended
      const text = lineText(line).trimEnd();
      const close = mdvFindDoubleDollar(text, 0, text.length);
      if (close >= 0) {
        if (close !== text.length - 2) return false;                   // $$ in the middle of a line
        lines.push(text.slice(0, -2));
        closeLine = line;
        found = true;
        break;
      }
      lines.push(text);
    }
    if (!found) return false;
    tex = lines.join('\n');
  }
  if (!tex.trim()) return false;
  if (silent) return true;

  state.line = closeLine + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = tex;
  token.markup = '$$';
  token.map = [startLine, state.line];
  return true;
}

// KaTeX output, or the TeX source as code when KaTeX did not load (render.js reports that once).
// trust stays false: \href, \url, \includegraphics and \html* commands are not available.
function mdvTypeset(tex, displayMode) {
  const source = tex.trim();
  if (typeof katex === 'undefined' || typeof katex.renderToString !== 'function') {
    const fence = displayMode ? '$$' : '$';
    return '<code class="mdv-math-source">' + md.utils.escapeHtml(fence + source + fence) + '</code>';
  }
  try {
    return katex.renderToString(source, { displayMode, throwOnError: false });
  } catch (err) {
    return '<code class="mdv-math-source" title="' + md.utils.escapeHtml(String(err && err.message)).replace(/"/g, '&quot;') + '">' +
      md.utils.escapeHtml(source) + '</code>';
  }
}

function mdvMathPlugin(markdown) {
  markdown.block.ruler.before('fence', 'math_block', mdvMathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  markdown.inline.ruler.before('escape', 'math_inline', mdvMathInline);
  markdown.renderer.rules.math_inline = (tokens, idx) => mdvTypeset(tokens[idx].content, false);
  markdown.renderer.rules.math_inline_display = (tokens, idx) => mdvTypeset(tokens[idx].content, true);
  // A display block is a paragraph holding the display formula, as it was before math moved into
  // markdown-it: the same spacing, and comments and read-aloud treat it as a paragraph.
  markdown.renderer.rules.math_block = (tokens, idx) => '<p class="mdv-math-display">' + mdvTypeset(tokens[idx].content, true) + '</p>\n';
}

try {
  md.use(mdvMathPlugin);
} catch (err) {
  console.warn('math: markdown-it is not available', err);
}
