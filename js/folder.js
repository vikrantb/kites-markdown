// ============================================
// The folder: the Markdown documents in a folder the reader opened
// ============================================
// A reader of agent-written notes (status reports, handoffs, proposals) reads folders of related
// documents. This file is the folder itself; the sidebar (folder-tree.js), quick open (quick-open.js),
// search across files (folder-search.js), recent documents (recents.js) and link previews
// (link-preview.js) are built on it.
//
// window.mdvFolder is the contract other code uses (wave 2):
//   kind      'browser' (a folder picked with showDirectoryPicker), 'desktop' (listed by the shell's
//             mdv_list_directory), or null when no folder is open
//   rootName  the folder's name
//   list()    [{path, name, depth, rel}]: every Markdown file found, in the sidebar's order (folders
//             first, then files, each by name). depth counts the folders between the root and the file.
//   read(path)           Promise<{name, text, path, handle, mtimeMs}>; rejects with {code, message}, where
//             message is a clause without a closing full stop ('notes/a.md is not in notes')
//   resolve(fromPath, href)  the path a link in the document at fromPath leads to, when it is a Markdown
//             file inside the folder; otherwise null. Lexical: read() finds out whether it exists.
//             fromPath null means the document on screen: a relative link then resolves from its place in the
//             folder, and to null when it is not in the folder (or nothing is on screen). A web address, a
//             protocol-relative '//host/…' link and a path that leaves the folder are null. A leading '/' is the
//             folder's top, as a repository's links mean it; in the desktop app an absolute path that lies inside
//             the folder is taken as that path.
// Paths are folder-relative in a browser ('handoffs/2026-10-01.md') and absolute in the desktop app.
//
// The listing never enters .git, node_modules or any folder whose name starts with a dot, and stops at
// 5,000 files, 8 folders deep, or 100,000 folder entries looked at: the shell's walk
// (desktop/src-tauri/src/folders.rs) keeps the same rules, so both builds list the same files.
//
// A document is shown only through mdvOpenDocument (js/files.js), by js/folder-open.js (the last request wins, and
// the reader's place is kept); this file never renders one itself.

const MDV_FOLDER_LIMITS = { entries: 5000, depth: 8, visited: 100000 };
// A folder that changes while the reader works (agents add files) is listed again when the window comes back
// into focus, at most this often.
const MDV_FOLDER_STALE_MS = 5000;

const mdvFolderState = {
  kind: null,          // 'browser' | 'desktop' | null
  root: null,          // browser: FileSystemDirectoryHandle; desktop: the folder's absolute path
  rootName: '',
  entries: [],         // [{path, rel, name, depth, dir, size, mtimeMs, handle}] in tree order
  byPath: new Map(),
  truncated: false,
  unreadable: 0,
  listedAt: 0,
  loading: false,      // a listing is running
  progress: 0,         // files found so far by a running browser walk
  error: null,         // why the last listing failed
  waiting: null,       // browser: a remembered folder that needs the reader's permission again
  generation: 0,       // each listing; a slower, older one never overwrites a newer one
  openId: 0,           // each folder opened: what belongs to one folder (the search index, the tree's open
                       // folders) is keyed by it, never by the folder's name, which two folders can share
  current: null,       // the folder path of the document on screen, when it is in the folder
  shown: null,         // what is on screen: {kind: 'path'|'handle', path, handle, name, folderPath}
  pendingOpen: null,   // a document this file asked mdvOpenDocument to show, until it is on screen
  shownLoad: null,     // {seq, identity}: the document load that showed it (comment re-renders keep it)
};

// ------- Events: 'change' (the folder or its listing), 'current' (the document on screen in it), 'shown',
// 'times' (the files' sizes and times, which a browser listing learns later: mdvFolderLearnTimes) -------
const mdvFolderListeners = { change: new Set(), current: new Set(), shown: new Set(), times: new Set() };
function mdvFolderOn(type, fn) {
  mdvFolderListeners[type].add(fn);
  return () => mdvFolderListeners[type].delete(fn);
}
function mdvFolderEmit(type, detail) {
  for (const fn of [...mdvFolderListeners[type]]) {
    try { fn(detail); } catch (e) { console.warn('folder ' + type + ' listener:', e); }
  }
}

