# The desktop app

Kites Markdown for macOS and Windows: **double-click any Markdown file and it opens, rendered**, in a
window of its own. It is the same viewer as `markdown-viewer.html` (diagrams, math, code, outline,
search, read-aloud, comments), in a native app that knows where your files are: it saves comments into
the file, follows links between your documents, shows images that sit next to them, and updates when
another program changes the file.

- [Install on a Mac](#install-on-a-mac) · [Install on Windows](#install-on-windows)
- [Make it the default for .md files](#make-it-the-default-for-md-files)
- [Using it](#using-it) · [Uninstall](#uninstall) · [Build from source](#build-from-source)
- [How it works](#how-it-works) · [Security model](#security-model) · [Known limitations](#known-limitations)

## Install on a Mac

1. Download `Kites Markdown_<version>_universal.dmg` from the project's
   [releases](../../../releases) (or, for a build of any change, from the `kites-markdown-macos` artifact
   of the **desktop** workflow run). One download runs on Apple silicon and Intel Macs.
2. Open the `.dmg` and drag **Kites Markdown** into **Applications**.
3. Open it the first time. The app is not signed with an Apple Developer certificate yet, so macOS stops
   the first launch:
   - **macOS 15 (Sequoia) and later:** try to open it once and close the warning. Then open
     **System Settings → Privacy & Security**, scroll to *"Kites Markdown" was blocked…*, click
     **Open Anyway** and confirm.
   - **macOS 14 and earlier:** in Applications, Control-click (right-click) Kites Markdown → **Open** →
     **Open**.
   - **Or, in Terminal:** `xattr -dr com.apple.quarantine "/Applications/Kites Markdown.app"`, then open
     it normally.

   macOS remembers the choice; later launches open directly.
4. On its first launch the app asks **"Open Markdown files with Kites Markdown?"**. Choose
   **Use Kites Markdown** and every `.md` file you double-click in Finder opens in it.

## Install on Windows

1. Download `Kites Markdown_<version>_x64-setup.exe` from the [releases](../../../releases) (or the
   `kites-markdown-windows` artifact of a **desktop** workflow run).
2. Run it. The installer is not signed yet, so SmartScreen may say *"Windows protected your PC"*:
   click **More info**, then **Run anyway**.
3. It installs for your user only (no administrator rights) into `%LOCALAPPDATA%\Kites Markdown`, with a
   Start menu shortcut. It uses WebView2, which Windows 10 and 11 already have; the installer fetches it
   if it is missing.
4. When it finishes, **Settings → Default apps** opens at Kites Markdown. Choose it for `.md` (and any of
   the other Markdown types you use). Windows lets only you change a default, so this one click is yours.

## Make it the default for .md files

| | From the app | By hand |
|---|---|---|
| **Mac** | **Kites Markdown → Make Default for Markdown Files…**, or **Make Kites Markdown the default** on the welcome screen. macOS may ask you to confirm. | In Finder, select any `.md` file → **File → Get Info** (⌘I) → **Open with:** Kites Markdown → **Change All…** → **Continue**. |
| **Windows** | **File → Make Default for Markdown Files…**, or the welcome-screen button: both open Settings at the app's page. | Right-click a `.md` file → **Open with → Choose another app** → Kites Markdown → **Always**. Or **Settings → Apps → Default apps**, search for Kites Markdown. |

The app opens `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt` and `.mdtext`.

On a Mac where nobody has chosen an app for Markdown files, macOS may start using Kites Markdown as soon
as it has been opened once: an app that declares a file type becomes the automatic choice for it.

## Using it

- **One window per document.** Double-clicking a file that is already open brings its window forward.
  Opening the app without a file shows the welcome screen, which takes the next file you open.
- **Open files** with **File → Open…** (⌘O / Ctrl+O), by dropping them on a window, or from links.
  **File → New Window** (⌘N / Ctrl+N) opens an empty window; **View → Reload** (⌘R / Ctrl+R) re-reads
  the file; **Close Window** is ⌘W / Ctrl+W.
- **Links in a document:** a link to another Markdown file opens that file in its own window; web and
  email links open in your browser or mail app; links within the page scroll. Links to other kinds of file
  are not opened (a short notice says so), and the window never navigates away from the document.
- **Images** with a relative path (`![chart](images/chart.png)`) load from the document's folder and the
  folders below it.
- **Live reload:** when another program saves the file, the window shows the new version and keeps your
  place in it.
- **Comments** (still experimental, see the [README](../README.md)) are saved into the file itself.
- **Paste:** pasting Markdown into an empty window shows it; it is not saved anywhere. A window that shows
  a file keeps showing that file.

## Uninstall

- **Mac:** quit Kites Markdown and drag it from Applications to the Trash. Its settings (the theme, and
  whether it has asked to be the default) are in `~/Library/Application Support/app.kitesmarkdown.viewer`
  and `~/Library/WebKit/app.kitesmarkdown.viewer`; delete those folders too for a clean slate.
- **Windows:** **Settings → Apps → Installed apps → Kites Markdown → Uninstall**. The uninstaller removes
  the app, its file-type registrations and its entry in Default apps, and gives `.md` back to whatever
  opened it before.

## Build from source

You need Node 22 with pnpm, Rust 1.86 or newer, and the platform's build tools: the Xcode Command Line
Tools on a Mac; the Visual Studio C++ build tools on Windows.

```bash
pnpm --dir desktop install
pnpm --dir desktop build            # the app for this computer, plus its installer
pnpm --dir desktop dev              # run it from source while you work on it
```

- Bundles land in `desktop/src-tauri/target/[<target>/]release/bundle/`.
- A universal Mac build needs both Rust targets
  (`rustup target add aarch64-apple-darwin x86_64-apple-darwin`), then
  `pnpm --dir desktop tauri build --target universal-apple-darwin`. CI builds that one.
- **Self-test** a build (it opens a real document in the real app and checks what rendered):

  ```bash
  node desktop/scripts/run-self-test.mjs --doc samples/kitchen-sink.md --save-probe --expect render,kitchen-sink,save
  node desktop/scripts/run-self-test.mjs --doc desktop/tests/fixtures/linked/doc.md --expect render,assets
  ```

  On a Mac it then unregisters the build folder from Launch Services (`--keep-registration` keeps it), so a
  build never becomes the app that opens your `.md` files.
- **The icon** is `desktop/app-icon.svg`. After editing it, `pnpm --dir desktop icon` renders it with the
  repository's Playwright (run `pnpm install` at the root first) and regenerates `src-tauri/icons/`.

## How it works

```
markdown-viewer.html, css/, js/, vendor/     the viewer: one source for the browser and the app
desktop/
  scripts/stage-frontend.mjs                 copies the viewer into desktop/dist (index.html = the viewer)
  scripts/run-self-test.mjs                  runs and checks the self-test (local and CI)
  scripts/make-icons.mjs                     app-icon.svg → src-tauri/icons/
  src-tauri/tauri.conf.json                  identity, CSP, asset protocol, file associations, installers
  src-tauri/capabilities/default.json        what a window may call: Tauri core + the mdv_* commands
  src-tauri/Info.plist                       declares the Markdown type (net.daringfireball.markdown)
  src-tauri/windows/hooks.nsh                Windows: Open with, Default apps, a quoted open command
  src-tauri/src/                             the shell (Rust): see below
js/host.js                                   the bridge in the page: window.mdvHost
```

**The shell** (Tauri 2, Rust; one module per job):

| Module | Job |
|---|---|
| `lib.rs` | Start-up, single instance, how files arrive, the event loop |
| `doc_windows.rs` | One window per document: open, focus, reuse an empty window, reload, drop |
| `host.rs` | The `mdv_*` commands the page calls |
| `paths.rs` | Which paths are documents: existing Markdown files, canonicalized |
| `fsio.rs` | Reading (UTF-8, byte-order mark, size limit) and the atomic, conflict-checked save |
| `registry.rs` | Which window shows which file, and which versions of it the page has seen |
| `watch.rs` | Live reload: a folder watch per document, debounced, ignoring the app's own saves |
| `default_app.rs` | Make default: Launch Services on macOS, Settings on Windows |
| `menu.rs`, `dialogs.rs`, `prefs.rs` | The menu bar, native dialogs, the one remembered setting |
| `selftest.rs`, `self-test.js` | Self-test mode |

**How files arrive.** macOS sends an "open documents" event (Finder double-click, Open With, `open -a`),
at launch or later; the app collects files that arrive before it is ready and opens them once it is.
Windows and Linux pass the file on the command line; a second launch hands its command line to the
running app (single instance) and exits. Within the app: File → Open…, links, and dropped files.

**The bridge** (`window.mdvHost`, in `js/host.js`) is the only contract between the page and the shell.
In a browser `kind` is `'browser'` and every method is a no-op that returns `null`. It is loaded last
(after `comments.js`, because it wraps the final `renderMarkdown`), so it exists from `DOMContentLoaded` on:
check it when you use it, never while the scripts load.

| Call | Does |
|---|---|
| `kind`, `currentPath`, `currentMtimeMs` | `'desktop'` or `'browser'`; the window's file and the version the page has |
| `initialDocument()` | the window's document `{path, name, text, mtimeMs, readOnly}`, or `null` (welcome screen) |
| `readDocument(path)` | any Markdown file; rejects with `{code, message}` |
| `saveDocument(path, text, expectedMtimeMs)` | `{ok:true, mtimeMs}` or `{ok:false, reason:'conflict' \| 'not-allowed' \| 'io', currentMtimeMs?, message}`; never rejects |
| `openPath(path)`, `openDialog()` | open a Markdown file (or focus its window); the native Open panel |
| `openExternal(url)` | `http:`, `https:` and `mailto:` only, in the default app |
| `resourceUrl(absPath)` | an asset-protocol URL for an image |
| `makeDefault()` | `{ok, message}` (see above) |
| `onDocumentChanged(cb)` | `cb({path, text, mtimeMs})` when another program changes the file; returns an unsubscribe |
| `selfTestRequested()`, `reportSelfTest(stats)` | self-test mode only |
| `resolvePath(relative)`, `reloadFromDisk()` | resolve a path against the document's folder; re-read and re-render |

The comment code saves through one function, `mdvWriteDocument(text)`, which in the app calls
`mdvHost.saveDocument(mdvHost.currentPath, text, mdvHost.currentMtimeMs)`.

**Saving.** The shell writes only to the file the calling window opened. It compares the file with the
version the page edited (its modification time, and its bytes when it has them, since some file systems
keep times to the second) and refuses on any difference: nothing is overwritten. The write goes to a
temporary file in the same folder, is flushed to disk, keeps the original's permissions and is renamed over
the original. A read-only file, or one that is not UTF-8 text, is not written.

**Live reload.** Each open document is watched through its folder, filtered by name, so editors that save
by writing a new file and renaming it still count. Events are debounced (300 ms). A change that is the
app's own save is recognised and not echoed. If a comment is being saved when a change arrives, the page
does not swap the text under it: the save is refused as a conflict and a **Reload** button appears.

**Self-test mode** is how CI proves the whole chain on each platform:
`kites-markdown --self-test <file.md> --self-test-out <result.json> [--self-test-save-probe]`, or
`KITES_MARKDOWN_SELF_TEST_OUT=<result.json>` with a file opened the way the system opens it. The shell
injects two scripts into the page (only in this mode): one records every console error, uncaught error,
failed resource and CSP violation from the first instant; the other waits for the render (diagrams
included), counts what rendered, checks that the bridge refuses what it must, optionally saves, edits the
file "from outside" and saves a stale version (expecting live reload and a conflict), and finally renders
a document with an `onerror` handler to prove it does not run. The shell adds the window title and the
asset scope, writes the JSON and exits 0 or 1 (or 1 after 60 s without a report).

**CI** (`.github/workflows/desktop.yml`) builds a universal macOS app and a Windows x64 installer, runs the
shell's unit tests, and runs the self-test: on macOS from the command line and through `open -a` (the
Finder path); on Windows after a silent install, from the command line and through the open command the
installer registered for `.md` (the Explorer path), after checking every registry entry; it then
uninstalls and checks that nothing is left. On a `v*` tag a separate job attaches the installers to a
**draft** release, for the owner to publish.

## Security model

A Markdown file is untrusted input, and the app can read and write files. So a document must not be able
to run script, and the page must not be able to reach beyond its own document.

1. **No document script runs.** The app's Content Security Policy allows scripts only from the app itself
   (`script-src 'self'`, no `'unsafe-inline'`, no `'unsafe-eval'`), so an inline `onerror=` or an injected
   `<script>` is blocked even if it reaches the page. The self-test proves this in the real app on each
   platform: a probe image with an `onerror` handler fails to load, and the handler does not run. The
   viewer's HTML sanitizer (roadmap issue 7) is a second layer on top.
2. **The page's only door is the bridge.** A window may call Tauri's core functions and the `mdv_*`
   commands, nothing else: no file-system, shell, opener or dialog API. Each command checks its input:
   - reading and opening accept only existing files with a Markdown extension (after resolving links);
   - saving accepts only the calling window's own file, and only if it has not changed since it was read;
   - external links accept only `http:`, `https:` and `mailto:`.
3. **The window never leaves the app.** Navigation to anything but the app's own page is refused, and
   requests for new windows are refused (a web link opens in the browser instead).
4. **Images load only from each open document's folder and below** (the asset protocol's scope), never from
   elsewhere on the disk.
5. **Native dialogs are driven by the shell.** (The Tauri dialog plugin is deliberately not used: it
   would replace `alert` and `confirm` in the page with asynchronous versions, and a
   `if (!confirm('Delete…?')) return;` would then always proceed.)

**Privacy:** remote images (`https:`) load, as in a browser, so the server hosting one learns that the
document was opened.

## Known limitations

- **Unsigned.** The first launch needs the extra step above, and Windows SmartScreen asks once. Signing and
  notarization need paid certificates; that is the owner's decision.
- **No automatic updates.** Install a newer release over the old one.
- **Linux** is neither built nor tested. Tauri supports it, so `pnpm --dir desktop build` on Linux is a
  starting point.
- **Images outside the document's folder** (for example `../images/x.png`) do not load.
- **A save replaces the file.** Hard links to it then point at the old version, and macOS extended
  attributes (Finder tags, for example) are not carried over.
- **Encodings:** UTF-8 files are read and saved; UTF-16 and other non-UTF-8 files are shown but not saved
  into.
- **Fonts:** the app uses the viewer's fallback fonts (system fonts): it loads nothing from the internet, so
  the web fonts the browser build uses are left out.
- **Not in v1:** tabs, Quick Look previews, a document icon of its own for `.md` files, an "Open Recent"
  menu, and printing from the menu.
