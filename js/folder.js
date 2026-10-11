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
//   read(path)           Promise<{name, text, path, handle, mtimeMs}>; rejects with {code, message}
//   resolve(fromPath, href)  the path a link in the document at fromPath leads to, when it is a Markdown
//             file inside the folder; otherwise null. Lexical: read() finds out whether it exists.
// Paths are folder-relative in a browser ('handoffs/2026-10-01.md') and absolute in the desktop app.
//
// The listing never enters .git, node_modules or any folder whose name starts with a dot, and stops at
// 5,000 files, 8 folders deep, or 100,000 folder entries looked at: the shell's walk
// (desktop/src-tauri/src/folders.rs) keeps the same rules, so both builds list the same files.
//
// A document is shown only through mdvOpenDocument (js/files.js); this file never renders one itself.

const MDV_FOLDER_MARKDOWN = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;
const MDV_FOLDER_LIMITS = { entries: 5000, depth: 8, visited: 100000 };
// A folder that changes while the reader works (agents add files) is listed again when the window comes back
// into focus, at most this often.
const MDV_FOLDER_STALE_MS = 5000;
const mdvFolderCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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
  current: null,       // the folder path of the document on screen, when it is in the folder
  shown: null,         // what is on screen: {kind: 'path'|'handle', path, handle, name, folderPath}
  pendingOpen: null,   // a document this file asked mdvOpenDocument to show, until it is on screen
  shownLoad: null,     // {seq, identity}: the document load that showed it (comment re-renders keep it)
};

// ------- Events: 'change' (the folder or its listing), 'current' (the document on screen in it), 'shown' -------
const mdvFolderListeners = { change: new Set(), current: new Set(), shown: new Set() };
function mdvFolderOn(type, fn) {
  mdvFolderListeners[type].add(fn);
  return () => mdvFolderListeners[type].delete(fn);
}
function mdvFolderEmit(type, detail) {
  for (const fn of [...mdvFolderListeners[type]]) {
    try { fn(detail); } catch (e) { console.warn('folder ' + type + ' listener:', e); }
  }
}

// ------- Paths -------
function mdvFolderIsDesktop() { return !!(window.mdvHost && window.mdvHost.kind === 'desktop'); }
const mdvFolderCaseless = /Mac|Win/i.test(navigator.platform || navigator.userAgent || '');
function mdvFolderBaseName(p) { return String(p || '').split(/[\\/]/).pop(); }

function mdvFolderIsWindowsPath(p) { return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p); }

