// ============================================
// Recent documents
// ============================================
// The last 15 documents the reader had on screen, newest first, in two places: a menu on the toolbar (the
// clock button) and the welcome screen. Each opens again with one click, and the list can be cleared.
//
// Only documents the viewer can open again by itself are kept:
//   - desktop app: every document, by its path;
//   - browser: documents read through a file handle (opened from a folder, with the file-plus button, or
//     reopened at startup), kept as the handle in IndexedDB. A file dropped on the page or picked with the
//     plain Open button comes with no handle, so it cannot be opened again and is not listed.
// The list follows whatever puts a document on screen (folder.js reports each one), so a document opened by
// any route is recorded once, without each route having to remember to.
//
// window.mdvRecents = { list(), note(doc), clear(), open(entry, {newWindow}) } for other code.

const MDV_RECENTS_MAX = 15;
const MDV_RECENTS_KEY = 'mdv-recents'; // localStorage (desktop) / IndexedDB key (browser)

const mdvRecent = { items: null, loading: null, menu: null, button: null, welcome: null };

async function mdvRecentsLoad() {
  if (mdvRecent.items) return mdvRecent.items;
  if (!mdvRecent.loading) {
    mdvRecent.loading = (async () => {
      let items = [];
      if (mdvFolderIsDesktop()) {
        try { items = JSON.parse(mdvFolderStorage(MDV_RECENTS_KEY) || '[]'); } catch (e) { items = []; }
      } else if (typeof mdvGetHandle === 'function') {
        items = (await mdvGetHandle(MDV_RECENTS_KEY)) || [];
      }
      mdvRecent.items = Array.isArray(items) ? items.filter((r) => r && r.name && (r.path || r.handle)) : [];
      return mdvRecent.items;
    })();
  }
  return mdvRecent.loading;
}

async function mdvRecentsSave() {
  const items = mdvRecent.items || [];
  if (mdvFolderIsDesktop()) mdvFolderStorage(MDV_RECENTS_KEY, JSON.stringify(items.map(({ kind, name, path, folder, at }) => ({ kind, name, path, folder, at }))));
  else if (typeof mdvPutHandle === 'function') {
    try { await mdvPutHandle(MDV_RECENTS_KEY, items); } catch (e) { /* IndexedDB is off: the list lasts for this page */ }
  }
}

async function mdvRecentSame(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'path') return mdvFolderSamePath(a.path, b.path);
  if (a.handle && b.handle && typeof a.handle.isSameEntry === 'function') {
    try { return await a.handle.isSameEntry(b.handle); } catch (e) { return false; }
  }
  return false;
}

// Records a document as the newest. doc: {kind: 'path'|'handle', name, path, handle}.
let mdvRecentsQueue = Promise.resolve();
function mdvRecentsNote(doc) {
  if (!doc || !doc.name || !(doc.kind === 'path' ? doc.path : doc.handle)) return mdvRecentsQueue;
  mdvRecentsQueue = mdvRecentsQueue.then(async () => {
    const items = (await mdvRecentsLoad()).slice();
    const entry = {
      kind: doc.kind, name: doc.name, path: doc.path || null, handle: doc.kind === 'handle' ? doc.handle : null,
      folder: doc.kind === 'path' ? mdvFolderDirName(doc.path) : (mdvFolderState.kind === 'browser' && doc.path ? mdvFolderState.rootName : ''),
      at: Date.now(),
    };
    if (items.length && await mdvRecentSame(items[0], entry)) {
      // Already the newest: a re-render or a reload. Keep its folder-relative path once it is known.
      if (!items[0].path && entry.path) { items[0] = Object.assign({}, items[0], { path: entry.path, folder: entry.folder }); mdvRecent.items = items; await mdvRecentsSave(); mdvRecentsRender(); }
      return;
    }
    const kept = [];
    for (const r of items) if (!(await mdvRecentSame(r, entry))) kept.push(r);
    mdvRecent.items = [entry].concat(kept).slice(0, MDV_RECENTS_MAX);
    await mdvRecentsSave();
    mdvRecentsRender();
  }).catch((e) => console.warn('recents:', e));
  return mdvRecentsQueue;
}

