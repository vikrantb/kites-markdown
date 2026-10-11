// ============================================
// File handling
// ============================================
function handleFileInput(e) {
  const files = e.target.files;
  if (!files || !files.length) return;
  const file = files[0];
  readFile(file);
  // Reset so the same file can be picked again
  try { e.target.value = ''; } catch(_) { e.target.type = ''; e.target.type = 'file'; }
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      rawMarkdown = ev.target.result;
      currentFileName = file.name;
      // Drag-drop / file input has no writable handle. Try the workspace
      // folder first (zero popups if user has set one). Otherwise clear
      // any stale handle and prompt on first save.
      if (typeof mdvFileHandle !== 'undefined') {
        mdvFileHandle = null;
        const wsHandle = await (typeof mdvTryWorkspaceMatch !== 'undefined' ? mdvTryWorkspaceMatch(file.name) : null);
        if (wsHandle) {
          mdvFileHandle = wsHandle;
          try { await mdvPutHandle('current', wsHandle); } catch (e) {}
          mdvSetStatus && mdvSetStatus('Linked via workspace ✓');
        } else {
          mdvSetStatus && mdvSetStatus('No save location — click 📁 to set workspace', 'error');
        }
      }
      await mdvOpenDocument({ name: file.name, text: rawMarkdown, handle: typeof mdvFileHandle !== 'undefined' ? mdvFileHandle : null, kind: 'file' });
    } catch (err) {
      console.error('Render error:', err);
      alert('Error rendering file: ' + err.message);
    }
  };
  reader.onerror = () => {
    console.error('Failed to read file:', file.name);
    alert('Failed to read file: ' + file.name);
  };
  reader.readAsText(file);
}

// A file dropped on the page is read through a handle where the browser gives one (Chromium:
// DataTransferItem.getAsFileSystemHandle), so live reload follows it like any file opened with a handle. A file chosen
// with the Open button, or dropped elsewhere, is read once (readFile): a File is a snapshot, and that copy says so
// (js/live-reload.js), with a way to follow the file where the browser has one. The handle only reads; the comment
// code asks for permission to write the first time a comment is saved.
const MDV_OPEN_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdx'], 'text/plain': ['.txt', '.text'] } }];

function mdvCanOpenWithHandle() { return !mdvInDesktopApp() && typeof window.showOpenFilePicker === 'function'; }

function mdvOpenFileHandle(handle, opts) {
  return mdvOpenDocument({ handle, name: handle.name, kind: 'handle' }, opts);
}

// Picks a file through the File System Access picker and shows it, followed (the "Follow…" of a copy). `opts` as
// mdvOpenDocument's. Resolves false when the reader cancels.
async function mdvPickToFollow(opts) {
  if (!mdvCanOpenWithHandle()) return false;
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ multiple: false, types: MDV_OPEN_TYPES });
  } catch (err) {
    if (!err || err.name !== 'AbortError') console.warn('MDV: the file could not be opened:', err);
    return false;
  }
  return mdvOpenFileHandle(handle, opts);
}

// Drag & drop
const dropZone = document.getElementById('dropZone');
['dragenter','dragover'].forEach(evt => {
  document.body.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
  if (dropZone) dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
});
['dragleave','drop'].forEach(evt => {
  if (dropZone) dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'));
});
document.body.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation();
  const file = e.dataTransfer.files[0];
  if (!file || !/\.(md|markdown|mdx|txt|text)$/i.test(file.name)) return;
  // The handle must be asked for during the drop event itself
  const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
  const asked = item && !mdvInDesktopApp() && typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null;
  if (!asked) { readFile(file); return; }
  asked.then((h) => (h && h.kind === 'file' ? h : null), () => null).then((h) => (h ? mdvOpenFileHandle(h) : readFile(file)));
});

// Paste
document.addEventListener('paste', e => {
  if (document.getElementById('searchOverlay').classList.contains('show')) return;
  // A paste into a text field (comment box, settings) belongs to that field, not to the document.
  const target = e.target;
  if (target && (target.isContentEditable || (target.closest && target.closest('input, textarea, select')))) return;
  const text = e.clipboardData.getData('text');
  if (text && text.length > 10) {
    // Pasted text is a new, unsaved document with no file: the seam unlinks the opened file, so a later
    // comment save cannot write the pasted text over it.
    mdvOpenDocument({ name: 'Pasted Content', text, kind: 'pasted' });
  }
});

