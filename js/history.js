// ============================================
// Back and forward between documents, and links that open in the viewer
// ============================================
// A reader follows a link from a handoff to the plan it names, reads, and comes back. Each document shown is a
// place in the browser's own history, so the address, the browser's Back and Forward buttons and these agree:
//   - Alt+← and Alt+→ and the two toolbar buttons (data-action history-back / history-forward). They move
//     through the browser's history, one step at a time: after an in-document link (js/links.js), Back first
//     returns to where the reader was in the same document, as the browser's own Back does.
//   - A document comes back as the reader left it, at the same place (the seam restores the position taken
//     when it was left); live reload (js/live-reload.js) then looks at once whether its file changed since.
//   - A relative link to a Markdown file opens inside the viewer, through the load seam (mdvOpenDocument):
//       a folder is open (window.mdvFolder)   mdvFolder.resolve, then mdvFolder.read
//       the desktop app                       mdvHost.readDocument, in the same window (Cmd/Ctrl-click opens
//                                             it in a window of its own: js/host.js)
//       a page served over http(s)            fetch, relative to the document's own address (Cmd/Ctrl-click
//                                             opens the viewer in a new tab)
//       otherwise (a file:// page)            the browser's own behaviour
//     A link to the document on screen with a #fragment goes there, as an in-document link does.
//
// Documents opened any other way (the comment code's writable open, the desktop bridge) are followed too: the
// seam reports every document shown (mdvOnDocumentOpening / mdvOnDocumentOpened, js/files.js).

const MDV_MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;
// The documents whose text stays in memory, nearest the current one first; the others are read again from
// their file when the reader returns to them (pasted text cannot be, so it always stays)
const MDV_HISTORY_TEXTS = 40;

const mdvHistory = {
  entries: new Map(), // id → {id, doc, position}: a document and the reader's place in it when they left it
  order: [],          // entry ids in the order of the browser's history, as far as this page has seen it
  index: -1,          // where the document on screen sits in `order`
  seq: 0,
  going: null,        // the latest Back/Forward or link being followed; an older one that finishes later gives way
};

function mdvHistoryCurrent() {
  const id = mdvHistory.order[mdvHistory.index];
  return id ? mdvHistory.entries.get(id) || null : null;
}

// Ids stay unique across page reloads: the browser keeps the states of entries made before one
function mdvHistoryNewId() { return 'd' + Date.now().toString(36) + '-' + (++mdvHistory.seq).toString(36); }

// What the browser keeps for an entry: enough to read the document again after the page reloads
function mdvHistoryState(entry, n) {
  const d = entry.doc;
  return { mdvDoc: { id: entry.id, n, kind: d.kind, path: d.path || null, name: d.name } };
}

// The address of a document's entry: ?file= names it where a reload of the page can load it again (a ?file=
// link over http; the name of a chosen or dropped file and "pasted", as the viewer always wrote them). A file
// opened through a handle has no such address: without ?file=, a reload reopens the last file.
function mdvHistoryUrl(doc, { first = false, fragment = null } = {}) {
  const url = new URL(location.href);
  if (first && !(doc.kind === 'file' || doc.kind === 'pasted')) return url.href;
  url.hash = fragment ? '#' + fragment : '';
  if (mdvInDesktopApp()) return url.href;
  if (doc.kind === 'http' && doc.path) url.searchParams.set('file', doc.path);
  else if (doc.kind === 'file') url.searchParams.set('file', doc.name);
  else if (doc.kind === 'pasted') url.searchParams.set('file', 'pasted');
  else if (doc.kind === 'handle' || doc.kind === 'folder') url.searchParams.delete('file');
  return url.href;
}

function mdvHistoryWrite(method, state, url) {
  try { history[method](state, '', url); } catch (e) { /* an address the page cannot take: keep the state only */
    try { history[method](state, ''); } catch (_) { /* no history at all */ }
  }
}

function mdvHistoryAdd(doc) {
  const entry = { id: mdvHistoryNewId(), doc, position: null };
  mdvHistory.entries.set(entry.id, entry);
  return entry;
}

