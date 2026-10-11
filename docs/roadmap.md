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
| Comments marked experimental | The README warns against using comments on important files until data-safety issues 1–6 are fixed |

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

**Not yet verified:**
- saving back to disk, which needs a real user gesture;
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

### Data safety (fix first)

| # | Issue | Evidence | Fix direction |
|---|---|---|---|
| 1 | Starting a new comment thread does not save it. `mdvAddComment` adds the comment, then re-renders, and the comment hook re-parses comments from the source, which does not contain the new one yet. The anchor marker is still written, leaving an orphan marker in the file. | Verified: the count stayed at 3, the new body is absent from `mdvSerialize` output, and the sidebar shows no new card | Write the in-memory comments into the source (`mdvSerialize`) before any re-render that re-parses it. See [commenting.md](commenting.md#known-bugs-and-limitations), bug 1 |
| 2 | Deleting a thread does not remove it: the re-parse restores it, and it is saved back | Simulated (commenting.md, bug 2) | Same as #1 |
| 3 | A document that mentions the comment-block tokens (`<!-- MDV-COMMENTS:v1` … `MDV-COMMENTS:end -->`), even in code spans, loses the text between them on the next save | Verified with the viewer's own `mdvParseFile`/`mdvSerialize`: a 9-line document lost 121 characters, including a paragraph | Parse only a block that ends the file, found from the **last** opening token. Anchoring the current regex is not enough: the search still starts at the first mention. Bug 6 |
| 4 | A comment containing the literal text `\u003c` or `\u002d` (a backslash followed by `u003c` or `u002d`), or any unparsable block, makes the next save delete every comment | Read (bugs 7–8) | Escape and unescape via the JSON parser, not textual replacement. Never write after a failed parse |
| 5 | Workspace matching links by file name only, so dropping a different file with the same name can later overwrite the workspace file | Read (bug 15) | Link only when the contents match, or ask |
| 6 | No conflict detection: edits made in another editor are overwritten by the next save | Read (bug 5) | Compare `lastModified` before writing |

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
| 9 | Dark theme: diagrams keep their light-theme colours, and sequence-diagram labels and arrows are `#333` on `#1C1C24` | **Fixed 2026-10-10.** `tests/e2e/visuals.spec.mjs` › *a theme change redraws every diagram in the dark palette, and back*: the flowchart node takes the dark fill and sequence text reaches at least 4.5:1 on the dark card. On the old code the same test fails: the node stays `rgb(236, 236, 255)` | Each diagram keeps its source (`data-mdv-source`); `renderMermaidDiagrams` redraws every diagram whose palette differs from the current theme's. The palette is Mermaid's `base` theme fed from the `--diagram-*` tokens in `css/viewer.css`, in all three themes |
| 10 | Mermaid sequence-diagram notes overflow their box | **Fixed 2026-10-10.** `tests/e2e/visuals.spec.mjs` › *sequence-diagram notes stay inside their box*, light and dark: every note line lies inside its note rectangle. On the old code the note text starts 57px left of its box | `sequence: { wrap: true }`, with the sequence fonts set to the font the page draws them in, so text is measured as it is shown |
| 11 | Section minimap labels overlap and clip when a document has many `h2` sections | **Fixed 2026-10-10.** `tests/e2e/visuals.spec.mjs` › *minimap labels stay inside their segments…* and *a minimap with room shows each label, truncated with an ellipsis…*. On the old code 13 of the kitchen sink's 17 labels are wider than their segment | Labels are drawn by CSS from `data-label`, truncated with an ellipsis, and shown in full in a tooltip on hover or keyboard focus. The minimap is a rail that sticks under the toolbar (`tests/e2e/visuals-layout.spec.mjs`); segments too narrow for a readable label become a track (read, current, ahead) and the rail names the current section and its position |
| 12 | Narration comments before a diagram or table under a heading are never found | Verified ([read-aloud.md](read-aloud.md)) | Move comment nodes with their block in `addSectionToggles` |
| 13 | The copy button copies the language label and the word "Copy" with the code (e.g. `pythonCopydef hello…`) | **Fixed 2026-10-10.** `tests/e2e/visuals.spec.mjs` › *the copy button copies only the code*: the clipboard holds exactly the code. On the old code it holds `pythonCopydef drain(…`, plus a trailing newline | `copyCode` copies the inner `code.hljs` element and drops the fence's closing newline |
| 14 | Clicking a diagram node never jumps to its section; the handler never attaches | **Fixed 2026-10-10.** `tests/e2e/visuals.spec.mjs` › *a diagram node named like a heading jumps to that section* and *a linked node in the expanded view closes it and jumps*. On the old code no node is linked (0 of the expected 3) | Nodes are linked after each diagram is drawn, by exact match of the label with a heading. A linked node is underlined, focusable and announced as a link; a click or Enter scrolls to the heading, unfolding collapsed sections, and flashes it |
| 15 | Frontmatter `abbreviations` do nothing | **Fixed 2026-10-10.** `tests/e2e/visuals.spec.mjs` › *frontmatter abbreviations become tooltips, as a map or as a list*. On the old code no tooltip is created | `applyAbbreviationTooltips` accepts both YAML shapes. The indented map, which `parseFrontmatter` turns into an empty list, is read from the document's own frontmatter |
| 16 | Diagram overlay titles are guessed by regex: any source containing "pie" is titled "Pie Chart" | **Fixed 2026-10-10.** `tests/e2e/visuals.spec.mjs` › *the expanded view is titled by the type Mermaid reports*. The old code titled the kitchen sink's flowchart and sequence diagram "Diagram" | The title is the `diagramType` that `mermaid.render` returns, plus the diagram's own title when it has one ("Pie chart · Estimated effort by area") |
| 17 | A frontmatter `status:` or `date:` with no value stops the whole document from rendering (`TypeError` in `renderFrontmatterDashboard`). When the file was opened by `?file=`, `loadFromUrl` swallows the error and shows **"File not found on server"** for a file that exists | Verified in Chrome: a 7-line file with an empty `status:` renders nothing, logs nothing, and shows the not-found prompt ([features.md](features.md#current-limitations)) | Coerce dashboard fields to strings, and move the dashboard into the guarded post-processing. Never report a render error as "not found" |

Before and after the visual-system change that closed issues 9, 10, 11, 13, 14, 15 and 16: [light theme](images/visuals-light-before-after.png), [diagrams in the dark theme](images/visuals-dark-diagrams-before-after.png), [code blocks and callouts](images/visuals-code-callouts-before-after.png).

### Robustness and polish

- **A failed optional library disables its feature silently,** because the `if (window.X)` guards have no warning. Task lists were silently off this way until the initial import fixed a misspelled global.
- **The file-plus button (writable open) throws outside Chromium** when no document is loaded, because `mdvPickFile` clicks `#mdFile` while the input's id is `fileInput`. The plain **Open** button is unaffected. Read (commenting.md, bug 14).
- **The startup restore of the last-opened file can override an explicit `?file=` link** if the restore finishes after the fetch. Read.
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

1. **Make comments safe** (known issues 1–6). Until then the README warns readers off using them on
   important files.
2. **Sanitize rendered HTML** (issue 7), keeping HTML comments intact.
3. **Fix the rendering bugs readers hit first:** dollar signs (8), dark-theme diagrams (9, fixed), the copy
   button (13, fixed). Each has a verified repro above.
4. **Decide the form factor** (above). It determines whether the code can be split into modules, and
   the inline script is already about 2,550 lines.
5. **Build the renderer registry,** then add the first one or two visualizations from the
   catalogue's shortlist.
6. **Test in Firefox and Safari,** and confirm a full save round-trip by hand in Chrome.
