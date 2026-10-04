# Legacy viewer: `md_viewer.html`

An earlier, smaller single-file viewer, kept for reference. It is **superseded** by
[`../markdown-viewer.html`](../markdown-viewer.html) and is not maintained.

Two of its ideas are not yet in the main viewer and are worth porting: **Copy AI export** and an
explicit **author** choice (`me` / `ai`) on every comment. Its use of DOMPurify to sanitize rendered
HTML is a third. See [`docs/legacy-viewer.md`](../docs/legacy-viewer.md) for a full comparison.

> **Its comment format is not compatible with the main viewer.** This one writes one
> `<!-- MDV-COMMENT {...} -->` line per comment directly after the commented block. The main viewer
> writes `<!-- MDV-ANCHOR id="…" -->` markers plus a single trailing `<!-- MDV-COMMENTS:v1 … -->`
> block. Neither shows the other's comments. The main viewer leaves this viewer's lines untouched,
> but **opening a main-viewer file here and saving it corrupts the file**: this viewer mistakes the
> `<!-- MDV-COMMENTS:v1` line for one of its own, shows the JSON payload as document text, and drops
> that opening line on save.

Unlike the main viewer, this one loads its libraries from public CDNs (DOMPurify, marked and
highlight.js from cdnjs; Mermaid `@10` from jsdelivr), so it needs a network connection.

---

## What it does

Local-first Markdown / Mermaid viewer that lets you **right-click a block to comment**, save the
comments **inline in the source file**, and round-trip the file with an AI agent.

- Renders `.md` / `.markdown` / `.mmd` files with marked (GFM) and draws fenced `mermaid` blocks as
  diagrams. A `.mmd` file is treated as markdown, so a bare Mermaid file with no fence is shown as
  text.
- Code blocks are styled, but syntax highlighting is configured through marked's `highlight`
  option, which marked removed in v8.0.0. The loaded version is 12 and nothing else calls
  highlight.js, so code is not highlighted.
- Right-click a top-level heading / paragraph / blockquote / code block / table → "Comment on
  this". On touch screens, long-press (480 ms) opens the same menu. Lists, diagrams and horizontal
  rules cannot be commented (see Anchoring).
- Comments support a **markdown body** (links + images; there is also an Image URL field)
- Each comment carries a **timestamp** + **author** identity (`me` or `ai`); the last choice is
  remembered in `localStorage` (`mdv.author`)
- **Reply** to a top-level comment; threads are one reply deep
- **Resolve** / reopen a top-level comment; a **hide resolved** checkbox (on by default) filters
  them out. Comments cannot be deleted from the UI.
- Right rail shows one card per commented block (its first visible top-level comment and the
  block's message count); with **hide resolved** on, resolved comments are left out. Click a card
  to jump to its block and expand its thread
- "Save" writes back to the original file when it was opened with the **Open file** button in a
  Chromium browser (File System Access API). Files opened any other way, or in other browsers, are
  downloaded as a copy instead. "Save as…" picks a new file.
- "Copy AI export" puts a plaintext rendering of the comments on the clipboard so you can paste it
  straight into an AI assistant's prompt
- ⌘S / Ctrl-S to save; warns on unsaved close
- A font-size slider (12 to 22 px)

## How AI agents see your comments

1. **Direct file read.** Any AI with file access reads the markdown and sees the
   `<!-- MDV-COMMENT … -->` lines inline. Each line is a single JSON object with
   `v / id / author / ts / parent / body`, plus `resolved / resolvedTs` once resolved, easy to parse
   with a regex.
2. **Clipboard export.** Click "Copy AI export" and paste into your prompt. The dump is grouped by
   anchor (with the first 200 characters of the block), parent → replies, plain text. It includes
   resolved comments, marked `[resolved]`.

## How AI agents reply

1. **You paste.** Copy the AI's answer, click the comment's "Reply" button, **change Author to
   `ai`**, paste, post, save.
2. **The agent edits the file.** Have the AI append `<!-- MDV-COMMENT {...,"author":"ai",...} -->`
   lines immediately after the relevant block (a reply sets `"parent"` to the top-level comment's
   `id`). Re-open the file to see the reply rendered.

## Storage format

```markdown
This is a paragraph that I commented on.
<!-- MDV-COMMENT {"v":1,"id":"cmt-abc123","author":"me","ts":"2026-01-01T10:00:00Z","parent":null,"body":"thinking about this"} -->
<!-- MDV-COMMENT {"v":1,"id":"cmt-def456","author":"ai","ts":"2026-01-01T10:05:00Z","parent":"cmt-abc123","body":"good catch — see [docs](https://example.com)"} -->

The next paragraph (no comments).
```

On save, the viewer writes each block's comment lines directly after the block's last line. The
lines are hidden in normal markdown renders, AI-readable, and need no sidecar files, backend
service or auth.

> **Caution.** Comment JSON is written without escaping. A comment body containing `-->` ends the
> HTML comment early and leaves the rest of the JSON as visible text in the file.

## Anchoring

Comments anchor by **source position**. The viewer splits the source on blank lines and files each
comment under the most recent block; when rendering, it numbers top-level headings, paragraphs,
blockquotes, code blocks and tables in order and shows the comments of block *n* on element *n*.

- Edits to the text inside a block keep its comments attached, as long as the block stays one
  blank-line-separated chunk.
- If a commented block is deleted, its comment lines attach to the block before them the next time
  the file is opened. Comments above the first block are kept in the file but never shown.
- The two counts disagree when the document contains a list, a horizontal rule, a Mermaid diagram,
  a raw HTML block, a code block with blank lines inside, or a paragraph followed by a list or table
  with no blank line between. After such an element, comments are shown on, and new comments are
  saved after, the wrong block.

## Browser compatibility

| Feature | Chromium (Chrome/Edge/Brave) | Safari / Firefox |
|---|---|---|
| Open file | ✓ via `showOpenFilePicker` (writable handle); drag-and-drop gives no handle | ✓ via `<input type=file>` or drag-and-drop (read-only) |
| Save in place | ✓ for files opened with **Open file** or **Save as…**; otherwise downloads | Falls back to download |
| Comment / reply / resolve | ✓ | ✓ (state lives in memory until you download) |

## Privacy

Loading the page fetches four scripts and one stylesheet from public CDNs (DOMPurify, marked,
highlight.js and its `github` theme from cdnjs; Mermaid from jsdelivr). Images referenced by the
document or by comments are loaded from their URLs. The file's text and your comments are not sent
anywhere.
