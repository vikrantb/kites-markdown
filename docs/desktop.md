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
| **Mac** | **Kites Markdown → Make Default for Markdown Files…**, or **Make Kites Markdown the default** on the welcome screen. macOS asks you to confirm: choose **Use "Kites Markdown"**. If you keep your current app, Kites Markdown leaves your choice alone and tells you which app still opens them. | In Finder, select any `.md` file → **File → Get Info** (⌘I) → **Open with:** Kites Markdown → **Change All…** → **Continue**. |
| **Windows** | **File → Make Default for Markdown Files…**, or the welcome-screen button: both open Settings at the app's page. | Right-click a `.md` file → **Open with → Choose another app** → Kites Markdown → **Always**. Or **Settings → Apps → Default apps**, search for Kites Markdown. |

The app opens `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt` and `.mdtext`. On a Mac,
`.md` and `.markdown` are macOS's own Markdown type, and the default above covers them, with one
confirmation. The other six get the app's own type, which is still Markdown. Without it, macOS gives those
extensions anonymous types that no app claims, and the viewer is not even offered for them. They open in
Kites Markdown when no other app claims them. Editors such as VS Code claim them by extension, so on a Mac
with one of those, choose Kites Markdown once for one such file: **File → Get Info → Open with → Change
All…**.

On a Mac where nobody has chosen an app for Markdown files, macOS may start using Kites Markdown as soon
as it has been opened once: an app that declares a file type becomes the automatic choice for it.

## Using it

- **One window per document.** Double-clicking a file that is already open brings its window forward. If that
  window shows a document opened from one of its links, it shows its own file again, and **Back** returns to the
  linked document. Opening the app without a file shows the welcome screen, which takes the next file you open.
- **Open files** with **File → Open…** (⌘O / Ctrl+O), by dropping them on a window, or from links.
  **File → New Window** (⌘N / Ctrl+N) opens an empty window; **View → Reload** (⌘R / Ctrl+R) re-reads
  the document on screen; **Close Window** is ⌘W / Ctrl+W.
- **Links in a document:** a link to another Markdown file opens that file in the same window, and **Back**
  (**Go → Back**, ⌘[ on a Mac, `Alt+←`, or the arrow at the left of the toolbar) returns to where you were, with
  the focus on that link; **Go → Forward** (⌘] / `Alt+→`) goes on again. ⌘-click (Ctrl-click) opens it in a
  window of its own. Web and email links open in your browser or mail app; links within the page
  scroll. Links to other kinds of file are not opened (a short notice says so), and the window never navigates
  away from the app.
- **A document opened from a link** is shown in the window, but the window still belongs to the file it opened:
  the shell saves and watches only that one. The page reads the linked document again every 2 s to follow its
  changes (and **View → Reload** reads it at once), and a comment on it is kept in the comments panel to download
  rather than saved into it. To comment on a linked document, ⌘-click (Ctrl-click) the link to open it in a window
  of its own.
- **Images** with a relative path (`![chart](images/chart.png)`) load from the document's folder and the
  folders below it, dot-folders such as `.github/` and `.gitbook/assets/` included. Images elsewhere on
  the disk do not load.
- **Live reload:** when another program saves the file, the window shows the new version, keeps you on the words
  you were reading (whatever was added above them) with your folded sections folded, marks what changed for a moment
  and says where (**Updated: Status**). If you have comment changes that are not in the file yet, the window waits
  and offers **Reload** instead, and so does **View → Reload**: loading the file's version is then your choice.