// The tab's current entry is named after its document only when the reader leaves it, so a page that only shows
// one document never touches the tab's history (a fragment link's entries copy the state it then has)
function mdvHistoryTag(entry) {
  const st = history.state && history.state.mdvDoc;
  if (st && st.id === entry.id) return;
  mdvHistoryWrite('replaceState', Object.assign({}, history.state, mdvHistoryState(entry, mdvHistory.index)), location.href);
}

// Just before a document replaces the page (the old one is still on screen): the browser keeps the old entry's
// scroll position as it moves on, and the old entry keeps the reader's place and the document as they leave it.
mdvOnDocumentOpening((event) => {
  if (event.kind === 'first' || event.kind === 'reload') return;
  let out = mdvHistoryCurrent();
  if (!out && event.previous) {
    // A document that was on screen before the viewer followed renders (the #demo page) gets the page's entry
    out = mdvHistoryAdd(event.previous);
    mdvHistory.order = [out.id];
    mdvHistory.index = 0;
  }
  if (out) {
    out.position = event.position;
    // With the comment changes made since it opened, as it is on screen now
    if (typeof event.previousText === 'string') out.doc = Object.assign({}, out.doc, { text: event.previousText });
  }
  if (event.kind === 'history') {
    const { id, n } = event.history;
    if (!mdvHistory.entries.has(id)) mdvHistory.entries.set(id, { id, doc: event.doc, position: null });
    mdvHistory.order[n] = id;
    mdvHistory.index = n;
    return;
  }
  const entry = mdvHistoryAdd(event.doc);
  if (event.push && out) {
    mdvHistoryTag(out);
    mdvHistory.order = mdvHistory.order.slice(0, mdvHistory.index + 1);
    mdvHistory.order.push(entry.id);
    mdvHistory.index = mdvHistory.order.length - 1;
    mdvHistoryWrite('pushState', mdvHistoryState(entry, mdvHistory.index), mdvHistoryUrl(event.doc, { fragment: event.fragment }));
  } else {
    if (mdvHistory.index < 0) mdvHistory.index = 0;
    mdvHistory.order[mdvHistory.index] = entry.id;
    mdvHistoryWrite('replaceState', mdvHistoryState(entry, mdvHistory.index), mdvHistoryUrl(event.doc, { fragment: event.fragment }));
  }
});

// Once it is on screen: the entry holds the document as shown
mdvOnDocumentOpened((event) => {
  if (event.kind === 'first') {
    // The page's own entry is this document's (named when the reader leaves it). After a reload of the page it
    // keeps its place among the entries the tab kept.
    const prior = history.state && history.state.mdvDoc;
    const entry = mdvHistoryAdd(event.doc);
    const n = prior && Number.isInteger(prior.n) ? prior.n : 0;
    mdvHistory.order = [];
    mdvHistory.order[n] = entry.id;
    mdvHistory.index = n;
    // A chosen, dropped or pasted document names itself in the address, as the viewer always did
    if (event.doc.kind === 'file' || event.doc.kind === 'pasted') {
      mdvHistoryWrite('replaceState', Object.assign({}, history.state, mdvHistoryState(entry, n)), mdvHistoryUrl(event.doc, { first: true }));
    }
  } else {
    const entry = mdvHistoryCurrent();
    if (entry) entry.doc = event.doc;
  }
  // A link's tooltip (js/links.js) names a link of the document that was replaced: the pointer that rested on
  // the link that was followed never left it, so nothing else would hide it
  if (event.kind === 'open' || event.kind === 'history') {
    const tip = document.getElementById('linkTooltip');
    if (tip) tip.classList.remove('visible');
  }
  mdvHistoryTrim();
  mdvHistoryButtons();
});

