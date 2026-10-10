# Roadmap

Where the project is going, what has been decided, and what is still open. Read this first when
starting a new working session; [architecture.md](architecture.md) is the code map.

## Vision

> Enable advanced markdown visualizations in the most beautiful and clean way. Optimized for
> **reading and understanding** markdown. Very useful to anyone.

This is a reader, not an editor. Every feature should make a document easier to take in: diagrams
drawn from text, math typeset, structure made navigable, and discussion kept next to the words it
is about. The markdown stays portable: anything the viewer adds must be invisible to other
renderers.

## Decisions already made (2026-10-04)

| Decision | Detail |
|---|---|
| Public, MIT | `LICENSE`; third-party licenses in `../THIRD_PARTY_NOTICES.md` |
| Product-neutral | No knowledge of any other product, organisation or private path anywhere in the repo |
| Fresh history | A single import commit. Earlier history is summarized as engineering lessons in [lessons-learned.md](lessons-learned.md) |
| One prefix: `mdv` / `MDV` | Code (`mdvXxx`, `.mdv-*`, `MDV_*`), storage (`mdv-*`, IndexedDB `mdv-viewer`), on-disk markers (`MDV-ANCHOR`, `MDV-COMMENTS:v1`) |
| Legacy viewer kept for reference | `../legacy/`, not developed; ideas worth porting are listed in [legacy-viewer.md](legacy-viewer.md) |
| Extension sandbox hardened | `../extensions/github-html-viewer/` sandboxes rendered pages without `allow-same-origin` (see its README) |
| Task lists fixed | A misspelled global (`markdownItTaskLists` vs the plugin's `markdownitTaskLists`) had silently disabled task-list checkboxes |
| Two destructive save paths closed | Paste and URL loading could leave a document linked to a different file, so a comment save could overwrite it (see [Known issues](#known-issues)) |
| Comment data safety fixed (2026-10-10) | Known issues 1–6 fixed, each with a browser test in `tests/e2e/comments.spec.mjs`; the README's "experimental" warning removed. `mdvWriteDocument` is the single save seam, shared with the desktop app |

## Open decisions

### 1. Form factor

The viewer is one HTML file that works from disk. The next step depends on where it should live.

| Option | What you get | What it costs |
|---|---|---|
| **A. Stay a zero-build file** | Works anywhere: open it from disk or any static server. Nothing to install. | `file://` blocks `?file=` loading and ES-module scripts, so the code stays in one large inline script (about 2,550 lines today). |
| **B. Static site on GitHub Pages** (free for a public repo) | Open a URL, then drop or pick a file. HTTPS enables the File System Access API in Chromium. ES modules become possible. | Viewing your own local files still needs Open or drag-and-drop; `?file=` only reaches files on the same site. |
| **C. Local CLI/server** (e.g. `kmd <folder>`) | A file tree for a whole folder, live reload on save, `?file=` everywhere, no picker friction. | Needs a runtime such as Node or Python, plus packaging. |
| **D. Desktop app** (Tauri or Electron) | Native file access, an OS "open with" integration, offline. | The largest build and release burden. |
| **E. Editor or browser extension** (VS Code, Chrome) | Lives where people already read markdown. | Every host has its own API, and the viewer would compete with built-in previews. |

A and B combine naturally: keep the single file and also publish it on Pages. C is the natural next
step if folder browsing matters.

### 2. Which visualizations first

[visualization-catalog.md](visualization-catalog.md) rates candidates by value and effort. The
cross-cutting prerequisite for all of them is a **renderer registry** keyed by fenced-block language
tag, with lazy loading, theme hooks and one consistent error box. Mermaid and math are wired
individually today ([architecture.md](architecture.md) shows how).

### 3. Smaller open questions

- Rename `markdown-viewer.html` to `index.html`, so a served folder or GitHub Pages opens it directly?
- Vendor the three Google Fonts families, so the viewer makes **no** third-party requests
  ([dependencies.md](dependencies.md))?
- Port the legacy viewer's ideas: Copy AI export, an explicit author field, and HTML sanitization
  ([legacy-viewer.md](legacy-viewer.md)).
- ~~Split the inline script into modules?~~ **Done** as twelve classic scripts in `js/` plus `css/viewer.css`. Classic `<script src>` files load from `file://`, so option A still holds.

## What has been verified, and how

| Check | Result | Tier |
|---|---|---|
| `python3 scripts/check-inline-js.py markdown-viewer.html legacy/md_viewer.html` | Both inline scripts parse. The checker was confirmed to fail on a deliberately broken script. | Static |
| Browser smoke test, Chrome, `samples/kitchen-sink.md` | Every Mermaid block becomes an SVG; KaTeX inline and display render with no `.katex-error`; task lists, footnotes, definition lists, abbreviations, sub/sup/mark, tables, the image and the frontmatter dashboard all render; console clean. | Runtime (Chrome only) |
| Same, after switching to dark theme | Diagrams re-rendered, highlight.js stylesheet swapped, console clean | Runtime (Chrome only) |
| Browser smoke test, `samples/commented.md` | 3 comments parsed into 2 threads (one resolved, one with a reply); chips placed; no orphans; the payload is not visible in the page | Runtime (Chrome only) |
| Every `if (window.X)` library guard checked against the real globals | One mismatch found (task lists) and fixed | Runtime |
| Paste into the settings field and a reply box, before and after the fix | Before: the document was replaced. After: the document is kept, and a page-level paste unlinks the file handle (`null`) | Runtime (Chrome only) |
| `?file=` fetch finishing after a handle was linked (simulated race) | Handle cleared, document renders, console clean | Runtime (Chrome only) |
| Known issues 1, 3, 7, 8, 9, 10, 12, 13 | Reproduced as described in [Known issues](#known-issues) | Runtime (Chrome only) |
| Comment data safety, issues 1–6 plus the file-plus button and the startup restore (2026-10-10) | `tests/e2e/comments.spec.mjs`, 28 tests. Run against the code before the fix (568069f), 24 fail, each on the bug it names, and 4 controls pass; with the fix all 28 pass. Saves go to a fake file handle, the browser's private file system (OPFS) or a fake desktop bridge | Runtime (Chrome, automated) |

**Not yet verified:**
- saving back to a real file on disk, which needs a real user gesture (the save logic itself is covered by the
  comment tests, with fake and browser-private files);
- read-aloud audio;
- Firefox and Safari;
- the GitHub extension after its sandbox change.

## Known issues

Collected from the documentation pass, where each doc was written from the code and then fact-checked
by a second reader, and from the browser test. Each doc's own "limitations" section has the
details.

Each entry says how it was established:
- **Verified** means it was reproduced in Chrome on 2026-10-04.
- **Simulated** means the viewer's own code was run in Node with DOM stubs.
- **Read** means it was established from the code alone.

### Data safety (fixed 2026-10-10)

All six are fixed in `js/comments.js`. Each has a test in `tests/e2e/comments.spec.mjs` that fails against the
earlier code (568069f) and passes now; [commenting.md](commenting.md#data-safety-tests) lists them.

| # | Issue | Evidence | Fix |
|---|---|---|---|
| 1 | Starting a new comment thread did not save it. `mdvAddComment` added the comment, then re-rendered, and the comment hook re-parsed comments from the source, which did not contain the new one yet. The anchor marker was still written, leaving an orphan marker in the file. | Verified: the count stayed at 3, the new body was absent from `mdvSerialize` output, and the sidebar showed no new card | **Fixed.** Every change writes the list into the source together with it (`mdvCommit`), and adding a thread no longer re-renders. Test: "a new thread is saved into the file, on the block it was started on" |
| 2 | Deleting a thread did not remove it: the re-parse restored it, and it was saved back | Simulated (commenting.md, bug 2) | **Fixed** the same way; only that thread's marker is removed, never text in code. Test: "a deleted thread stays deleted, and its marker goes with it" |
| 3 | A document that mentions the comment-block tokens (`<!-- MDV-COMMENTS:v1` … `MDV-COMMENTS:end -->`), even in code spans, lost the text between them on the next save | Verified with the viewer's own `mdvParseFile`/`mdvSerialize`: a 9-line document lost 121 characters, including a paragraph | **Fixed.** Only a block that ends the file is read, found from the **last** opening token at a line start (`mdvLocateBlock`). Test: "a document that mentions the comment tokens, even in code, keeps every character" |
| 4 | A comment containing the literal text `\u003c` or `\u002d` (a backslash followed by `u003c` or `u002d`), or any unparsable block, made the next save delete every comment | Read (bugs 7–8) | **Fixed.** `JSON.parse` alone unescapes. An unreadable block, or one in another format version, makes comments read-only for that file and `mdvSerialize` refuses to drop it. Tests: "comment text containing the escape sequences themselves round-trips", "an unreadable comment block is never rewritten" |
| 5 | Workspace matching linked by file name only, so dropping a different file with the same name could later overwrite the workspace file | Read (bug 15) | **Fixed.** A file is linked only when its contents are identical (`mdvTryWorkspaceMatch`, `mdvPickWorkspace`). Test: "a dropped file links to the workspace file of the same name only when the contents match" |
| 6 | No conflict detection: edits made in another editor were overwritten by the next save | Read (bug 5) | **Fixed.** `mdvWriteDocument`, the only writer, checks that the file still holds the version the viewer read (`lastModified` and size, then the text); on a conflict it writes nothing, says so, and keeps the comment until the reader reloads, downloads or overwrites. In the desktop app it goes through `mdvHost.saveDocument` with the mtime that was read. Tests: two "issue 6" tests and two desktop tests |

Fixed in the initial import, and kept here as a record:
- **Paste replaced the document even inside a text field, and left the opened file linked.** Pasting anything over 10 characters, even into a comment box or the settings field, replaced the document, and the next comment save could write the pasted text over the opened file. Pastes into text fields now stay in the field, and a document-level paste unlinks the file. Verified both before and after the fix.
- **A `?file=` document could stay linked to another file.** A document loaded by URL after the last-opened file was restored stayed linked to that file. It now unlinks (verified with a simulated race).

### Security

| # | Issue | Evidence | Fix direction |
|---|---|---|---|
| 7 | Raw HTML is rendered without sanitization, so an untrusted file can run script in the viewer and use any granted file-system handle. Remote images also reveal that a file was opened. | Verified: an `onerror` attribute executed. See [rendering.md](rendering.md#security-posture) | DOMPurify configured to keep the viewer's own markup **and HTML comments** (comments and narration depend on them), plus a Content Security Policy |

### Rendering

| # | Issue | Evidence | Fix direction |
|---|---|---|---|
| 8 | Two `$` on one line become math, even in prices and code; code samples then show raw KaTeX HTML | Verified, with a repro in `../samples/repro-dollar-signs.md` | Render math inside markdown-it with Pandoc's `$` rules, never inside code |
| 9 | Dark theme: diagrams keep their light-theme colours, and sequence-diagram labels and arrows are `#333` on `#1C1C24` | Verified: after `setTheme('dark')`, Mermaid's config is still `theme: 'default'` and already-rendered diagrams are skipped | Keep each diagram's source; re-initialize Mermaid with the matching theme and re-render all diagrams on a theme change |
| 10 | Mermaid sequence-diagram notes overflow their box | Verified: 384px of text in a 295px note, in both themes | Try `sequence: { wrap: true }` |
| 11 | Section minimap labels overlap and clip when a document has many `h2` sections | Seen in a screenshot of `kitchen-sink.md` (20 sections) | Truncate with an ellipsis or scroll; show the full title on hover |
| 12 | Narration comments before a diagram or table under a heading are never found | Verified ([read-aloud.md](read-aloud.md)) | Move comment nodes with their block in `addSectionToggles` |
| 13 | The copy button copies the language label and the word "Copy" with the code (e.g. `pythonCopydef hello…`) | Verified | Copy only the inner `code` element's text |
| 14 | Clicking a diagram node never jumps to its section; the handler never attaches | Read ([features.md](features.md)) | — |
| 15 | Frontmatter `abbreviations` do nothing | Read ([features.md](features.md)) | — |
| 16 | Diagram overlay titles are guessed by regex: any source containing "pie" is titled "Pie Chart" | Read ([features.md](features.md)) | Use the diagram type Mermaid reports |
| 17 | A frontmatter `status:` or `date:` with no value stops the whole document from rendering (`TypeError` in `renderFrontmatterDashboard`). When the file was opened by `?file=`, `loadFromUrl` swallows the error and shows **"File not found on server"** for a file that exists | Verified in Chrome: a 7-line file with an empty `status:` renders nothing, logs nothing, and shows the not-found prompt ([features.md](features.md#current-limitations)) | Coerce dashboard fields to strings, and move the dashboard into the guarded post-processing. Never report a render error as "not found" |

### Robustness and polish

- **A failed optional library disables its feature silently,** because the `if (window.X)` guards have no warning. Task lists were silently off this way until the initial import fixed a misspelled global.
- ~~**The file-plus button (writable open) throws outside Chromium**~~ **Fixed 2026-10-10:** `mdvPickFile` opens `#fileInput`. Test: "the file-plus button opens the file chooser in browsers without the File System Access API".
- ~~**The startup restore of the last-opened file can override an explicit `?file=` link**~~ **Fixed 2026-10-10:** the restore never runs over a `?file=` link, `#demo`, a document already shown, or in the desktop app. Tests: "the startup restore never overrides an explicit ?file= link" (with a control that the restore still works without a link) and "the desktop app never restores the last browser file".
- **Every load logs a `favicon.ico` 404.**
- **Several things are untested:** Firefox and Safari, a real save round-trip, read-aloud audio, and the GitHub extension after its sandbox change.

Every doc has its own limitations section with more detail and lower-severity items.

## Not yet documented or tested

The final review across all docs found these gaps:

- ~~**No automated tests or CI.**~~ **Done:** `pnpm test` (Playwright) runs every sample in both themes and the
  `file://` path, and `.github/workflows/test.yml` runs it on every PR. Earlier, behaviour in these docs was checked by hand: Node runs of extracted
  functions, DOM simulations, and one Chrome session. A small test harness (for example Playwright
  running the samples) would turn the verified issues above into regression tests. Document it in a
  `docs/testing.md`.
- **The extension and GitHub's in-app navigation.** The content script runs on a full page load of a
  `/blob/` URL, so opening an `.html` file through GitHub's in-app (soft) navigation may not render
  it (inferred).
- **Shortcut edge cases.** The keydown handler compares `e.key` with exact lowercase letters, so
  Caps Lock probably disables the Mod+K, Mod+B and Mod+O shortcuts (inferred).
- **The viewer's own accessibility:** focus handling in the overlays, ARIA labels on icon-only
  toolbar buttons, and keyboard access to every control.
- **Performance on large documents.** Every render re-parses everything, and the
  IntersectionObservers created on each render are never disconnected.
- **Line numbers drift.** `architecture.md` cites line numbers "as of the initial import". Either
  refresh them with each change or replace them with function names.

## Suggested first session

1. ~~**Make comments safe** (known issues 1–6).~~ **Done 2026-10-10**, with a browser test for each.
2. **Sanitize rendered HTML** (issue 7), keeping HTML comments intact.
3. **Fix the rendering bugs readers hit first:** dollar signs (8), dark-theme diagrams (9), the copy
   button (13). Each has a verified repro above.
4. **Decide the form factor** (above). It determines whether the code can be split into modules, and
   the inline script is already about 2,550 lines.
5. **Build the renderer registry,** then add the first one or two visualizations from the
   catalogue's shortlist.
6. **Test in Firefox and Safari,** and confirm a full save round-trip by hand in Chrome.