async function mdvRecentsClear() {
  await mdvRecentsQueue;
  mdvRecent.items = [];
  await mdvRecentsSave();
  mdvRecentsRender();
}

async function mdvRecentsForget(entry) {
  const items = (await mdvRecentsLoad()).filter((r) => r !== entry);
  mdvRecent.items = items;
  await mdvRecentsSave();
  mdvRecentsRender();
}

// Opens a recent document again: in this window (through mdvOpenDocument), or with newWindow (desktop
// Cmd/Ctrl-click) in its own. An empty desktop window (the welcome screen) asks the shell to open the path,
// which then gives this window the document, with live reload and saving, as a double-click would.
async function mdvRecentsOpen(entry, { newWindow = false } = {}) {
  mdvRecentsCloseMenu();
  if (entry.kind === 'path') {
    const host = window.mdvHost;
    if (newWindow || !host.currentPath) { await host.openPath(entry.path); return; }
    // The last request wins (js/folder-open.js): a slower read for an earlier click never replaces a later choice.
    const ticket = mdvFolderTakeTicket();
    const inFolder = mdvFolderState.kind === 'desktop' && mdvFolderInside(entry.path, mdvFolderState.root);
    let doc;
    try {
      doc = inFolder ? await mdvFolder.read(entry.path) : Object.assign({}, await host.readDocument(entry.path), { handle: null });
    } catch (e) {
      if (mdvFolderIsLatest(ticket)) mdvRecentsGone(entry, e);
      return;
    }
    if (!mdvFolderIsLatest(ticket)) return;
    await mdvFolderShow(doc, { kind: 'path', path: doc.path, name: doc.name, handle: null });
    return;
  }
  // A browser handle: reading it may need the reader's permission again (this click lets the browser ask).
  const ticket = mdvFolderTakeTicket();
  const handle = entry.handle;
  let permission = 'prompt';
  try { permission = await handle.queryPermission({ mode: 'read' }); } catch (e) { /* ask */ }
  if (permission !== 'granted') {
    try { permission = await handle.requestPermission({ mode: 'read' }); } catch (e) { permission = 'denied'; }
  }
  if (!mdvFolderIsLatest(ticket)) return;
  if (permission !== 'granted') {
    mdvFolderToast('The browser did not allow reading ' + entry.name + '.', 'error');
    return;
  }
  let disk;
  try { disk = await mdvReadHandle(handle); } catch (e) { if (mdvFolderIsLatest(ticket)) mdvRecentsGone(entry, e); return; }
  if (!mdvFolderIsLatest(ticket)) return;
  if (disk.changing) { mdvFolderToast(entry.name + ' kept changing while it was read. Try again in a moment.', 'error'); return; }
  let path = null;
  if (mdvFolderState.kind === 'browser') {
    try { const parts = await mdvFolderState.root.resolve(handle); if (parts) path = parts.join('/'); } catch (e) { /* not in the open folder */ }
  }
  if (!mdvFolderIsLatest(ticket)) return;
  const doc = { name: disk.file.name, text: disk.text, path, handle, mtimeMs: disk.file.lastModified, utf8: disk.utf8 };
  await mdvFolderShow(doc, { kind: 'handle', path, name: doc.name, handle });
}

function mdvRecentsGone(entry, e) {
  const gone = (e && (e.code === 'not-found' || e.name === 'NotFoundError'));
  mdvFolderToast(gone ? entry.name + ' is no longer where it was, so it was taken off the list.' : entry.name + ' could not be read: ' + mdvFolderSentence(String((e && (e.message || e.name)) || e)), 'error');
  if (gone) mdvRecentsForget(entry);
}

// The comment code reopens the last file at startup ('current' in IndexedDB: js/comments.js). Every document shown
// from a file handle is that file, by whatever route it came (a folder, a recent document, Back and Forward), so a
// reload shows the document the reader was reading. (The load seam remembers a handle only the first time it reads
// it, so without this a reload could reopen an earlier document.) The desktop app reopens its window's own file.
function mdvRecentsRememberLast(identity) {
  if (!identity || identity.kind !== 'handle' || !identity.handle || mdvFolderIsDesktop()) return;
  if (typeof mdvPutHandle !== 'function') return;
  mdvPutHandle('current', identity.handle).catch(() => { /* remembering it is a convenience; IndexedDB may be off */ });
}