function mdvFolderIsDesktop() { return !!(window.mdvHost && window.mdvHost.kind === 'desktop'); }
// ------- Listing -------
function mdvFolderAccept(entries) {
  entries.sort((a, b) => mdvFolderCompareRel(a.rel, b.rel));
  for (const e of entries) {
    const i = e.rel.lastIndexOf('/');
    e.dir = i < 0 ? '' : e.rel.slice(0, i);
  }
  mdvFolderState.entries = entries;
  mdvFolderState.byPath = new Map(entries.map((e) => [e.path, e]));
}

// The browser's walk: breadth-first, so a limit keeps the files nearest the top, as the shell's does.
async function mdvFolderWalk(dir, generation) {
  const entries = [];
  let truncated = false, unreadable = 0, visited = 0;
  const queue = [{ handle: dir, rel: '', depth: 0 }];
  walk: while (queue.length) {
    const { handle, rel, depth } = queue.shift();
    const items = [];
    try {
      for await (const [name, child] of handle.entries()) {
        if (visited >= MDV_FOLDER_LIMITS.visited) { truncated = true; break; }
        visited++;
        items.push([name, child]);
      }
    } catch (e) {
      unreadable++;
      continue;
    }
    if (generation !== mdvFolderState.generation) return null;
    items.sort((a, b) => mdvFolderCollator.compare(a[0], b[0]));
    for (const [name, child] of items) {
      if (child.kind === 'directory') {
        if (!mdvFolderSkipped(name) && depth < MDV_FOLDER_LIMITS.depth) queue.push({ handle: child, rel: rel + name + '/', depth: depth + 1 });
      } else if (MDV_FOLDER_MARKDOWN.test(name)) {
        entries.push({ path: rel + name, rel: rel + name, name, depth, handle: child, size: null, mtimeMs: null });
        if (entries.length >= MDV_FOLDER_LIMITS.entries) { truncated = true; break walk; }
      }
    }
    if (truncated) break;
    // "Listing… N files so far", for a first listing only: listing again keeps the tree on screen as it is.
    if (!mdvFolderState.entries.length && entries.length - mdvFolderState.progress >= 50) {
      mdvFolderState.progress = entries.length;
      mdvFolderEmit('change');
    }
  }
  return { entries, truncated, unreadable };
}

async function mdvFolderList(generation) {
  const s = mdvFolderState;
  if (s.kind === 'desktop') {
    const listing = await window.mdvHost.listDirectory(s.root);
    return {
      root: listing.root, name: listing.name, truncated: !!listing.truncated, unreadable: listing.unreadable || 0,
      entries: (listing.entries || []).map((e) => ({ path: e.path, rel: e.rel, name: e.name, depth: e.depth, size: e.size, mtimeMs: e.mtimeMs, handle: null })),
    };
  }
  const walked = await mdvFolderWalk(s.root, generation);
  return walked && Object.assign({ root: s.root, name: s.root.name }, walked);
}

// Lists the open folder again. The reader's place in it (the current document) is kept. Listing again happens often
// (the window coming back, quick open and search in files after a few seconds), and usually finds the same files:
// then the entries, the tree on screen and their order stay as they are (only the desktop listing's sizes and times
// are taken), so a large folder is not sorted and drawn again for nothing.
async function mdvFolderRefresh() {
  const s = mdvFolderState;
  if (!s.kind) return false;
  const generation = ++s.generation;
  s.loading = true;
  s.progress = 0;
  if (!s.entries.length) mdvFolderEmit('change'); // "Listing the folder…"; with a tree on screen, nothing changes yet
  let listing = null;
  try {
    listing = await mdvFolderList(generation);
  } catch (e) {
    if (generation !== s.generation) return false;
    s.loading = false;
    s.error = (e && (e.message || e.code)) || String(e);
    mdvFolderEmit('change');
    return false;
  }
  if (generation !== s.generation || !listing) return false;
  const hadError = !!s.error;
  const same = s.entries.length > 0 && listing.name === s.rootName && listing.truncated === s.truncated
    && listing.unreadable === s.unreadable && listing.entries.length === s.entries.length
    && listing.entries.every((e) => s.byPath.has(e.path));
  s.loading = false;
  s.error = null;
  s.root = listing.root;
  s.rootName = listing.name;
  s.truncated = listing.truncated;
  s.unreadable = listing.unreadable;
  s.listedAt = Date.now();
  if (same) {
    // The desktop listing carries each file's size and time: search in files reads again what changed by them.
    let changedTimes = false;
    if (s.kind === 'desktop') {
      for (const e of listing.entries) {
        const kept = s.byPath.get(e.path);
        if (kept.size !== e.size || kept.mtimeMs !== e.mtimeMs) { kept.size = e.size; kept.mtimeMs = e.mtimeMs; changedTimes = true; }
      }
    }
    await mdvFolderNoteShown();
    if (hadError) mdvFolderEmit('change');
    if (changedTimes) mdvFolderEmit('times');
    return true;
  }
  // A browser walk does not ask each file its size and time; what an earlier look found (search in files, quick
  // open's newest-first order) stays with the file until a later look finds it changed.
  if (s.kind === 'browser') {
    for (const e of listing.entries) {
      const before = s.byPath.get(e.path);
      if (before && before.mtimeMs != null) { e.size = before.size; e.mtimeMs = before.mtimeMs; e.statAt = before.statAt; }
    }
  }
  // The walk's own work and the sorting and drawing below go in separate tasks, so neither holds the page long.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (generation !== s.generation) return false;
  mdvFolderAccept(listing.entries);
  await mdvFolderNoteShown();
  mdvFolderEmit('change');
  return true;
}

