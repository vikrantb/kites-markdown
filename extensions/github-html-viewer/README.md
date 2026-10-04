# GitHub HTML Renderer (Chrome extension)

GitHub shows `.html` files as **source code**. For a private repository, GitHub Pages needs a paid
plan and third-party previewers such as `htmlpreview.github.io` cannot reach the file. This small
extension renders it in place: on a GitHub `.html` blob page it fetches the raw file **with your
signed-in session** and shows the rendered page in a full-window overlay. Links to other files in
the repository navigate GitHub, where the extension renders them again. In-page (`#`) anchors stay
inside the view.

## Install (no build step)

1. Open `chrome://extensions` (Edge and Brave have the same page).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder, `extensions/github-html-viewer/`.
4. Open any `.html` file on GitHub, for example
   `https://github.com/<owner>/<repo>/blob/main/docs/index.html`. It renders automatically.

The **⚡ Render / ✕ Source** button (top right) switches between the rendered page and GitHub's
source view.

## How it works

- Runs only on `https://github.com/*/blob/*` pages, and only acts when the path ends in `.html` or
  `.htm`.
- Fetches `https://github.com/{owner}/{repo}/raw/{ref}/{path}` with `credentials: "include"`, so it
  can read private files you already have access to. It sends nothing anywhere else and stores
  nothing.
- Rewrites every non-anchor `<a href>` to an absolute GitHub URL with `target="_top"`, so a click
  navigates the tab to that file.
- Shows the page in an `<iframe srcdoc>` sandboxed with
  `allow-scripts allow-popups allow-top-navigation-by-user-activation`.
- Auto-render is the final `render();` call in `content.js`. Delete it to render only on click.

## Security model

The iframe is deliberately sandboxed **without** `allow-same-origin`. A `srcdoc` iframe otherwise
inherits `github.com`'s origin, and with scripts enabled, any `.html` file in any repository you
open would run as you on GitHub. With an opaque origin the page's scripts still run, but they cannot
read GitHub cookies, the surrounding GitHub page, or browser storage.

## Known limitations

- **Relative assets probably do not load.** The iframe resolves relative URLs against the GitHub
  blob page, so `<link href="assets/site.css">` and `<script src="assets/site.js">` point at
  GitHub's HTML pages, which the browser will not accept as CSS or JavaScript. Pages that inline
  their CSS and JS render fully. *(Derived from the code and the URL-resolution rules; not yet
  confirmed in a browser.)*
- **Storage APIs throw.** `localStorage`, `sessionStorage` and `indexedDB` are unavailable in an
  opaque origin, so a page script that uses them without `try/catch` stops at that line.
- **Links are rewritten with a regular expression**, not an HTML parser. Only double-quoted `href`
  attributes are rewritten.
- Chrome-family browsers only (Manifest V3). Not yet tested in a browser since the sandbox change.

## Alternatives

- Open the file locally (`open docs/index.html`).
- For a public repository, enable GitHub Pages (Settings → Pages) and browse the rendered site.
