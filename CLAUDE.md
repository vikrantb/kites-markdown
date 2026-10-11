# kites-markdown

A local-first, general-purpose markdown viewer built for **reading and understanding** markdown:
clean, beautiful rendering with advanced visualizations (Mermaid diagrams, KaTeX math, code
highlighting, callouts, a frontmatter dashboard), reading aids (outline, minimap, search, focus
mode, read-aloud) and threaded comments stored inside the `.md` file itself.

It is public and meant to be useful to anyone. It carries no knowledge of any other product, so
keep it that way: no product names, private paths or project-specific examples.

## Map

| Path | What it is |
|---|---|
| `markdown-viewer.html` | The app's markup. It loads `css/viewer.css` and the classic scripts in `js/` in a fixed order. No build step. |
| `css/viewer.css` | All of the viewer's own styles. |
| `js/*.js` | The app, as 14 classic scripts sharing one global scope, loaded in the order `markdown-viewer.html` lists them: `core`, `actions`, `math`, `display`, `files`, `render`, `mermaid`, `navigation`, `diagram-overlay`, `links`, `enhancements`, `read-aloud`, `comments`, `app`. `app` starts the viewer, so it loads last. Classic scripts (not ES modules) still load from `file://`. |
| `tests/` | Browser tests (`pnpm test`): every sample in both themes, file:// loading, security (`security.spec.mjs`), every control (`controls.spec.mjs`) and render correctness (`render-correctness.spec.mjs`). `tests/fixtures/` holds their documents; `tests/serve.mjs` is their static server. |
| `vendor/` | Third-party libraries, vendored unmodified and loaded by relative tags. No CDN. Licenses are in `THIRD_PARTY_NOTICES.md`. |
| `extensions/github-html-viewer/` | Chrome extension that renders `.html` blobs on GitHub. Read its security model before changing the iframe sandbox. |
| `legacy/` | The superseded first viewer. Reference only; do not develop it. |
| `docs/` | The documentation. Start with `docs/architecture.md`; the plan is `docs/roadmap.md`. |
| `samples/` | Fixtures: `kitchen-sink.md` exercises every supported syntax, `commented.md` the comment format, and `repro-*.md` files reproduce open bugs. |
| `scripts/check-js.mjs` | $0 syntax check of every `js/` script, parsed as a classic script (`pnpm check`). `scripts/check-inline-js.py` now only checks the legacy viewer. |

## Run

- **Fastest:** open `markdown-viewer.html` in a browser, then use **Open** or drag in a `.md` file.
- **To use `?file=` links:** serve a folder that contains both the viewer and your documents, bound
  to localhost:

  ```bash
  python3 -m http.server 8080 --bind 127.0.0.1
  ```

  Then open `http://localhost:8080/markdown-viewer.html?file=samples/kitchen-sink.md`.
- **Always pass `--bind 127.0.0.1`.** The default binds every network interface, which exposes the
  folder to your local network.
- **`file://` cannot auto-load** `?file=` documents (browser security). Saving back into the file
  needs a Chromium browser (File System Access API).

## Verify a change

1. `pnpm check` must pass: every `js/` script parses. It checks syntax only.
1. `pnpm test` must pass: every sample renders in both themes with no page or console errors, every Mermaid
   block becomes an SVG, math has no errors, and the viewer works from `file://`. Screenshots land in `test-results/`.
2. Open `samples/kitchen-sink.md` and `samples/commented.md` in Chrome, in **both themes**:
   - the console must be clean;
   - diagrams, math, task-list checkboxes and code highlighting must render;
   - comment threads must appear in the sidebar.
3. Saving to disk needs a real user click, so confirm it by hand.
4. For anything touching file access, also check the non-Chromium fallback in Firefox or Safari.

`python3 -m http.server` occasionally resets a connection when many files load at once. A library
that is suddenly "missing" after a reload is usually that, not the code.

## Conventions

- **One prefix.** Code uses `mdv` (`mdvXxx` functions, `.mdv-*` classes, `MDV_*` constants).
  Storage uses `mdv-*` keys and the IndexedDB database `mdv-viewer`.
- **The on-disk comment format is a public contract.** It is `<!-- MDV-ANCHOR id="…" -->` plus a
  trailing `<!-- MDV-COMMENTS:v1 … MDV-COMMENTS:end -->`. Change it only with a version bump and a
  reader for the old version.
- **Optional libraries are guarded with `if (window.X)`.** A misspelled global used to disable the
  feature silently (task lists were off for that reason until 2026-10-04). Now `MDV_LIBRARIES` in
  `js/render.js` lists every vendored global: a missing one gets one console warning and a dismissible
  notice naming the feature. When adding a library, add it there and confirm in the browser that its
  global name matches.
- **Runtime network use is limited to Google Fonts** (see `docs/dependencies.md`). New libraries are
  vendored, never loaded from a CDN.
- **Markdown stays portable.** Every viewer-only feature must be invisible elsewhere (GitHub,
  VS Code, Obsidian): use standard syntax or HTML comments.
- **Narration comments (`<!-- narrate: … -->`) are opt-in** (see `docs/authoring-guide.md`).
- **Treat every document as untrusted input.** Everything rendered from a document goes through
  `mdvSanitize` (DOMPurify, configured in `js/render.js`). Anywhere else, never put document text into
  `innerHTML` unescaped: use `textContent`, or `escapeHtml` for text and `mdvEscapeAttr` for a quoted
  attribute value. Mermaid stays at `securityLevel: 'strict'`; `render.js` pins it at load. DOMPurify's
  `SAFE_FOR_XML` stays on (documents carry SVG and MathML); a hook keeps it from deleting text, so
  only top-level HTML comments survive, and those get a space after any `<` that could start a tag.
- **No inline handlers.** No `on*=` attribute in markup or in generated HTML, and no `javascript:`
  URL: the page's Content Security Policy (`script-src 'self' file:`) refuses them. A control says
  what it does with `data-action="<name>"` (plus an optional `data-arg`), and `js/actions.js` runs
  it: one capture-phase listener per event type and a registry. Another script adds its own with
  `mdvRegisterActions({ name: { click: (el, arg, event) => … } })`. An element that holds
  document-derived markup carries `data-mdv-document` (`#mdBody`, the diagram overlay's
  `#diagramZoomContainer`, the comment sidebar's `#mdvThreadList`); a new place that shows document
  data goes inside one. An action there runs only on an element the viewer marked with
  `mdvMarkOwnControl(el)` (render.js marks each code block's Copy button), and the sanitizer drops
  `data-action`/`data-arg` from document HTML, so a document cannot press the viewer's buttons.
- **A document is only linked to a file handle it was read from.** Any path that replaces the
  document must set `mdvFileHandle` to the matching handle or to `null`; paste and URL loading had
  this wrong until the initial import.

## Decisions already made (2026-10-04)

- Public repository, MIT license, product-neutral.
- Fresh history: one import commit.
- Prefix `mdv` / `MDV` everywhere.
- The legacy viewer is kept for reference. Its ideas worth porting are in `docs/legacy-viewer.md`.
- The extension's iframe is sandboxed **without** `allow-same-origin`, so a rendered page cannot act
  with the viewer's GitHub session.
- Comments are marked **experimental** in the README until roadmap issues 1–6 (data safety) are
  fixed. Start there.

Open decisions (form factor, which visualizations first, GitHub Pages, vendoring fonts) live in
`docs/roadmap.md`.