// The size and time of each file the browser walk listed (the desktop listing carries them): one look at each
// handle not looked at in the last few seconds, 16 at a time, with the page free between slices of about 12 ms.
// Quick open lists the most recently changed files first with them. Emits 'times' when it learned anything.
let mdvFolderTimesRun = null;
function mdvFolderLearnTimes() {
  const s = mdvFolderState;
  if (s.kind !== 'browser' || s.loading) return Promise.resolve(false);
  if (mdvFolderTimesRun) return mdvFolderTimesRun;
  const openId = s.openId;
  const since = Date.now() - MDV_FOLDER_STALE_MS;
  const todo = s.entries.filter((e) => e.handle && !(e.statAt > since));
  if (!todo.length) return Promise.resolve(false);
  mdvFolderTimesRun = (async () => {
    let learned = 0;
    let sliceStart = performance.now();
    for (let i = 0; i < todo.length; i += 16) {
      if (s.openId !== openId) return false; // another folder was opened meanwhile
      await Promise.all(todo.slice(i, i + 16).map(async (e) => {
        try {
          const file = await e.handle.getFile();
          if (e.size !== file.size || e.mtimeMs !== file.lastModified) learned++;
          e.size = file.size;
          e.mtimeMs = file.lastModified;
          e.statAt = Date.now();
        } catch (err) { /* gone: the next listing leaves it out */ }
      }));
      if (performance.now() - sliceStart > 12) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    if (learned && s.openId === openId) mdvFolderEmit('times');
    return learned > 0;
  })().finally(() => { mdvFolderTimesRun = null; });
  return mdvFolderTimesRun;
}

async function mdvFolderUse(kind, root, { remember = true } = {}) {
  const s = mdvFolderState;
  s.openId++;
  s.kind = kind;
  s.root = root;
  s.rootName = kind === 'desktop' ? mdvFolderBaseName(root) || root : root.name;
  s.waiting = null;
  s.entries = [];
  s.byPath = new Map();
  s.current = null;
  s.error = null;
  const ok = await mdvFolderRefresh();
  if (ok && remember) mdvFolderRemember();
  return ok;
}

// ------- Remembering the folder: the handle in IndexedDB (browser), the path in localStorage (desktop) -------
function mdvFolderStorage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (e) { /* storage blocked: remembered for this page only */ }
  return null;
}

function mdvFolderRemember() {
  const s = mdvFolderState;
  if (s.kind === 'desktop') mdvFolderStorage('mdv-folder', s.root);
  else if (s.kind === 'browser' && typeof mdvPutHandle === 'function') mdvPutHandle('folder', s.root).catch(() => {});
}

// ------- Opening a folder -------
// The toolbar's folder button, quick open and the welcome screen call this from a click.
//   desktop: the document's own folder, or the remembered folder when it holds the document; with no document
//            (the welcome window), the remembered folder, else the native folder panel.
//   browser: the folder picker (Chromium), or the remembered folder after asking again for permission.
async function mdvFolderOpen() {
  if (mdvFolderState.kind) return true;
  if (mdvFolderIsDesktop()) {
    const root = mdvFolderDesktopDefault();
    return root ? mdvFolderUse('desktop', root, { remember: false }) : mdvFolderChoose();
  }
  if (mdvFolderState.waiting) return mdvFolderReconnect();
  return mdvFolderChoose();
}