// URL-based file loading
async function loadFromUrl() {
  const url = new URL(window.location);
  const filePath = url.searchParams.get('file');
  if (!filePath) {
    if (url.hash === '#demo') loadDemo();
    return;
  }

  const isFileProtocol = window.location.protocol === 'file:';

  // If running on a server (http/https), try to fetch the file
  if (!isFileProtocol) {
    const basePath = localStorage.getItem('mdv-basepath') || '';
    const pathsToTry = [filePath];
    if (basePath) pathsToTry.push(basePath + filePath);

    for (const p of pathsToTry) {
      try {
        const resp = await fetch(p);
        if (resp.ok) {
          const text = await resp.text();
          // A fetched document has no writable handle. If the last-opened file was restored while this
          // fetch was in flight, the seam unlinks it, so a comment save cannot overwrite it.
          await mdvOpenDocument({ name: filePath.split('/').pop(), text, path: p, kind: 'http', title: filePath });
          return;
        }
      } catch (_) {}
    }
  }

  // Can't fetch (file:// or server path not found) — show helpful UI
  const fileName = filePath.split('/').pop();
  document.getElementById('titleText').textContent = fileName;
  document.getElementById('breadcrumb').textContent = filePath;

  // Replace welcome screen with a helpful "open this file" prompt
  const welcome = document.getElementById('welcomeScreen');
  welcome.innerHTML = `
    <div class="drop-zone" id="dropZone2" style="max-width:560px">
      <div class="drop-zone-icon">&#128196;</div>
      <div class="drop-zone-title" style="margin-bottom:8px">Open: ${escapeHtml(fileName)}</div>
      <div class="drop-zone-sub" style="margin-bottom:4px;font-family:var(--font-mono);font-size:0.75rem;color:var(--text-tertiary);word-break:break-all">${escapeHtml(filePath)}</div>
      <div class="drop-zone-sub" style="margin-bottom:16px">
        ${isFileProtocol
          ? 'Cannot auto-load from <code>file://</code>. Drag the file here, browse to it, or serve via a local server.'
          : 'File not found on server. Drag the file here or browse to it.'}
      </div>
      <button class="drop-btn" data-action="browse-file">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
        Browse to ${escapeHtml(fileName)}
      </button>
      <div class="drop-or">or drag & drop the file here</div>
      ${isFileProtocol ? `<div style="margin-top:14px;padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-sm);text-align:left">
        <div style="font-size:0.72rem;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">To enable auto-loading, serve a folder that contains both this viewer and your files:</div>
        <code style="font-size:0.78rem;display:block;padding:6px 8px;background:var(--bg-code);border-radius:4px;word-break:break-all">cd /path/to/that/folder && python3 -m http.server 8080 --bind 127.0.0.1</code>
        <div style="font-size:0.7rem;color:var(--text-tertiary);margin-top:4px">Then open: <code style="font-size:0.7rem">http://localhost:8080/&lt;path-to&gt;/markdown-viewer.html?file=${escapeHtml(filePath)}</code></div>
      </div>` : ''}
    </div>
  `;

  // Re-bind drag & drop on the new drop zone
  const dz2 = document.getElementById('dropZone2');
  if (dz2) {
    ['dragenter','dragover'].forEach(evt => {
      dz2.addEventListener(evt, e => { e.preventDefault(); dz2.classList.add('drag-over'); });
    });
    ['dragleave','drop'].forEach(evt => {
      dz2.addEventListener(evt, () => dz2.classList.remove('drag-over'));
    });
  }
}