// Entries the browser dropped (a new document after going back) go; far ones keep only where to read them from
function mdvHistoryTrim() {
  const live = new Set(mdvHistory.order.filter(Boolean));
  for (const id of [...mdvHistory.entries.keys()]) if (!live.has(id)) mdvHistory.entries.delete(id);
  const near = new Set();
  for (let d = 0; near.size < MDV_HISTORY_TEXTS && d < mdvHistory.order.length; d++) {
    for (const j of [mdvHistory.index - d, mdvHistory.index + d]) if (mdvHistory.order[j]) near.add(mdvHistory.order[j]);
  }
  for (const [id, entry] of mdvHistory.entries) {
    const d = entry.doc;
    if (near.has(id) || !d || typeof d.text !== 'string') continue;
    const readable = !!d.handle || (!!d.path && (d.kind === 'http' || d.kind === 'desktop' || d.kind === 'folder'));
    if (readable) entry.doc = Object.assign({}, d, { text: undefined });
  }
}

// ------- Going back and forward -------
function mdvHistoryBack() {
  if (mdvHistory.index <= 0) return false; // nothing before: Alt+← stays the browser's
  history.back();
  return true;
}
function mdvHistoryForward() {
  if (mdvHistory.index < 0 || mdvHistory.index >= mdvHistory.order.length - 1) return false;
  history.forward();
  return true;
}

window.addEventListener('popstate', (e) => {
  const st = e.state && e.state.mdvDoc;
  if (!st) return;
  const current = mdvHistoryCurrent();
  if (current && current.id === st.id) return; // a place in the same document (an in-document link): the browser's
  mdvHistoryShow(st);
});

async function mdvHistoryShow(st) {
  const going = mdvHistory.going = {};
  const entry = mdvHistory.entries.get(st.id);
  let doc = entry ? entry.doc : null;
  // A document no longer kept in memory, or one from before the page was reloaded, is read again
  if (!doc || (typeof doc.text !== 'string' && !doc.handle)) {
    doc = await mdvHistoryRead(doc || st);
    if (mdvHistory.going !== going) return; // the reader went somewhere else meanwhile
  }
  if (!doc) {
    mdvHistoryProblem(st.name || 'That document', 'it can no longer be opened from here');
    mdvHistoryReturn(st);
    return;
  }
  const shown = await mdvOpenDocument(doc, { push: false, history: { id: st.id, n: st.n }, position: entry ? entry.position : null });
  if (shown || mdvHistory.going !== going) return;
  mdvHistoryProblem(doc.name, 'it could not be read');
  mdvHistoryReturn(st);
}

// The browser moved to an entry whose document could not be shown: it moves back to the one on screen, so the
// address and the buttons never name a document the page does not show (that popstate names the current entry)
function mdvHistoryReturn(st) {
  const here = mdvHistory.index;
  if (here >= 0 && Number.isInteger(st.n) && st.n !== here) history.go(here - st.n);
}

// Reads a document again from where it came from: {kind, path, name}
async function mdvHistoryRead(src) {
  try {
    if (src.kind === 'http' && src.path) return await mdvFetchDocument(new URL(src.path, location.href), src.path);
    if (src.kind === 'desktop' && src.path && window.mdvHost && typeof window.mdvHost.readDocument === 'function') {
      return mdvFromDesktop(await window.mdvHost.readDocument(src.path));
    }
    const folder = window.mdvFolder;
    if (src.path && folder && folder.kind && typeof folder.read === 'function') return await folder.read(src.path);
  } catch (e) { /* gone, or unreadable */ }
  return null;
}

// ------- The toolbar's Back and Forward -------
function mdvHistoryKeyNames() {
  return (typeof MDV_IS_MAC !== 'undefined' && MDV_IS_MAC) ? ['⌥←', '⌥→'] : ['Alt+←', 'Alt+→'];
}

// Shown once there is somewhere to go; each names where it goes
function mdvHistoryButtons() {
  const nav = document.getElementById('mdvHistoryNav');
  const back = document.getElementById('mdvBackBtn');
  const forward = document.getElementById('mdvForwardBtn');
  if (!nav || !back || !forward) return;
  const { order, index, entries } = mdvHistory;
  const canBack = index > 0;
  const canForward = index >= 0 && index < order.length - 1;
  const before = canBack ? entries.get(order[index - 1]) : null;
  const after = canForward ? entries.get(order[index + 1]) : null;
  const keys = mdvHistoryKeyNames();
  nav.hidden = !canBack && !canForward;
  back.disabled = !canBack;
  forward.disabled = !canForward;
  const backName = before ? 'Back to ' + before.doc.name : 'Back';
  const forwardName = after ? 'Forward to ' + after.doc.name : 'Forward';
  back.setAttribute('aria-label', backName);
  forward.setAttribute('aria-label', forwardName);
  back.title = `${backName} (${keys[0]})`;
  forward.title = `${forwardName} (${keys[1]})`;
}