function mdvFolderDesktopDefault() {
  const doc = window.mdvHost && window.mdvHost.currentPath;
  const remembered = mdvFolderStorage('mdv-folder');
  if (doc) return remembered && mdvFolderInside(doc, remembered) ? remembered : mdvFolderDirName(doc);
  return remembered || null;
}

// A folder the reader picks: the native folder panel (desktop) or the browser's folder picker. It is remembered.
async function mdvFolderChoose() {
  if (mdvFolderIsDesktop()) {
    let picked = null;
    try { picked = await window.mdvHost.chooseFolder(); } catch (e) { mdvFolderToast(e && e.message ? e.message : String(e), 'error'); return false; }
    if (!picked) return false;
    return mdvFolderUse('desktop', picked);
  }
  if (!('showDirectoryPicker' in window)) {
    mdvFolderToast('Opening a folder needs Chrome, Edge or another Chromium browser: Firefox and Safari cannot list a folder.', 'error');
    return false;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'mdv-folder', mode: 'read' });
  } catch (e) {
    if (e && e.name !== 'AbortError') mdvFolderToast('The folder could not be opened: ' + (e.message || e.name), 'error');
    return false;
  }
  return mdvFolderUse('browser', dir);
}

// The remembered folder, after the browser asks the reader again (it needs a click to do so).
async function mdvFolderReconnect() {
  const handle = mdvFolderState.waiting;
  if (!handle) return false;
  let permission = 'denied';
  try { permission = await handle.requestPermission({ mode: 'read' }); } catch (e) { /* not granted */ }
  if (permission !== 'granted') {
    mdvFolderToast('The browser did not allow reading "' + handle.name + '". Open the folder again to choose it.', 'error');
    return false;
  }
  return mdvFolderUse('browser', handle, { remember: false });
}

// Startup: the remembered folder comes back. In a browser without the reader's permission it waits for a click
// (the sidebar offers it); in the desktop app it opens once the window's document is known.
async function mdvFolderRestore() {
  const s = mdvFolderState;
  // Meanwhile the sidebar says it is listing, rather than offering to open a folder it is about to show.
  const settle = () => { if (!s.kind) { s.loading = false; mdvFolderEmit('change'); } };
  if (mdvFolderIsDesktop()) {
    if (mdvFolderStorage('mdv-folder-panel') !== 'open') return;
    s.loading = true;
    await mdvFolderFirstShown(1000); // a welcome window has no document to wait for
    const root = !s.kind && mdvFolderDesktopDefault();
    if (root) await mdvFolderUse('desktop', root, { remember: false });
    settle();
    return;
  }
  if (typeof mdvGetHandle !== 'function') return;
  s.loading = true;
  const handle = await mdvGetHandle('folder');
  let permission = 'prompt';
  if (handle && handle.kind === 'directory') {
    try { permission = await handle.queryPermission({ mode: 'read' }); } catch (e) { /* ask again */ }
  }
  if (s.kind || !handle || handle.kind !== 'directory') { settle(); return; }
  if (permission === 'granted') {
    await mdvFolderUse('browser', handle, { remember: false });
  } else {
    s.waiting = handle;
    s.rootName = handle.name;
  }
  settle();
}

function mdvFolderFirstShown(ms) {
  if (document.getElementById('mdBody').childElementCount) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = mdvFolderOn('shown', () => { stop(); clearTimeout(timer); resolve(); });
    const timer = setTimeout(() => { stop(); resolve(); }, ms);
  });
}

// ------- Reading and resolving (the contract) -------
// message: a clause with no closing full stop, so a caller can build a sentence around it (stream L's link toast
// says "<name> could not be opened: <message>."); this file's own toasts end it (mdvFolderSentence).
function mdvFolderError(code, message) { return { code, message }; }
function mdvFolderSentence(message) { return /[.!?…]$/.test(message) ? message : message + '.'; }