// ============================================
// The load seam: every document is shown through mdvOpenDocument
// ============================================
// The file chooser and drag-and-drop (readFile, or a handle), paste, ?file= links (loadFromUrl), links between
// documents (js/document-links.js), Back/Forward (js/history.js), live reload (js/live-reload.js) and the folder
// features all show a document through it; none of them renders one any other way.
//
//   mdvOpenDocument({name, text, path, handle, mtimeMs}, {push}) → Promise<boolean>
//
//   doc.name       the file name, for the title
//   doc.text       the Markdown. With a handle, text the comment code has not read through that handle (or
//                  no text at all) is read again through mdvOpenWithHandle, which records the version a
//                  comment save compares the file with (CLAUDE.md)
//   doc.path       where it came from: the ?file= path over http, an absolute path in the desktop app, a path
//                  in the open folder; none for pasted text. The document's links are resolved against it.
//   doc.handle     the FileSystemFileHandle it was read from (browser), or none
//   doc.mtimeMs    when the file last changed, when known
//   doc.kind       optional: 'http' (fetched from a server), 'file' (chosen or dropped, no handle), 'pasted',
//                  'handle', 'folder', 'desktop'; inferred when absent (only an http loader says 'http')
//   doc.title      optional: what the toolbar shows (a relative path shows as the breadcrumb)
//   doc.sourceText optional: the text as its file or server gave it, when doc.text differs from it (Back shows a
//                  document with the comment changes it had when the reader left). Live reload compares the file
//                  with this version.
//   opts.push      true (the default): a new place in Back/Forward. false: the current place shows it instead.
//   opts.fragment  open at this id (a link's #fragment) instead of at the top
//   opts.position  open at this reading position (mdvReadingPosition(), taken when the reader left it)
//   opts.history   set only by js/history.js: Back/Forward moved the browser to this entry
//
// It resolves true once the document is on screen, and false when it could not be shown (the one on screen stays)
// or when a newer open overtook it: the newest open wins. A file read through a handle takes time; an open that
// starts meanwhile (or any other document shown meanwhile) makes the slower one give up before it renders, so it
// can never replace the document the reader chose since, nor add a place to Back/Forward. mdvOpenSeq counts the
// opens: a caller that got false while mdvOpenSeq moved past its own open was overtaken, not refused.
//
// The same document opened again (a live reload, say) keeps the reader's place (js/reading-place.js): the words at
// the top of the window stay where they were, folded sections stay folded. Any other document opens at the top, or
// at opts.fragment.
//
// Every render of a document, through the seam or not (the comment code reopening a file, the desktop
// bridge, a test), is followed (mdvTrackRenders), so what follows the document always knows what is shown:
//   mdvShownDocument()        the record of the document on screen, or null (the welcome screen)
//   mdvOnDocumentOpening(fn)  fn(event) just before a document replaces the page, while the old one is still
//                             on screen (Back/Forward records the reader's place in it here)
//   mdvOnDocumentOpened(fn)   fn(event) once it is on screen (the title, live reload, recent documents)
//   mdvOnDocumentDrawn(fn)    fn() after every render of the page, the comment code's own redraws included
// event: {kind, doc, previous, position, push, fragment, history, previousText}; kind is 'first' (nothing was
// on screen), 'open' (another document), 'reload' (the same document again) or 'history' (Back/Forward).
// Each returns an unsubscribe function.

let mdvShown = null;        // {doc}: the document on screen; null while the welcome screen shows
let mdvPendingOpen = null;  // {doc, opts, position, viaHandle, seq}: the newest open the seam has started, until it renders
let mdvOpenSeq = 0;         // counts opens; an open that a newer one overtook gives up before it renders
const mdvDocumentHooks = { opening: [], opened: [], drawn: [] };

function mdvAddDocumentHook(list, fn) {
  list.push(fn);
  return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
}
function mdvOnDocumentOpening(fn) { return mdvAddDocumentHook(mdvDocumentHooks.opening, fn); }
function mdvOnDocumentOpened(fn) { return mdvAddDocumentHook(mdvDocumentHooks.opened, fn); }
function mdvOnDocumentDrawn(fn) { return mdvAddDocumentHook(mdvDocumentHooks.drawn, fn); }
function mdvShownDocument() { return mdvShown ? mdvShown.doc : null; }

function mdvEmitDocument(list, event) {
  for (const fn of list.slice()) {
    try { fn(event); } catch (e) { console.warn('MDV document hook:', e); }
  }
}

function mdvInDesktopApp() { return !!(window.mdvHost && window.mdvHost.kind === 'desktop'); }