// An absolute path (POSIX or Windows) with '.' and '..' resolved; null when '..' would climb above its root.
function mdvFolderNormalizeAbsolute(p) {
  const windows = mdvFolderIsWindowsPath(p);
  const sep = windows ? '\\' : '/';
  const s = windows ? p.replace(/\//g, '\\') : p;
  let root;
  if (/^[a-zA-Z]:\\/.test(s)) root = s.slice(0, 3);
  else if (s.startsWith('\\\\')) root = '\\\\' + s.slice(2).split('\\').slice(0, 2).join('\\') + '\\';
  else if (s.startsWith('/')) root = '/';
  else return null;
  const out = [];
  for (const seg of s.slice(root.length).split(sep)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return root + out.join(sep);
}

function mdvFolderDirName(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return '';
  const dir = p.slice(0, i);
  if (!dir) return p[0];                         // '/a.md' → '/'
  if (/^[a-zA-Z]:$/.test(dir)) return dir + '\\'; // 'C:\a.md' → 'C:\'
  return dir;
}

function mdvFolderSamePath(a, b) {
  return !!a && !!b && (mdvFolderCaseless ? a.toLowerCase() === b.toLowerCase() : a === b);
}

// Whether the absolute `path` is `root` or inside it (desktop).
function mdvFolderInside(path, root) {
  if (!path || !root) return false;
  const sep = mdvFolderIsWindowsPath(root) ? '\\' : '/';
  const r = root.endsWith(sep) ? root : root + sep;
  const p = mdvFolderIsWindowsPath(root) ? path.replace(/\//g, '\\') : path;
  return mdvFolderCaseless ? p.toLowerCase().startsWith(r.toLowerCase()) : p.startsWith(r);
}

// A folder-relative path ('a/b.md') with '.' and '..' resolved; null when it would leave the folder.
function mdvFolderNormalizeRelative(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

// Folders first, then files, each by name (numbers in names in numeric order).
function mdvFolderCompareRel(a, b) {
  const pa = a.split('/'), pb = b.split('/');
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    if (pa[i] === pb[i]) continue;
    const fileA = i === pa.length - 1, fileB = i === pb.length - 1;
    if (fileA !== fileB) return fileA ? 1 : -1;
    return mdvFolderCollator.compare(pa[i], pb[i]) || (pa[i] < pb[i] ? -1 : 1);
  }
  return pa.length - pb.length;
}

function mdvFolderSkipped(name) { return name.startsWith('.') || name === 'node_modules'; }

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
    if (entries.length - mdvFolderState.progress >= 50) {
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

// Lists the open folder again. The reader's place in it (the current document) is kept.
async function mdvFolderRefresh() {
  const s = mdvFolderState;
  if (!s.kind) return false;
  const generation = ++s.generation;
  s.loading = true;
  s.progress = 0;
  mdvFolderEmit('change');
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
  s.loading = false;
  s.error = null;
  s.root = listing.root;
  s.rootName = listing.name;
  s.truncated = listing.truncated;
  s.unreadable = listing.unreadable;
  s.listedAt = Date.now();
  mdvFolderAccept(listing.entries);
  await mdvFolderNoteShown();
  mdvFolderEmit('change');
  return true;
}

async function mdvFolderUse(kind, root, { remember = true } = {}) {
  const s = mdvFolderState;
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
function mdvFolderError(code, message) { return { code, message }; }

async function mdvFolderRead(path) {
  const s = mdvFolderState;
  if (s.kind === 'desktop' || (!s.kind && mdvFolderIsDesktop())) {
    const doc = await window.mdvHost.readDocument(path);
    if (!doc) throw mdvFolderError('not-found', mdvFolderBaseName(path) + ' could not be read.');
    return Object.assign({}, doc, { handle: null });
  }
  if (s.kind !== 'browser') throw mdvFolderError('no-folder', 'No folder is open.');
  const rel = mdvFolderNormalizeRelative(String(path || ''));
  if (!rel || !MDV_FOLDER_MARKDOWN.test(rel)) throw mdvFolderError('not-markdown', rel + ' is not a Markdown file.');
  let handle = s.byPath.has(rel) ? s.byPath.get(rel).handle : null;
  if (!handle) {
    try {
      let dir = s.root;
      const parts = rel.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      handle = await dir.getFileHandle(parts[parts.length - 1]);
    } catch (e) {
      throw mdvFolderError('not-found', rel + ' is not in ' + s.rootName + ' any more.');
    }
  }
  let disk;
  try {
    disk = await mdvReadHandle(handle);
  } catch (e) {
    const gone = e && e.name === 'NotFoundError';
    throw mdvFolderError(gone ? 'not-found' : 'io', gone ? rel + ' is not in ' + s.rootName + ' any more.' : rel + ': ' + (e && e.message || e));
  }
  if (disk.changing) throw mdvFolderError('changing', rel + ' kept changing while it was read. Try again in a moment.');
  return { name: disk.file.name, text: disk.text, path: rel, handle, mtimeMs: disk.file.lastModified, utf8: disk.utf8 };
}

// file:///… (desktop only): an absolute path.
function mdvFolderFileUrlPath(href) {
  try {
    const u = new URL(href);
    let p = decodeURIComponent(u.pathname);
    if (u.host) p = '\\\\' + u.host + p.replace(/\//g, '\\');
    else if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return p;
  } catch (e) { return null; }
}

function mdvFolderResolve(fromPath, href) {
  const s = mdvFolderState;
  if (!s.kind || typeof href !== 'string') return null;
  let target = href.trim();
  if (!target || target.startsWith('#')) return null;
  const desktop = s.kind === 'desktop';
  let absolute = null;
  if (mdvFolderIsWindowsPath(target)) absolute = target;
  else {
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
  if (desktop) {
    let abs = absolute || (target.startsWith('/') ? target : null);
    if (!abs) {
      const base = fromPath ? mdvFolderDirName(fromPath) : s.root;
      if (!base) return null;
      abs = base + (mdvFolderIsWindowsPath(base) ? '\\' : '/') + target;
    }
    abs = mdvFolderNormalizeAbsolute(abs);
    return abs && mdvFolderInside(abs, s.root) ? abs : null;
  }
  // Browser: a leading '/' is the folder's top, as a repository's links mean it.
  const dir = target.startsWith('/') || !fromPath ? '' : fromPath.split('/').slice(0, -1).join('/');
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

// ------- Opening one of the folder's documents -------
// Through mdvOpenDocument (js/files.js) only. opts.newWindow (Cmd/Ctrl-click, desktop): its own window, as a link
// does. opts.then(): runs once the document is on screen (search across files scrolls to the match there).
async function mdvFolderOpenFile(path, opts = {}) {
  const s = mdvFolderState;
  if (mdvFolderIsDesktop() && opts.newWindow) {
    await window.mdvHost.openPath(path);
    return true;
  }
  const entry = s.byPath.get(path);
  const label = (entry && entry.rel) || mdvFolderBaseName(path);
  let doc;
  try {
    doc = await mdvFolderRead(path);
  } catch (e) {
    mdvFolderToast((e && e.message) || (label + ' could not be read.'), 'error');
    if (e && e.code === 'not-found') mdvFolderRefresh();
    return false;
  }
  // Already on screen, exactly: nothing to load, only the place to show.
  if (s.current && mdvFolderSamePath(s.current, doc.path) && rawMarkdown === doc.text) {
    if (opts.then) opts.then();
    return true;
  }
  if (typeof window.mdvOpenDocument !== 'function') {
    console.error('folder: mdvOpenDocument (js/files.js) is missing, so the folder cannot show a document.');
    mdvFolderToast('This build cannot show documents from a folder: mdvOpenDocument is missing.', 'error');
    return false;
  }
  const identity = { kind: doc.handle ? 'handle' : 'path', path: doc.path, name: doc.name, handle: doc.handle || null };
  s.pendingOpen = { text: doc.text, identity };
  const shown = mdvFolderWhenShowing(doc.path, 5000);
  try {
    await window.mdvOpenDocument(doc, { push: true });
  } catch (e) {
    console.error('folder: mdvOpenDocument failed:', e);
    mdvFolderToast(label + ' could not be shown: ' + ((e && e.message) || e), 'error');
    return false;
  }
  const ok = await shown;
  if (ok && opts.then) opts.then();
  return ok;
}

function mdvFolderWhenShowing(path, ms) {
  return new Promise((resolve) => {
    const stop = mdvFolderOn('shown', (identity) => {
      if (identity && mdvFolderSamePath(identity.path, path)) { stop(); clearTimeout(timer); resolve(true); }
    });
    const timer = setTimeout(() => { stop(); resolve(false); }, ms);
  });
}

function mdvFolderToast(message, kind) {
  if (typeof mdvShowToast === 'function') mdvShowToast(message, kind);
  else console.warn(message);
}

// ------- Keyboard shortcuts: rows in app.js's MDV_SHORTCUTS table (the key handler and the ? sheet) -------
// Added after every script has loaded. A row is matched in table order, so a row meant to win over an existing
// one for the same keys goes in front of it (`before`).
function mdvFolderAddShortcut(row, before) {
  if (typeof MDV_SHORTCUTS === 'undefined' || !Array.isArray(MDV_SHORTCUTS)) return;
  if (MDV_SHORTCUTS.some((r) => r.label === row.label)) return;
  const at = before ? MDV_SHORTCUTS.findIndex(before) : -1;
  if (at >= 0) MDV_SHORTCUTS.splice(at, 0, row); else {
    const help = MDV_SHORTCUTS.findIndex((r) => r.key === '?');
    MDV_SHORTCUTS.splice(help >= 0 ? help : MDV_SHORTCUTS.length, 0, row);
  }
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