- **Comments** (still experimental, see the [README](../README.md)) are saved into the file itself.
- **Paste:** pasting Markdown into an empty window shows it; it is not saved anywhere. That window then
  keeps it: a file you open later opens in a new window. A window that shows a file keeps showing that
  file.

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
  node desktop/scripts/run-self-test.mjs --doc desktop/tests/fixtures/linked/doc.md --expect render,assets,links
  node desktop/scripts/run-self-test.mjs --doc tests/fixtures/folder/README.md --expect render,folder
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
  src-tauri/Info.plist                       imports net.daringfireball.markdown; exports the app's own type for the rarer extensions
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
| `folders.rs` | A folder's Markdown files for the folder sidebar (`mdv_list_directory`): breadth first, never into `.git`, `node_modules` or a dot-folder, never through a link to a folder, at most 5,000 files, 8 folders deep and 100,000 entries looked at |
| `fsio.rs` | Reading (UTF-8, byte-order mark, size limit) and the atomic, conflict-checked save |
| `registry.rs` | Which window shows which file, and which versions of it the page has seen |
| `watch.rs` | Live reload: a folder watch per document, debounced, ignoring the app's own saves |
| `default_app.rs` | Make default: Launch Services on macOS, Settings on Windows |
| `menu.rs`, `dialogs.rs`, `prefs.rs` | The menu bar, native dialogs, the one remembered setting |
| `selftest.rs`, `self-test.js` | Self-test mode |

**How files arrive.** macOS sends an "open documents" event (Finder double-click, Open With, `open -a`),
at launch or later; the app collects files that arrive before it is ready and opens them once it is.
Launch Services keeps the app to one instance there, so the app opens no channel of its own. Windows and
Linux pass the file on the command line; a second launch hands its command line to the running app
(single instance, within the same user session) and exits, and the running app opens the file from a
thread of its own (creating a window inside that hand-over can deadlock on Windows). Within the app:
File → Open…, links, and dropped files.

**The bridge** (`window.mdvHost`, in `js/host.js`) is the only contract between the page and the shell.
In a browser `kind` is `'browser'` and every method is a no-op that returns `null`. It loads after
`comments.js`, because it wraps the final `renderMarkdown`, and before `app.js`, which starts the viewer;
its own start waits for `DOMContentLoaded`. Read it when you use it, never while the scripts load.

| Call | Does |
|---|---|
| `kind`, `currentPath`, `currentMtimeMs`, `currentVersion` | `'desktop'` or `'browser'`; the window's file, and the time and version token of the version on screen |
| `initialDocument()` | the window's document `{path, name, text, mtimeMs, version, readOnly}`, or `null` (welcome screen) |
| `readDocument(path)` | any Markdown file; rejects with `{code, message}` |
| `listDirectory(root)` | the Markdown files under a folder, for the folder sidebar: `{root, name, entries: [{path, rel, name, depth, size, mtimeMs}], truncated, unreadable}`; rejects with `{code, message}` (`not-found`, `not-a-directory`, `io`) |
| `chooseFolder()` | the native folder panel: the chosen folder's path, or `null` |
| `saveDocument(path, text, expectedMtimeMs)` | `{ok:true, mtimeMs, version}` or `{ok:false, reason:'conflict' \| 'not-allowed' \| 'io', currentMtimeMs?, currentVersion?, message}`; never rejects |
| `openPath(path)`, `openDialog()` | open a Markdown file (or focus its window); the native Open panel |
| `openExternal(url)` | `http:`, `https:` and `mailto:` only, in the default app |
| `resourceUrl(absPath)` | an asset-protocol URL for an image |
| `makeDefault()` | `{ok, message}` (see above) |
| `onDocumentChanged(cb)` | `cb({path, text, mtimeMs})` when another program changes the file; returns an unsubscribe. `js/live-reload.js` uses it for the "Updated" note |
| `selfTestRequested()`, `reportSelfTest(stats)` | self-test mode only |
| `resolvePath(relative)`, `reloadFromDisk()` | resolve a path against the document's folder; re-read and re-render |

The comment code saves through one function, `mdvWriteDocument(text)`, which in the app calls
`mdvHost.saveDocument(mdvHost.currentPath, text, mdvHost.currentMtimeMs)`.

**Versions.** Every document the shell sends carries a version token that names its exact bytes. The
page keeps the token of the version on screen; a save names the version its text was made from (the
comment code names it by its time, and the bridge looks up the token it was handed with that time; a
time it was never handed names nothing, and the save is refused). Times decide nothing: some file systems
keep them to the second or coarser, so another program's edit can keep the old time.