async function mdvFolderRead(path) {
  const s = mdvFolderState;
  if (s.kind === 'desktop' || (!s.kind && mdvFolderIsDesktop())) {
    const doc = await window.mdvHost.readDocument(path);
    if (!doc) throw mdvFolderError('not-found', mdvFolderBaseName(path) + ' could not be read');
    return Object.assign({}, doc, { handle: null });
  }
  if (s.kind !== 'browser') throw mdvFolderError('no-folder', 'no folder is open');
  const rel = mdvFolderNormalizeRelative(String(path || ''));
  if (!rel || !MDV_FOLDER_MARKDOWN.test(rel)) throw mdvFolderError('not-markdown', (rel || String(path)) + ' is not a Markdown file');
  // "Any more" only for a file the folder held when it was last listed.
  const missing = () => rel + ' is not in ' + s.rootName + (s.byPath.has(rel) ? ' any more' : '');
  let handle = s.byPath.has(rel) ? s.byPath.get(rel).handle : null;
  if (!handle) {
    try {
      let dir = s.root;
      const parts = rel.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      handle = await dir.getFileHandle(parts[parts.length - 1]);
    } catch (e) {
      throw mdvFolderError('not-found', missing());
    }
  }
  let disk;
  try {
    disk = await mdvReadHandle(handle);
  } catch (e) {
    const gone = e && e.name === 'NotFoundError';
    throw mdvFolderError(gone ? 'not-found' : 'io', gone ? missing() : rel + ': ' + (e && e.message || e));
  }
  if (disk.changing) throw mdvFolderError('changing', rel + ' kept changing while it was read; try again in a moment');
  return { name: disk.file.name, text: disk.text, path: rel, handle, mtimeMs: disk.file.lastModified, utf8: disk.utf8 };
}