mdvRegisterActions({
  'history-back': { click: () => mdvHistoryBack() },
  'history-forward': { click: () => mdvHistoryForward() },
});

// app.js, which keeps the shortcut table, loads after this file
document.addEventListener('DOMContentLoaded', () => {
  if (typeof mdvRegisterShortcut !== 'function') return;
  mdvRegisterShortcut('Alt+ArrowLeft', () => mdvHistoryBack(), 'Back to the previous document');
  mdvRegisterShortcut('Alt+ArrowRight', () => mdvHistoryForward(), 'Forward to the next document');
  mdvHistoryButtons();
});

// ------- Links that open in the viewer -------
// A link in the document (or in the links panel) to a Markdown file, written as a path: {href, path, fragment}.
// href is the link without its #fragment; path is the file's path, percent-decoded. A web, mail or file: URL,
// an in-document link and a link to any other kind of file are not one.
function mdvMarkdownLink(raw) {
  const href = String(raw == null ? '' : raw).trim();
  if (!href || href.startsWith('#') || href.startsWith('//')) return null;
  const windows = /^[a-zA-Z]:[\\/]/.test(href) || /^\\\\[^\\]/.test(href);
  if (!windows && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null;
  const hash = href.indexOf('#');
  const fragment = hash >= 0 ? href.slice(hash + 1) : '';
  const rest = hash >= 0 ? href.slice(0, hash) : href;
  const query = rest.indexOf('?');
  let path = query >= 0 ? rest.slice(0, query) : rest;
  if (!windows) {
    try { path = decodeURIComponent(path); } catch (e) { /* not valid percent-encoding: as written */ }
  }
  if (!path || !MDV_MARKDOWN_FILE.test(path)) return null;
  return { href: rest, path, fragment };
}

// How a link opens in the viewer: {kind, path, same, read()}, or null to leave it to the browser (or the bridge)
function mdvPlanLink(link) {
  const shown = mdvShownDocument();
  const folder = window.mdvFolder;
  if (folder && folder.kind && typeof folder.resolve === 'function' && typeof folder.read === 'function' && (!shown || shown.kind !== 'http')) {
    let path = null;
    try { path = folder.resolve(shown ? shown.path : null, link.href); } catch (e) { path = null; }
    if (path) {
      const same = !!shown && !!shown.path && mdvSamePath(path, shown.path, shown.kind);
      return { kind: 'folder', path, same, read: () => folder.read(path) };
    }
  }
  const host = window.mdvHost;
  if (mdvInDesktopApp()) {
    if (typeof host.resolvePath !== 'function' || typeof host.readDocument !== 'function') return null;
    // Resolved against the document on screen: the bridge follows it (mdvPointBridgeAt). With no folder to resolve
    // against (pasted text), js/host.js says so.
    const abs = host.resolvePath(link.path);
    if (!abs) return null;
    const same = !!shown && !!shown.path && mdvSamePath(abs, shown.path, 'desktop');
    return { kind: 'desktop', path: abs, same, read: async () => mdvFromDesktop(await host.readDocument(abs)) };
  }
  if (/^https?:$/.test(location.protocol)) {
    const base = shown && shown.kind === 'http' && shown.path ? new URL(shown.path, location.href) : new URL(location.href);
    let url;
    try { url = new URL(link.href, base); } catch (e) { return null; }
    if (url.origin !== location.origin) return null;
    url.hash = '';
    const path = mdvPagePath(url);
    const same = !!shown && shown.kind === 'http' && mdvSamePath(path, shown.path, 'http');
    return { kind: 'http', path, url, same, read: () => mdvFetchDocument(url, path) };
  }
  return null;
}

// The ?file= value that loads `url`: relative to the viewer's folder when it is inside it
function mdvPagePath(url) {
  const folder = new URL('.', location.href).pathname;
  let path = url.pathname.startsWith(folder) ? url.pathname.slice(folder.length) : url.pathname;
  try { path = decodeURIComponent(path); } catch (e) { /* as written */ }
  return path + url.search;
}

function mdvBaseName(path) {
  let name = String(path).split(/[\\/]/).pop();
  try { name = decodeURIComponent(name); } catch (e) { /* as written */ }
  return name;
}

async function mdvFetchDocument(url, path) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(resp.status === 404 ? 'it was not found' : 'the server answered ' + resp.status);
  const text = await resp.text();
  return { name: mdvBaseName(url.pathname), text, path, kind: 'http', fetchedText: text };
}

