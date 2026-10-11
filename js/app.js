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
// One table drives both the key handler and the help sheet (?), so the sheet cannot drift from the keys.
// mod: Ctrl or Cmd (both are accepted on every platform). key: the character with no modifiers, matched
// case-insensitively, so Caps Lock does not matter. shift: the shortcut needs Shift; checked for letters
// only, because some layouts need Shift just to type a punctuation key. code: the physical key, also
// accepted, for punctuation that other layouts move (Mod+\ on a German keyboard). Rows without `run` are
// handled elsewhere (comments.js, the dialogs) and are listed so the sheet is complete.
const MDV_IS_MAC = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

const MDV_SHORTCUTS = [
  { mod: true, key: 'k', label: 'Search', modal: 'searchOverlay',
    run: () => (mdvModal && mdvModal.el.id === 'searchOverlay') ? closeSearch() : openSearch() },
  { mod: true, key: 'b', label: 'Show or hide the outline', run: () => toggleToc() },
  { mod: true, key: '\\', code: 'Backslash', label: 'Toggle page width', run: () => toggleWidth() },
  { mod: true, key: '.', code: 'Period', label: 'Focus mode', run: () => toggleFocus() },
  { mod: true, shift: true, key: 'f', label: 'Fold or unfold all sections', run: () => toggleAllSections() },
  { mod: true, shift: true, key: 'r', label: 'Read aloud', run: () => ttsToggle() },
  { mod: true, key: 'o', label: 'Open a file', run: () => document.getElementById('fileInput').click() },
  { key: '?', label: 'Shortcuts help', modal: 'shortcutsOverlay', run: () => toggleShortcuts() },
  { mod: true, shift: true, key: 'c', label: 'Comments' },
  { mod: true, key: 's', label: 'Save comments into the file' },
  { key: 'Esc', label: 'Close dialog' },
];

// The key as a lower-case character, so Caps Lock and Shift do not change it. When a layout's letters
// are not Latin (e.key is then, say, Cyrillic) the physical key decides, as it does for the browser's own
// shortcuts.
function mdvTypedKey(e) {
  const k = e.key || '';
  if (k.length !== 1) return k;
  const lower = k.toLowerCase();
  if (/[a-z]/.test(lower)) return lower;
  if (/\p{L}/u.test(k) && /^Key[A-Z]$/.test(e.code || '')) return e.code.slice(3).toLowerCase();
  return lower;
}

function mdvShortcutMatches(e, s) {
  if (!s.run || !!s.mod !== (e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (/^[a-z]$/.test(s.key) && !!s.shift !== e.shiftKey) return false;
  return mdvTypedKey(e) === s.key || (!!s.code && e.code === s.code);
}

// Typing in a text field is not a shortcut. A checkbox (task lists) or a button is not a text field.
function mdvIsTextEntry(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(t.type);
}

function openShortcuts() {
  mdvRenderShortcutSheet();
  mdvOpenModal(document.getElementById('shortcutsOverlay'), { labelledBy: 'mdvShortcutsTitle' });
}
function closeShortcuts() { mdvCloseModal(document.getElementById('shortcutsOverlay')); }
function toggleShortcuts() { (mdvModal && mdvModal.el.id === 'shortcutsOverlay') ? closeShortcuts() : openShortcuts(); }

function mdvShortcutKeys(s) {
  const keys = [];
  if (s.mod) keys.push(MDV_IS_MAC ? '⌘' : 'Ctrl');
  if (s.shift) keys.push(MDV_IS_MAC ? '⇧' : 'Shift');
  keys.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return keys;
}

// Draws the help sheet from MDV_SHORTCUTS, in the platform's own key names (⌘ on a Mac, Ctrl elsewhere).
function mdvRenderShortcutSheet() {
  const box = document.querySelector('#shortcutsOverlay .shortcuts-box');
  if (!box || box.dataset.rendered) return;
  box.dataset.rendered = 'true';
  const title = document.createElement('h3');
  title.id = 'mdvShortcutsTitle';
  title.textContent = 'Keyboard Shortcuts';
  const rows = MDV_SHORTCUTS.map(s => {
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    const label = document.createElement('span');
    label.textContent = s.label;
    const keys = document.createElement('span');
    mdvShortcutKeys(s).forEach((k, i) => {
      if (i) keys.append('+');
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      keys.appendChild(kbd);
    });
    row.append(label, keys);
    return row;
  });
  const foot = document.createElement('div');
  foot.className = 'shortcut-row';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = 'Close';
  close.addEventListener('click', closeShortcuts);
  foot.append(document.createElement('span'), close);
  box.replaceChildren(title, ...rows, foot);
}

document.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return; // an input method is composing a character
  if (e.key === 'Escape') {
    if (mdvModal) { e.preventDefault(); mdvCloseModal(mdvModal.el); }
    else mdvHideMobileToc();
    return;
  }
  // While a dialog is open only its own toggle works: Mod+K closes search, ? closes the help sheet.
  if (mdvModal) {
    const own = MDV_SHORTCUTS.find(s => s.modal === mdvModal.el.id && mdvShortcutMatches(e, s));
    if (own) { e.preventDefault(); own.run(); }
    return;
  }
  if (mdvIsTextEntry(e.target)) return;
  const s = MDV_SHORTCUTS.find(x => mdvShortcutMatches(e, x));
  if (s) { e.preventDefault(); s.run(); }
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