**Saving.** The shell writes only to the file the calling window opened, and only while the file still
holds exactly the bytes of the version the save names: on any difference it refuses and writes nothing,
and the refusal names the version on disk, so the page can offer to overwrite exactly that one. The new
text goes to a temporary file in the same folder, created no more readable than the document, flushed to
disk, given the original's permissions, and renamed over the original after one more look at the file (an
edit that lands while the text is being flushed is kept, and the save is refused). A file you may not
write (read-only, or writable only by others), or one that is not UTF-8 text, is not written.

**Following links in the window.** A relative link to a Markdown file is read with `readDocument` and shown in
the same window through the viewer's load seam (`mdvOpenDocument`, `js/files.js`), which points the bridge at it
(`currentPath`, `currentMtimeMs`): its images and its own links resolve from its folder, and a comment save names
its path, which the shell refuses for any file but the window's own (`not-allowed`), so the window's file is never
written with another document's text. The shell neither watches it nor knows the window shows it: the page reads it
every 2 s while it is visible (`js/live-reload.js`), Back and Forward use the page's own history (`js/history.js`),
and ⌘/Ctrl-click still goes to `openPath`. Back reads a document again before it shows it, so the window's own file
comes back as it is on disk now: the shell's change events for it were let pass while another document was shown.
The shell's own commands follow the document on screen: **View → Reload** sends the window's file as always
(`mdv://document-changed`, reason `reload`), and `js/host.js` reloads the linked document on screen instead; opening
the window's own file again (`open_path` finds its window) also sends it that file (`mdv://open-document`, reason
`focus`), and the page shows it as a new place, so Back returns to the linked document; **Go → Back** and **Go →
Forward** send `mdv://go` (`back` or `forward`), and the page goes to the previous or next document. The bridge
remembers the versions of the window's own file whatever is on screen, so a save after Back names the right one.

**Live reload.** Each open document is watched through its folder, filtered by name, so editors that save
by writing a new file and renaming it still count. Events are debounced (300 ms). A change that is the
app's own save is recognised and not echoed. If the page has comment changes that are not in the file (a
save in flight, or one that was refused), it does not swap the text under them: a **Reload** button
appears, and a save made meanwhile names the version on screen, so the shell refuses it rather than write
over the other program's change. **View → Reload** asks the same way.

**Self-test mode** is how CI proves the whole chain on each platform:
`kites-markdown --self-test <file.md> --self-test-out <result.json> [--self-test-save-probe]`, or
`KITES_MARKDOWN_SELF_TEST_OUT=<result.json>` with a file opened the way the system opens it. The shell
injects two scripts into the page (only in this mode): one records every console error, uncaught error,
failed resource and CSP violation from the first instant; the other waits for the render (diagrams
included), counts what rendered, checks that the bridge refuses what it must, each for its own reason (a
save into an existing sibling file, naming that file's real version, must be refused as `not-allowed`
and leave the file unchanged), calls `confirm()` and `alert()` on macOS (the shell answers them without
showing anything in this mode, and must have), optionally saves, edits the file "from outside" and saves
a stale version (expecting live reload and a conflict), lists the document's folder through `mdv_list_directory` and
opens the folder sidebar on it (`--expect folder` checks the listing of `tests/fixtures/folder` against its
`expected.json`, with a `.git` and a `node_modules` folder added), follows the linked fixture's link to `other.md` (it
must open in the same window, with no new window asked for), opens the window's own file again through `mdv_open_path`
(the window must show it, and Back must return to `other.md`), goes Back once more (to the window's own file), and
finally renders a document with an `onerror` handler to prove it does not run. What the viewer remembers between
launches (recent documents, the folder and its sidebar) is never written to the installed app's storage during a run:
from before the page's scripts start, those `localStorage` keys live in memory (`self-test.js` wraps
`Storage.prototype` for them alone), and the report says whether the real store still holds what it held before
(`remembered.untouched`, required by `--expect render`). The shell adds the window title and the asset scope, writes the JSON
and exits 0 or 1 (1 after 60 s without a report, and 1 if the report cannot be written).