// ------- Drawing: the toolbar menu and the welcome screen -------
function mdvRecentsWhere(entry) {
  if (entry.kind === 'path') return entry.folder || mdvFolderDirName(entry.path);
  if (entry.path && entry.folder) {
    const dir = entry.path.split('/').slice(0, -1).join('/');
    return entry.folder + (dir ? '/' + dir : '');
  }
  return entry.folder || '';
}

function mdvRecentsAgo(at) {
  if (!at) return '';
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : d < 31 ? d + ' days ago' : new Date(at).toLocaleDateString();
}

function mdvRecentsItem(entry, index, inMenu) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'mdv-recent-item';
  if (inMenu) {
    el.setAttribute('role', 'menuitem');
    el.tabIndex = -1;
  }
  el.dataset.action = 'recent-open';
  el.dataset.arg = String(index);
  const name = document.createElement('span');
  name.className = 'mdv-recent-name';
  name.textContent = entry.name;
  const where = document.createElement('span');
  where.className = 'mdv-recent-where';
  where.textContent = mdvRecentsWhere(entry);
  const when = document.createElement('span');
  when.className = 'mdv-recent-when';
  when.textContent = mdvRecentsAgo(entry.at);
  el.append(name, when, where);
  el.title = entry.kind === 'path' ? entry.path : [entry.folder, entry.path || entry.name].filter(Boolean).join(': ');
  return el;
}

function mdvRecentsRender() {
  const items = mdvRecent.items || [];
  const menu = mdvRecent.menu;
  if (menu) {
    menu.replaceChildren();
    const head = document.createElement('div');
    head.className = 'mdv-recent-head';
    head.textContent = 'Recent documents';
    menu.appendChild(head);
    if (!items.length) {
      const none = document.createElement('div');
      none.className = 'mdv-recent-none';
      none.textContent = mdvFolderIsDesktop() ? 'Documents you open appear here.' : 'Documents you open from a folder or with the file-plus button appear here.';
      menu.appendChild(none);
    }
    items.forEach((entry, i) => menu.appendChild(mdvRecentsItem(entry, i, true)));
    if (items.length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'mdv-recent-clear';
      clear.setAttribute('role', 'menuitem');
      clear.tabIndex = -1;
      clear.dataset.action = 'recent-clear';
      clear.textContent = 'Clear the list';
      menu.appendChild(clear);
    }
  }
  mdvRecentsRenderWelcome(items);
}

function mdvRecentsRenderWelcome(items) {
  const screen = document.getElementById('welcomeScreen');
  if (!screen) return;
  let box = document.getElementById('mdvWelcomeRecents');
  if (!box) {
    box = document.createElement('section');
    box.id = 'mdvWelcomeRecents';
    box.className = 'mdv-welcome-recents';
    box.setAttribute('aria-labelledby', 'mdvWelcomeRecentsTitle');
  }
  if (box.parentElement !== screen) screen.appendChild(box);
  box.replaceChildren();
  const head = document.createElement('div');
  head.className = 'mdv-welcome-recents-head';
  const title = document.createElement('h2');
  title.id = 'mdvWelcomeRecentsTitle';
  title.textContent = items.length ? 'Recent' : 'Folders';
  head.appendChild(title);
  const tools = document.createElement('div');
  tools.className = 'mdv-welcome-recents-tools';
  const canOpenFolder = mdvFolderIsDesktop() || 'showDirectoryPicker' in window;
  if (canOpenFolder) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mdv-welcome-link';
    open.dataset.action = 'folder-toggle-open';
    open.textContent = 'Open a folder…';
    tools.appendChild(open);
  }
  if (items.length) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'mdv-welcome-link';
    clear.dataset.action = 'recent-clear';
    clear.textContent = 'Clear';
    tools.appendChild(clear);
  }
  head.appendChild(tools);
  box.appendChild(head);
  if (items.length) {
    const list = document.createElement('ul');
    list.className = 'mdv-welcome-recents-list';
    items.forEach((entry, i) => {
      const li = document.createElement('li');
      li.appendChild(mdvRecentsItem(entry, i, false));
      list.appendChild(li);
    });
    box.appendChild(list);
  } else {
    const p = document.createElement('p');
    p.className = 'mdv-welcome-recents-none';
    p.textContent = canOpenFolder
      ? 'Open a folder of notes to browse its documents, jump to any of them and search them all.'
      : 'Opening a folder needs Chrome, Edge or another Chromium browser.';
    box.appendChild(p);
  }
  box.hidden = !items.length && !canOpenFolder;
}

