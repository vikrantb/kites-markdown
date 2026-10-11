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
| `pnpm exec playwright test --workers=1 tests/e2e/reading-aids.spec.mjs`, on this branch and on an extracted copy of main (2026-10-10) | 47 of 47 pass on the branch: the first 27, and 20 added after the review round. On main 46 of 47 fail. The one that passes, "a heading inside a closed `<details>` never becomes the current heading", is a regression the first version of this change introduced and the review round fixed. Of the 20 added tests, 17 fail on that first version (`5be7c54`). The other 3 cover guards that already worked, and each went red when its guard was removed; 28 such single-point sabotages went red in all. Of the first 27, 23 fail on main on the behaviour each names (narration, comment anchors, re-render time, observers, scroll spy, shortcuts, dialogs, read-aloud). Two search tests fail on main first because main focuses the search box 50 ms after Ctrl+K and drops the keys typed before that (also fixed here); the 200-character limit was confirmed separately on main with a positive control. The two screenshot tests stop at the lightbox step, because main has no keyboard-focusable images. Read-aloud runs against a stand-in `speechSynthesis` | Runtime (Chrome only) |
| `node scripts/measure-large-document.mjs <dir> --sections 3000 --renders 5`, main and this branch alternately, 3 rounds, same machine (2026-10-10) | See [Reading aids](#reading-aids-fixed-2026-10-10) | Runtime (Chrome only) |

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
| 9 | Dark theme: diagrams keep their light-theme colours, and sequence-diagram labels and arrows are `#333` on `#1C1C24` | Verified: after `setTheme('dark')`, Mermaid's config is still `theme: 'default'` and already-rendered diagrams are skipped | Keep each diagram's source; re-initialize Mermaid with the matching theme and re-render all diagrams on a theme change |
| 10 | Mermaid sequence-diagram notes overflow their box | Verified: 384px of text in a 295px note, in both themes | Try `sequence: { wrap: true }` |
| 11 | Section minimap labels overlap and clip when a document has many `h2` sections | Seen in a screenshot of `kitchen-sink.md` (20 sections) | Truncate with an ellipsis or scroll; show the full title on hover |
| 12 | ~~Narration comments before a diagram or table under a heading are never found~~ **Fixed 2026-10-10** | Verified in Chrome before and after: `tests/e2e/reading-aids.spec.mjs` fails on main and passes now ([Reading aids](#reading-aids-fixed-2026-10-10)) | Done: `addSectionToggles` moves comment nodes with their blocks |
| 13 | The copy button copies the language label and the word "Copy" with the code (e.g. `pythonCopydef hello…`) | Verified | Copy only the inner `code` element's text |
| 14 | Clicking a diagram node never jumps to its section; the handler never attaches | Read ([features.md](features.md)) | — |
| 15 | Frontmatter `abbreviations` do nothing | Read ([features.md](features.md)) | — |
| 16 | Diagram overlay titles are guessed by regex: any source containing "pie" is titled "Pie Chart" | Read ([features.md](features.md)) | Use the diagram type Mermaid reports |
| 17 | A frontmatter `status:` or `date:` with no value stops the whole document from rendering (`TypeError` in `renderFrontmatterDashboard`). When the file was opened by `?file=`, `loadFromUrl` swallows the error and shows **"File not found on server"** for a file that exists | Verified in Chrome: a 7-line file with an empty `status:` renders nothing, logs nothing, and shows the not-found prompt ([features.md](features.md#current-limitations)) | Coerce dashboard fields to strings, and move the dashboard into the guarded post-processing. Never report a render error as "not found" |

### Robustness and polish

- **A failed optional library disables its feature silently,** because the `if (window.X)` guards have no warning. Task lists were silently off this way until the initial import fixed a misspelled global.
- **The file-plus button (writable open) throws outside Chromium** when no document is loaded, because `mdvPickFile` clicks `#mdFile` while the input's id is `fileInput`. The plain **Open** button is unaffected. Read (commenting.md, bug 14).
- **The startup restore of the last-opened file can override an explicit `?file=` link** if the restore finishes after the fetch. Read.
- **Every load logs a `favicon.ico` 404.**
- **Several things are untested:** Firefox and Safari, a real save round-trip, read-aloud audio, and the GitHub extension after its sandbox change.

Every doc has its own limitations section with more detail and lower-severity items.

### Reading aids (fixed 2026-10-10)

One root cause produced three of these. `addSectionToggles` moved only elements into each section
wrapper, so the HTML comments between blocks, and the whitespace text nodes, stayed behind:

- **Narration under headings was never found** (issue 12). Fixed: comments move with their block.
- **Comment threads inside sections attached to the next heading**, or became orphans in the last
  section ([commenting.md](commenting.md), bug 3). Fixed by the same change.
- **Re-rendering a large document was slow.** The stranded whitespace formed runs of up to 7,292
  adjacent text nodes in `#mdBody`, and Chrome removes such a run slowly: on the generated
  3,000-section document, `#mdBody.innerHTML = ''` took 1,976 ms, and 4 ms when the whitespace-only
  text nodes were removed first (one scratch run in Chrome, same page, same document).

Measured with `node scripts/measure-large-document.mjs <dir> --sections 3000 --renders 5` (3,601
headings, Chrome, file://), main and this change alternately, three rounds on one machine:

| | main | this change | this change, minimap observer deleted |
|---|---|---|---|
| First render (median of 3) | 445 ms | 421 ms | 428 ms |
| Re-render (median of renders 2–5, then of 3 runs) | 2,327 ms | 412 ms | 432 ms |
| `IntersectionObserver`s alive after 5 renders | 10 | 5 | 0 |
| DOM nodes after garbage collection, render 1 and 5 | 104,295 both | 104,295 both | 104,295 both |
| JS event listeners | 19,296 | 15,704 | 15,704 |
| JS heap after garbage collection | 7.6–8.7 MB | 6.3 MB | 6.3 MB |
| Main-thread task time over a 120-step scroll through the document | 219–228 ms | 162–166 ms | 100–113 ms |

The DOM node count shows the old observers did not keep old documents alive; they did keep their
callbacks and target lists, and added work to every scroll.

How long a key takes to show its result on the same 3,000-section document (milliseconds from the key
event to the second animation frame; `node scripts/measure-large-document.mjs <dir> --sections 3000
--renders 3 --keys 3`, 3 presses per run, 2 runs per arm, arms alternating, Chrome, 1-minute load 26 to
32 on 8 cores). "Before" is the first version of this change, which made the whole page inert for a
dialog; "after" hides the document area with `aria-hidden` instead:

| | main | before | after |
|---|---|---|---|
| `Ctrl+K` opens search | 24–95 | 192–265 | 31–106 |
| `Esc` closes search | 22–27 | 183–201 | 29–34 |
| `?` opens the shortcuts sheet | 23–26 | 190–199 | 31–42 |
| `Esc` closes it | 22–40 | 183–205 | 30–46 |
| `Ctrl+B` hides the outline | 38–55 | 34–40 | 58–64 |
| `Ctrl+B` shows it | 16–91 | 16–88 | 54–119 |

`Ctrl+B` got slower: a hidden outline is now `inert`, so it leaves the Tab order, and switching that
restyles every outline entry (3,601 here). Also fixed and tested: the scroll spy
was wrong when scrolling back up, the H1 could not be folded when the minimap followed it, a
heading-less document hid the outline for the next one, search missed words after the first 200
characters of a block, and a heading's own `#` was deleted from the outline, search and read-aloud.
Read-aloud fixes are listed in [read-aloud.md](read-aloud.md#limitations-and-browser-quirks).

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
- ~~**Shortcut edge cases.**~~ **Done 2026-10-10.** Caps Lock did disable Mod+K, Mod+B and Mod+O
  (confirmed by a test against main). Shortcuts now match case-insensitively, by physical key on
  non-Latin layouts, never with AltGr, and never steal the browser's own Shift shortcuts; a focused
  task-list checkbox no longer blocks them. Covered by a browser test.
- **The viewer's own accessibility.** *Partly done 2026-10-10:* search, the shortcuts sheet and the
  image lightbox are modal dialogs that move focus in, trap Tab, close on Esc and give the focus
  back; the outline, section chevrons, document images, search results and the read-aloud player
  have names and work from the keyboard; a hidden outline and the invisible `#` permalinks are out of
  the Tab order; headings are named by their own words (all covered by browser tests, in Chrome's
  accessibility tree; no screen reader was used). Still open: names for the icon-only toolbar
  buttons (they rely on `title`); keyboard and focus handling in the diagram overlay (its Expand
  button is invisible when focused, and the overlay neither takes nor returns the focus), the links
  panel (its off-screen entries are tab stops), the settings panel and the comments sidebar; a skip
  link past the outline and the minimap; the contrast of the selected search result.
- **Performance on large documents.** *Partly done 2026-10-10:* re-rendering a 3,000-section document
  is about 5.6 times faster, and the reading aids no longer create observers per render (numbers in
  [Reading aids](#reading-aids-fixed-2026-10-10)). Still open: every render re-parses the whole
  document, and `buildSectionMinimap` still creates an `IntersectionObserver` per render that is never
  disconnected (the scroll spy now does its job, so it can be deleted).
- **Line numbers drift.** `architecture.md` cites line numbers "as of the initial import". Either
  refresh them with each change or replace them with function names.

## Suggested first session

1. **Make comments safe** (known issues 1–6). Until then the README warns readers off using them on
   important files.
2. **Sanitize rendered HTML** (issue 7), keeping HTML comments intact.
3. **Fix the rendering bugs readers hit first:** dollar signs (8), dark-theme diagrams (9), the copy
   button (13). Each has a verified repro above.
4. **Decide the form factor** (above). It determines whether the code can be split into modules, and
   the inline script is already about 2,550 lines.
5. **Build the renderer registry,** then add the first one or two visualizations from the
   catalogue's shortlist.
6. **Test in Firefox and Safari,** and confirm a full save round-trip by hand in Chrome.