**CI** (`.github/workflows/desktop.yml`) builds a universal macOS app and a Windows x64 installer with a
pinned Rust toolchain and `--locked`, runs the shell's unit tests, and runs the self-test: on macOS from
the command line and through `open -a` (the Finder path); on Windows after a silent install, from the
command line and through the open command the installer registered for `.md` (the Explorer path), after
checking every registry entry; it then uninstalls and checks that nothing is left for any of the eight
extensions. Every action is pinned to a commit. On a `v*` tag a separate job attaches the installers that
run built and self-tested to a **draft** release, for the owner to publish; nothing is rebuilt for it.

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
   - listing a folder (the folder sidebar) accepts only an existing folder, canonicalized, and returns only the names,
     sizes and times of the Markdown files under it, within the limits above; like reading, it opens nothing,
     watches nothing and permits no save;
   - saving accepts only the calling window's own file, and only over the exact version (the bytes) the
     page's text was made from;
   - external links accept only `http:`, `https:` and `mailto:`.
3. **The window never leaves the app.** Navigation to anything but the app's own page is refused, and
   requests for new windows are refused (a web link opens in the browser instead).
4. **Images load only from the folders of the documents opened in this session, and below them** (the
   asset protocol's scope). A page asks only for images inside its own document's folder, so the shell
   never even looks at another path for it (on Windows, looking at a network path would connect to that
   host). The scope itself only grows during a session: Tauri cannot take a folder back, so the folder of a
   document opened earlier stays readable as images until the app quits. Images cannot run script.
5. **Dialogs are native.** `alert()` and `confirm()` in the page show a native alert and wait for it: on
   macOS the shell answers WebKit's dialog requests itself (WKWebView shows nothing otherwise, and every
   `confirm()` would answer Cancel at once); on Windows WebView2 shows its own. The Tauri dialog plugin is
   deliberately not used: it would replace `alert` and `confirm` with asynchronous versions, and a
   `if (!confirm('Delete…?')) return;` would then always proceed.
6. **A save never exposes or loses more than the file allows.** The temporary file holding the new text
   is created with the document's own permissions, so a private document's new text is never readable by
   others while it is written. A file whose permissions forbid you to write it is not replaced, even where
   the folder would allow it.
7. **No shared channel between users.** On macOS the app has no single-instance socket: the usual one is a
   fixed path in the shared `/tmp`, where another user's process could answer first, receive the paths of
   the files you open, and stop every launch. Launch Services keeps the app to one instance instead. On
   Windows the single-instance channel lives in your own session.

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
- **The last instant of a save.** The file is checked once more just before the new text is renamed over
  it, but no file system offers a rename that compares first: an edit another program makes in that
  instant is still replaced.
- **On a Mac, running the program file itself** (`…/Kites Markdown.app/Contents/MacOS/kites-markdown`)
  starts a second instance; opening files the usual ways (Finder, `open`, the Dock) does not.
- **Encodings:** UTF-8 files are read and saved; UTF-16 and other non-UTF-8 files are shown but not saved
  into.
- **Fonts:** the app uses the viewer's fallback fonts (system fonts): it loads nothing from the internet, so
  the web fonts the browser build uses are left out.
- **A document opened from a link in the same window** is not saved into (comments on it stay in the comments
  panel to download), the window's title keeps that file's name, and images outside the folders of the documents
  opened in this session do not load. ⌘/Ctrl-click opens it in a window of its own, where all of these work.
- **Not in v1:** tabs, Quick Look previews, a document icon of its own for `.md` files, an "Open Recent"
  entry in the native menu bar (the recent documents are in the toolbar's clock menu and on the welcome screen), and
  printing from the menu.