async function mdvOpenDocument(doc, opts) {
  opts = Object.assign({ push: true }, opts);
  doc = mdvNormalizeDocument(doc);
  mdvTrackRenders();
  const desktop = mdvInDesktopApp();
  const viaHandle = !desktop && !!doc.handle && mdvMustReadThroughHandle(doc);
  if (viaHandle ? typeof mdvOpenWithHandle !== 'function' : typeof doc.text !== 'string') return false;
  const seq = ++mdvOpenSeq;
  const previous = mdvShownDocument();
  const position = previous ? mdvReadingPosition() : null;
  mdvStopHoldingPlace();
  if (viaHandle) {
    mdvPendingOpen = { doc, opts, position, viaHandle: true, seq };
    // Another document shown while the file is read (ifSeq), or a newer open begun (wanted): this one gives up
    const loads = typeof mdvLoadSeq === 'number' ? mdvLoadSeq : null;
    let shown = false;
    try {
      shown = !!(await mdvOpenWithHandle(doc.handle, { prompt: false, ifSeq: loads, wanted: () => seq === mdvOpenSeq }));
    } catch (e) {
      console.warn('MDV: "' + doc.name + '" could not be opened:', e);
    } finally {
      if (mdvPendingOpen && mdvPendingOpen.seq === seq) mdvPendingOpen = null;
    }
    if (!shown) return false;
  } else {
    if (desktop && doc.path) mdvPointBridgeAt(doc);
    // A document is only linked to the file handle it was read from (CLAUDE.md)
    if (typeof mdvFileHandle !== 'undefined') mdvFileHandle = desktop ? null : doc.handle;
    rawMarkdown = doc.text;
    currentFileName = doc.name;
    mdvPendingOpen = { doc, opts, position, viaHandle: false, seq };
    try {
      renderMarkdown(doc.text, mdvDocumentTitle(doc));
    } finally {
      if (mdvPendingOpen && mdvPendingOpen.seq === seq) mdvPendingOpen = null;
    }
  }
  if (opts.fragment && mdvOpenAtFragment(opts.fragment)) return true;
  const keepPlace = !!previous && mdvSameDocument(previous, doc);
  const place = opts.position || (keepPlace ? position : null);
  if (place) mdvRestoreReadingPosition(place);
  // Any other document opens at its top at once. (The stylesheet scrolls smoothly, so renderMarkdown's own scroll
  // to the top glides through the new document from where the old one was read, and may stop part-way.)
  else window.scrollTo({ top: 0, behavior: 'instant' });
  return true;
}

function mdvNormalizeDocument(doc) {
  const d = Object.assign({}, doc);
  d.handle = d.handle || null;
  d.path = d.path == null || d.path === '' ? null : String(d.path);
  d.name = String(d.name || (d.handle && d.handle.name) || (d.path && d.path.split(/[\\/]/).pop()) || 'Untitled');
  d.mtimeMs = Number.isFinite(d.mtimeMs) ? d.mtimeMs : null;
  if (typeof d.sourceText !== 'string') delete d.sourceText;
  // The http loaders say 'http'; any other path with no handle is a file of the open folder
  if (!d.kind) {
    if (mdvInDesktopApp()) d.kind = d.path ? 'desktop' : 'pasted';
    else d.kind = d.handle ? 'handle' : d.path ? 'folder' : 'text';
  }
  return d;
}

// What the toolbar shows: a relative path (a ?file= link, a file in the open folder) shows as the breadcrumb
function mdvDocumentTitle(doc) {
  if (doc.title) return doc.title;
  if (doc.path && doc.kind !== 'desktop' && !/^(?:[a-zA-Z]:)?[\\/]/.test(doc.path)) return doc.path;
  return doc.name;
}

function mdvShowTitle(doc) {
  document.title = mdvInDesktopApp() ? doc.name : doc.name + ' - Markdown Viewer';
}

