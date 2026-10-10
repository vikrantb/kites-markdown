// ============================================
// Scroll + progress
// ============================================
window.addEventListener('scroll', () => {
  const st = window.scrollY;
  const dh = document.body.scrollHeight - window.innerHeight;
  const pct = dh > 0 ? (st / dh) * 100 : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  const fabUp = document.getElementById('fabUp');
  const fabDown = document.getElementById('fabDown');
  if (fabUp) fabUp.classList.toggle('hidden', st < 200);
  if (fabDown) fabDown.classList.toggle('hidden', st > dh - 200);
}, { passive: true });

// ============================================
// Keyboard shortcuts
// ============================================
function closeShortcuts() { document.getElementById('shortcutsOverlay').classList.remove('show'); }

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;

  // Don't capture if typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') { closeSearch(); closeShortcuts(); }
    return;
  }

  if (mod && e.key === 'k') { e.preventDefault(); document.getElementById('searchOverlay').classList.contains('show') ? closeSearch() : openSearch(); }
  if (mod && e.key === 'b') { e.preventDefault(); toggleToc(); }
  if (mod && e.key === '\\') { e.preventDefault(); toggleWidth(); }
  if (mod && e.key === '.') { e.preventDefault(); toggleFocus(); }
  if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); toggleAllSections(); }
  if (mod && e.shiftKey && e.key === 'R') { e.preventDefault(); ttsToggle(); }
  if (mod && e.key === 'o') { e.preventDefault(); document.getElementById('fileInput').click(); }
  if (e.key === '?' && !mod) {
    e.preventDefault();
    const ov = document.getElementById('shortcutsOverlay');
    ov.classList.contains('show') ? closeShortcuts() : ov.classList.add('show');
  }
  if (e.key === 'Escape') { closeSearch(); closeShortcuts(); closeLightbox(); }
});

// ============================================
// Init
// ============================================
setTheme(currentTheme);
applyFontSize();
loadFromUrl();

// ============================================
// Demo content
// ============================================
function loadDemo() {
  const demo = `# Markdown Viewer Demo

Welcome to the **Advanced Markdown Viewer**. This demo showcases all features.

## Text Formatting

Regular text with **bold**, *italic*, ~~strikethrough~~, ==highlighted==, ~subscript~, ^superscript^, and \`inline code\`.

> Blockquotes support **nested** formatting and multiple paragraphs.
>
> Like this second paragraph.

## Lists & Tasks

- Item one
  - Nested item A
  - Nested item B
- Item two

### Task Lists
- [x] Complete the markdown parser
- [x] Add syntax highlighting
- [ ] Ship to production

## Code

\`\`\`javascript
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

const sequence = Array.from({ length: 10 }, (_, i) => fibonacci(i));
console.log(sequence);
\`\`\`

\`\`\`python
def fibonacci():
    """Infinite Fibonacci generator."""
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b

gen = fibonacci()
print([next(gen) for _ in range(10)])
\`\`\`

## Tables

| Feature | Status | Priority |
|---------|--------|----------|
| Markdown rendering | Done | High |
| Mermaid diagrams | Done | High |
| TTS narration | Done | High |
| Section collapse | Done | Medium |
| Focus mode | Done | Medium |

## Diagrams with Narration

<!-- narrate: This flowchart shows the document processing pipeline. A file is opened, then parsed as markdown, then rendered as HTML with syntax highlighting, table of contents, and mermaid diagrams. Finally scroll spy is initialized. -->

\`\`\`mermaid
graph TD
    A[Open File] --> B{Parse Markdown}
    B --> C[Render HTML]
    C --> D[Build TOC]
    C --> E[Render Mermaid]
    C --> F[Highlight Code]
    D --> G[Scroll Spy]
    E --> G
    F --> G
    G --> H[Ready!]
\`\`\`

The \`<!-- narrate: ... -->\` comment above the mermaid block provides a spoken description for TTS. It's invisible in every markdown viewer except this one.

## Math

Inline: $E = mc^2$

Block:

$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$

## Collapsible Sections

<details>
<summary>Click to expand</summary>

Hidden content with **formatting**, \`code\`, and lists:

- Item A
- Item B

\`\`\`json
{ "hidden": true, "expandable": true }
\`\`\`
</details>

## Keyboard Shortcuts

Press \`?\` to see all shortcuts. Key ones:

- **Ctrl+K** Search
- **Ctrl+B** Toggle TOC
- **Ctrl+\\\\** Toggle width
- **Ctrl+.** Focus mode
- **Ctrl+Shift+R** Read aloud (TTS)

## TTS Narration Format

To make diagrams, tables, or images speakable, add an HTML comment before them:

\`\`\`markdown
<!-- narrate: This diagram shows the auth flow from login to token. -->
\\\`\\\`\\\`mermaid
graph LR
    Login --> Validate --> Token
\\\`\\\`\\\`
\`\`\`

The \`<!-- narrate: -->\` comment is a standard HTML comment, invisible in GitHub, VS Code, Obsidian, and every other viewer. Only this viewer extracts it for TTS.

## Links

Links are auto-detected by type and enhanced with icons, tooltips, and more. Hover any link to see.

**Inline links** (different types):
- GitHub: [marked.js](https://github.com/markedjs/marked) for markdown parsing
- npm: [markdown-it](https://www.npmjs.com/package/markdown-it) plugin ecosystem
- Docs: [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web) reference
- Email: [hello@example.com](mailto:hello@example.com) for feedback
- Internal: [Jump to Code section](#code)
- File: [README.md](./README.md)
- External: [Example Site](https://example.com)

**Standalone links** become rich cards:

[https://github.com/markedjs/marked](https://github.com/markedjs/marked)

[https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis)

Use the **links panel** (chain icon in toolbar) to see all links indexed by type.

---

## Footnotes

Text with a footnote[^1].

[^1]: This is the footnote content.

---

*End of demo. Open your own files or use \`?file=path/to/file.md\` in the URL.*
`;
  rawMarkdown = demo;
  renderMarkdown(demo, 'Demo Document');
}