function mdvFolderResolve(fromPath, href) {
  const s = mdvFolderState;
  if (!s.kind || typeof href !== 'string') return null;
  let target = href.trim();
  // An in-document link, and a protocol-relative address ('//host/a.md' is a web address, as the browser reads it).
  if (!target || target.startsWith('#') || (/^[\\/]{2}/.test(target) && !mdvFolderIsWindowsPath(target))) return null;
  const desktop = s.kind === 'desktop';
  let absolute = null;
  if (mdvFolderIsWindowsPath(target)) {
    if (!desktop) return null; // a path on a disk the browser's folder cannot name
    absolute = target;
  } else {
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
    if (scheme) {
      if (!desktop || scheme[1].toLowerCase() !== 'file') return null;
      absolute = mdvFolderFileUrlPath(target);
      if (!absolute) return null;
    }
  }
  if (!absolute) {
    target = target.replace(/[?#].*$/, '');
    try { target = decodeURIComponent(target); } catch (e) { /* as written */ }
  }
  if (!MDV_FOLDER_MARKDOWN.test((absolute || target).replace(/[?#].*$/, ''))) return null;
  // The document the link is in: fromPath, or (null) the document on screen when it is in the folder.
  const from = fromPath || s.current;
  const rooted = !absolute && target.startsWith('/');
  if (!absolute && !rooted && !from) return null; // a relative link with nothing to be relative to
  if (desktop) {
    let abs = absolute;
    if (rooted) {
      // A path on disk when it lies inside the folder; otherwise from the folder's top, as in a repository.
      const asIs = mdvFolderNormalizeAbsolute(target);
      abs = asIs && mdvFolderInside(asIs, s.root) ? asIs : s.root.replace(/[\\/]+$/, '') + (mdvFolderIsWindowsPath(s.root) ? target.replace(/\//g, '\\') : target);
    } else if (!abs) {
      const base = mdvFolderDirName(from);
      if (!base) return null;
      abs = base + (mdvFolderIsWindowsPath(base) ? '\\' : '/') + target;
    }
    abs = mdvFolderNormalizeAbsolute(abs);
    return abs && mdvFolderInside(abs, s.root) ? abs : null;
  }
  // Browser: a leading '/' is the folder's top, as a repository's links mean it.
  const dir = rooted ? '' : from.split('/').slice(0, -1).join('/');
  const rel = mdvFolderNormalizeRelative(dir ? dir + '/' + target : target);
  return rel || null;
}

// ------- The document on screen -------
// Every render replaces #mdBody's children; this hears about it after the loader has finished (a microtask
// later), whoever rendered: the folder's own opens, a link (stream L), live reload, File → Open, a restore.
// What is on screen, in order of certainty:
//   1. a document this file just asked mdvOpenDocument to show (its exact text is on screen);
//   2. the same document load as before (a comment re-render keeps comments.js's mdvLoadSeq);
//   3. the desktop window's own file (mdvHost.currentPath), or the browser file handle it was read from.
let mdvFolderShownSeq = 0;

function mdvFolderLoadSeq() { return typeof mdvLoadSeq === 'number' ? mdvLoadSeq : null; }

async function mdvFolderIdentify() {
  const s = mdvFolderState;
  const body = document.getElementById('mdBody');
  if (!body || body.style.display === 'none' || !body.childElementCount) return null;
  const text = typeof rawMarkdown === 'string' ? rawMarkdown : null;
  const seq = mdvFolderLoadSeq();
  const pending = s.pendingOpen;
  if (pending && text === pending.text) {
    s.pendingOpen = null;
    s.shownLoad = { seq, identity: pending.identity };
    return pending.identity;
  }
  if (s.shownLoad && seq != null && s.shownLoad.seq === seq) return s.shownLoad.identity;
  s.shownLoad = null;
  let identity = null;
  if (mdvFolderIsDesktop()) {
    const path = window.mdvHost.currentPath;
    if (path) identity = { kind: 'path', path, name: mdvFolderBaseName(path), handle: null };
  } else if (typeof mdvFileHandle !== 'undefined' && mdvFileHandle) {
    identity = { kind: 'handle', path: null, name: mdvFileHandle.name, handle: mdvFileHandle };
    if (s.kind === 'browser' && s.root && typeof s.root.resolve === 'function') {
      try {
        const parts = await s.root.resolve(mdvFileHandle);
        if (parts) identity.path = parts.join('/');
      } catch (e) { /* not in this folder */ }
    }
  }
  if (identity) s.shownLoad = { seq, identity };
  return identity;
}

function mdvFolderPathOf(identity) {
  const s = mdvFolderState;
  if (!identity || !s.kind) return null;
  if (s.kind === 'desktop') return identity.path && mdvFolderInside(identity.path, s.root) ? identity.path : null;
  return identity.path && s.byPath.has(identity.path) ? identity.path : null;
}

// After a render (announce: the 'shown' event), or after a new listing (only the current file is worked out again).
// A call that overtakes an announcing one announces in its place.
let mdvFolderAnnounce = false;
async function mdvFolderNoteShown(announce) {
  if (announce) mdvFolderAnnounce = true;
  const seq = ++mdvFolderShownSeq;
  const identity = await mdvFolderIdentify();
  if (seq !== mdvFolderShownSeq) return;
  const s = mdvFolderState;
  s.shown = identity;
  // A desktop path is matched in the listing by spelling as the shell wrote it.
  let current = mdvFolderPathOf(identity);
  if (current && s.kind === 'desktop' && !s.byPath.has(current)) {
    const entry = s.entries.find((e) => mdvFolderSamePath(e.path, current));
    if (entry) current = entry.path;
  }
  if (current !== s.current) {
    s.current = current;
    mdvFolderEmit('current', current);
  }
  if (mdvFolderAnnounce) {
    mdvFolderAnnounce = false;
    mdvFolderEmit('shown', identity);
  }
}

new MutationObserver(() => { mdvFolderNoteShown(true); }).observe(document.getElementById('mdBody'), { childList: true });

function mdvFolderToast(message, kind) {
  if (typeof mdvShowToast === 'function') mdvShowToast(message, kind);
  else console.warn(message);
}

// ------- The contract -------
window.mdvFolder = {
  get kind() { return mdvFolderState.kind; },
  get rootName() { return mdvFolderState.kind ? mdvFolderState.rootName : ''; },
  list() { return mdvFolderState.entries.map((e) => ({ path: e.path, name: e.name, depth: e.depth, rel: e.rel })); },
  read: mdvFolderRead,
  resolve: mdvFolderResolve,
};

// A folder that changes while the reader is away: listed again when the window comes back.
window.addEventListener('focus', () => {
  const s = mdvFolderState;
  if (s.kind && !s.loading && Date.now() - s.listedAt > MDV_FOLDER_STALE_MS) mdvFolderRefresh();
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mdvFolderRestore(); });
else mdvFolderRestore();