// A document the desktop bridge read: {path, name, text, mtimeMs, version, …}
function mdvFromDesktop(d) {
  if (!d || typeof d.text !== 'string') throw new Error('it could not be read');
  return { name: d.name, text: d.text, path: d.path, mtimeMs: d.mtimeMs, kind: 'desktop' };
}

function mdvHistoryProblem(name, why) {
  const text = `${name} could not be opened: ${why}.`;
  if (typeof mdvShowToast === 'function') mdvShowToast(text, 'error');
  else console.warn(text);
}

async function mdvFollowPlan(plan, link) {
  if (plan.same) {
    mdvGoToFragment(link.fragment);
    return;
  }
  const going = mdvHistory.going = {};
  let doc = null;
  try {
    doc = await plan.read();
  } catch (e) {
    if (mdvHistory.going === going) mdvHistoryProblem(mdvBaseName(link.path), (e && (e.message || e.code)) || 'it could not be read');
    return;
  }
  if (mdvHistory.going !== going) return; // the reader went somewhere else meanwhile
  if (!doc || (typeof doc.text !== 'string' && !doc.handle)) {
    mdvHistoryProblem(mdvBaseName(link.path), 'it could not be read');
    return;
  }
  const shown = await mdvOpenDocument(doc, { push: true, fragment: link.fragment || null });
  if (!shown) mdvHistoryProblem(doc.name || mdvBaseName(link.path), 'it could not be shown');
}

// A link to the document on screen: to its #fragment, as an in-document link goes (js/links.js)
function mdvGoToFragment(fragment) {
  if (!fragment) return;
  const target = typeof mdvLinkTarget === 'function' ? mdvLinkTarget('#' + fragment) : null;
  if (!target) return;
  if (location.hash !== '#' + fragment) {
    try { history.pushState(history.state, '', '#' + fragment); } catch (e) { /* the jump still happens */ }
  }
  mdvGoTo(target);
}

// Over http, Cmd/Ctrl-click opens the viewer for the linked file in a new tab (the browser would show its raw text)
function mdvViewerAddressFor(link) {
  const plan = /^https?:$/.test(location.protocol) && !mdvInDesktopApp() ? mdvPlanLink(link) : null;
  if (!plan || plan.kind !== 'http') return null;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('file', plan.path);
  url.hash = link.fragment ? '#' + link.fragment : '';
  return url.href;
}

// In the capture phase on window: before js/host.js, which would open the file in a window of its own, and before
// the page's other click listeners
window.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const inPanel = !a.closest('#mdBody') && !!a.closest('#linksPanelContent');
  if (!inPanel && !a.closest('#mdBody')) return;
  const link = mdvMarkdownLink(a.getAttribute('href'));
  if (!link) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    // The desktop app opens it in a window of its own (js/host.js); over http, the viewer opens in a new tab
    const address = !e.altKey ? mdvViewerAddressFor(link) : null;
    if (!address) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.open(address, '_blank', 'noopener');
    return;
  }
  const plan = mdvPlanLink(link);
  if (!plan) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (typeof closeDropdowns === 'function') closeDropdowns();
  if (inPanel && typeof toggleLinksPanel === 'function') toggleLinksPanel();
  mdvFollowPlan(plan, link);
}, true);