// Two paths of one kind of document, compared as the place they name
function mdvSamePath(a, b, kind) {
  if (!a || !b) return false;
  if (kind === 'http') {
    try { return new URL(a, location.href).href === new URL(b, location.href).href; } catch (e) { return a === b; }
  }
  if (kind === 'desktop' && /Mac|Win/i.test(navigator.platform || navigator.userAgent || '')) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// Whether two document records name the same document (opening it again is a reload) or different ones
function mdvSameDocument(a, b) {
  if (!a || !b) return false;
  if (a.path && b.path) return a.kind === b.kind && mdvSamePath(a.path, b.path, a.kind);
  if (a.handle || b.handle) return a.handle === b.handle;
  if (a.path || b.path || a.kind !== b.kind) return false;
  // A chosen or dropped file is known by its name only, and two folders can hold a README.md each: it is the same
  // document only as the same text. Pasted text is always new.
  if (a.kind === 'file') return a.name === b.name && typeof a.text === 'string' && a.text === b.text;
  // Text with no file behind it: the same page again (the demo, a test's render)
  return a.kind !== 'pasted' && a.name === b.name;
}

// The comment code records, per handle, the version of the file it read or wrote (mdvBases). Text it has not
// recorded is read again through mdvOpenWithHandle, so a later comment save compares the file with what is shown.
function mdvMustReadThroughHandle(doc) {
  if (typeof doc.text !== 'string') return true;
  try {
    const base = mdvBases.get(doc.handle);
    return !base || !!base.overwrite || base.text !== doc.text;
  } catch (e) {
    return true;
  }
}

// In the desktop app the bridge saves, shows relative images and follows links for the document on screen. A
// document opened in the window from a link becomes the window's document there: its images and links resolve
// from its own folder, and a comment save is the shell's call (it writes only the file the window opened).
function mdvPointBridgeAt(doc) {
  const host = window.mdvHost;
  try { host.currentPath = doc.path; } catch (e) { /* a bridge that keeps it itself */ }
  if (Number.isFinite(doc.mtimeMs)) {
    try { host.currentMtimeMs = doc.mtimeMs; } catch (e) { /* idem */ }
  }
}

// A render the seam did not start (the comment code reopening a file, the desktop bridge, a test): what it
// shows, from the globals every loader sets before it renders.
function mdvDescribeRender(source, title) {
  const host = window.mdvHost;
  if (mdvInDesktopApp()) {
    const name = String(currentFileName || title || 'Untitled').split(/[\\/]/).pop();
    return mdvNormalizeDocument({ name, path: host.currentPath || null, mtimeMs: host.currentMtimeMs, title });
  }
  const handle = typeof mdvFileHandle !== 'undefined' ? mdvFileHandle : null;
  if (handle) return mdvNormalizeDocument({ name: currentFileName || handle.name, handle, kind: 'handle', title });
  const name = String(title || currentFileName || 'Untitled').split('/').pop();
  return mdvNormalizeDocument({ name, kind: title === 'Pasted Content' ? 'pasted' : 'text', title });
}

function mdvTakePendingOpen(source) {
  const p = mdvPendingOpen;
  if (!p) return null;
  const mine = p.viaHandle
    ? typeof mdvFileHandle !== 'undefined' && mdvFileHandle === p.doc.handle
    : String(source == null ? '' : source) === p.doc.text;
  if (!mine) return null;
  mdvPendingOpen = null;
  return p;
}

// Follows every render of a document. Installed once every script has loaded (and by the first open), around
// the comment code's renderMarkdown hook; the desktop bridge wraps it in turn.
function mdvTrackRenders() {
  if (mdvTrackRenders.installed || typeof window.renderMarkdown !== 'function') return;
  mdvTrackRenders.installed = true;
  const inner = window.renderMarkdown;
  window.renderMarkdown = function (source, title) {
    // The comment code drawing the same version again in place (mdvRerender) is not a new document
    if (typeof mdvOwnRender !== 'undefined' && mdvOwnRender) {
      const drawn = inner.apply(this, arguments);
      mdvEmitDocument(mdvDocumentHooks.drawn, null);
      return drawn;
    }
    const pending = mdvTakePendingOpen(source);
    const previous = mdvShownDocument();
    const doc = pending ? pending.doc : mdvDescribeRender(source, title);
    if (!pending) doc.text = String(source == null ? '' : source); // a chosen file is the same document only as the same text
    const kind = !previous ? 'first'
      : pending && pending.opts.history ? 'history'
      : mdvSameDocument(previous, doc) ? 'reload' : 'open';
    const event = {
      kind, doc, previous,
      // The reader's place in the document being replaced, which is still on screen
      position: pending ? pending.position : previous ? mdvReadingPosition() : null,
      push: kind === 'open' && !(pending && pending.opts.push === false),
      fragment: (pending && pending.opts.fragment) || null,
      history: (pending && pending.opts.history) || null,
      // That document as the comment code holds it now: with the comment changes made since it opened
      previousText: typeof mdvDocText === 'string' ? mdvDocText : previous ? previous.text : null,
    };
    mdvEmitDocument(mdvDocumentHooks.opening, event);
    const result = inner.apply(this, arguments);
    doc.text = String(source == null ? '' : source);
    if (kind === 'reload') {
      // Keep what only the earlier record knew (the folder path of a file the comment code read again)
      for (const k of ['path', 'title']) if (doc[k] == null && previous[k] != null) doc[k] = previous[k];
    }
    mdvShown = { doc };
    mdvShowTitle(doc);
    mdvEmitDocument(mdvDocumentHooks.drawn, null);
    mdvEmitDocument(mdvDocumentHooks.opened, event);
    return result;
  };
  // A document on screen before this ran (the #demo page renders while the scripts load) is the first one
  if (!mdvShown && typeof rawMarkdown === 'string' && rawMarkdown) {
    const titleEl = document.getElementById('titleText');
    const doc = mdvDescribeRender(rawMarkdown, titleEl ? titleEl.textContent : '');
    doc.text = rawMarkdown;
    mdvShown = { doc };
  }
}
document.addEventListener('DOMContentLoaded', mdvTrackRenders);