// ------- The toolbar menu -------
function mdvRecentsOpenMenu() {
  const menu = mdvRecent.menu, button = mdvRecent.button;
  if (!menu || !button) return;
  if (menu.classList.contains('show')) { mdvRecentsCloseMenu(true); return; }
  if (typeof closeDropdowns === 'function') closeDropdowns();
  mdvRecentsRender();
  menu.classList.add('show');
  button.setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('[role="menuitem"]');
  if (first) first.focus();
}

function mdvRecentsCloseMenu(focusButton) {
  const menu = mdvRecent.menu, button = mdvRecent.button;
  if (!menu) return;
  const had = menu.contains(document.activeElement);
  menu.classList.remove('show');
  if (button) button.setAttribute('aria-expanded', 'false');
  if (button && (focusButton || had)) button.focus();
}

function mdvRecentsMenuKeys(e) {
  const items = [...mdvRecent.menu.querySelectorAll('[role="menuitem"]')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); (items[(i + 1) % items.length] || items[0]).focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); (items[(i - 1 + items.length) % items.length] || items[0]).focus(); }
  else if (e.key === 'Home') { e.preventDefault(); if (items[0]) items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); if (items.length) items[items.length - 1].focus(); }
  else if (e.key === 'Escape' || e.key === 'Tab') {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
    mdvRecentsCloseMenu(e.key === 'Escape');
  }
}

mdvRegisterActions({
  'recent-menu':  { click: () => mdvRecentsOpenMenu() },
  'recent-open':  {
    click: (el, arg, event) => {
      const entry = (mdvRecent.items || [])[Number(arg)];
      if (entry) mdvRecentsOpen(entry, { newWindow: !!(event.metaKey || event.ctrlKey) });
    },
  },
  'recent-clear': { click: () => { mdvRecentsCloseMenu(true); mdvRecentsClear(); } },
  // The welcome screen's "Open a folder…": the folder sidebar opens with it.
  'folder-toggle-open': { click: () => { if (!mdvTreeShown()) mdvTreeToggle(); else mdvFolderOpen().then((ok) => { if (ok) mdvTreeFocus(); }); } },
});

(function mdvRecentsStart() {
  mdvRecent.menu = document.getElementById('mdvRecentMenu');
  mdvRecent.button = document.getElementById('mdvRecentBtn');
  if (mdvRecent.menu) mdvRecent.menu.addEventListener('keydown', mdvRecentsMenuKeys);
  // A click anywhere else closes the menu (the theme menu's own button included).
  document.addEventListener('click', (e) => {
    if (mdvRecent.menu && mdvRecent.menu.classList.contains('show') && !e.target.closest('.mdv-recent-wrap')) mdvRecentsCloseMenu(false);
  });
  // A ?file= link that cannot load replaces the welcome screen's markup: the list goes back in.
  const screen = document.getElementById('welcomeScreen');
  if (screen) new MutationObserver(() => {
    if (!document.getElementById('mdvWelcomeRecents')) mdvRecentsRenderWelcome(mdvRecent.items || []);
  }).observe(screen, { childList: true });
  mdvFolderOn('shown', (identity) => {
    if (!identity) return;
    mdvRecentsNote(identity);
    mdvRecentsRememberLast(identity);
  });
  mdvRecentsLoad().then(mdvRecentsRender);
})();

window.mdvRecents = {
  list: () => mdvRecentsLoad().then((items) => items.slice()),
  note: mdvRecentsNote,
  clear: mdvRecentsClear,
  open: mdvRecentsOpen,
};
