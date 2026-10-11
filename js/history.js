// ============================================
// Back and forward between documents
// ============================================
// A reader follows a link from a handoff to the plan it names, reads, and comes back. Each document shown is a place
// in the tab's own history, so the address, the browser's Back and Forward and these agree.
//
//   - The toolbar's ‹ and ›, Alt+← and Alt+→, and the desktop app's Go menu (⌘[ and ⌘] on a Mac) go to the previous
//     or next DOCUMENT. They step over the places inside the document on screen (an in-document link, a "#"
//     permalink), and each button names the document it goes to. The browser's own Back and Forward (and its ⌘[ and
//     ⌘]) still move one place at a time.
//   - A document comes back as the reader left it: at the same words (js/reading-place.js), with the focus on the link
//     they followed out of it, and with the comment changes it had, still unsaved (so live reload asks before it
//     replaces them). Its file is read again first, so the version on disk now is the one shown; when it changed
//     since, a note says so.
//   - The tab keeps its places across a reload of the page: they are written to sessionStorage, so Back and Forward
//     still name and reach them (a document opened through a handle cannot be read again after a reload, and says so).
//
// Every place this page makes in the tab's history carries a state {mdvDoc: {id, n, kind, path, name}}: the document
// (id) and the place's position in the tab's history (n, counted from the first place this page saw). The places in
// one document share its id. js/links.js makes an in-document place with mdvHistoryPushPlace; a place the browser
// makes itself (the "#" permalink after a heading) is named when it arrives. A page that shows one document and is
// never navigated does not touch the tab's history at all.
//
// Links that open in the viewer are js/document-links.js.

// The documents whose text stays in memory, nearest the current one first; the others are read again from their file
// when the reader returns to them (pasted text, and text with unsaved comment changes, always stays)
const MDV_HISTORY_TEXTS = 40;
// Back reads the file again before showing it; past this, the kept text is shown and live reload follows
const MDV_HISTORY_FRESH_MS = 600;
// A document that is no longer kept in memory may take longer to read
const MDV_HISTORY_READ_MS = 10000;
const MDV_HISTORY_STORE = 'mdv-history';
const MDV_HISTORY_POSITIONS = 120; // places kept in sessionStorage around the current one

const mdvHistory = {
  docs: new Map(),   // id → {id, doc, position, link, unsaved}: a document shown in this tab, as the reader left it
  order: [],         // tab history position → document id, as far as this page knows (in-document places repeat it)
  index: -1,         // the tab's position now (Back moves it at once; its document follows once it is read)
  shown: null,       // the id of the document on screen
  seq: 0,
  going: null,       // the latest Back/Forward or link being followed; an older one that finishes later gives way
  leaving: null,     // {href, nth}: the link the reader is following out of the document on screen
  fragment: false,   // the browser is making an in-document place of its own (a "#" permalink was clicked)
};

function mdvHistoryRecord() { return mdvHistory.shown ? mdvHistory.docs.get(mdvHistory.shown) || null : null; }

// Ids stay unique across page reloads: the browser keeps the states of entries made before one
function mdvHistoryNewId() { return 'd' + Date.now().toString(36) + '-' + (++mdvHistory.seq).toString(36); }

function mdvHistoryAdd(doc, id) {
  const record = { id: id || mdvHistoryNewId(), doc, position: null, link: null, unsaved: false };
  mdvHistory.docs.set(record.id, record);
  return record;
}

// What the browser keeps for a place: enough to read its document again after the page reloads
function mdvHistoryState(id, n) {
  const record = mdvHistory.docs.get(id);
  const d = record ? record.doc : {};
  return { mdvDoc: { id, n, kind: d.kind, path: d.path || null, name: d.name } };
}

// The address of a document's place: ?file= names it where a reload of the page can load it again (a ?file= link
// over http; the name of a chosen or dropped file and "pasted", as the viewer always wrote them). A file opened
// through a handle has no such address: without ?file=, a reload reopens the last file.
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

// The tab's place now names its document, so the browser's Back and Forward find it. Done only when the reader moves
// on from it, so a page that only shows one document never touches the tab's history.
function mdvHistoryTagHere() {
  const id = mdvHistory.order[mdvHistory.index] || mdvHistory.shown;
  if (!id || mdvHistory.index < 0) return;
  const st = history.state && history.state.mdvDoc;
  if (st && st.id === id && st.n === mdvHistory.index) return;
  mdvHistory.order[mdvHistory.index] = id;
  mdvHistoryWrite('replaceState', Object.assign({}, history.state, mdvHistoryState(id, mdvHistory.index)), location.href);
}

// A new place after the one on screen: the browser drops the places that were after it
function mdvHistoryMoveTo(n, id) {
  mdvHistory.order = mdvHistory.order.slice(0, n);
  mdvHistory.order[n] = id;
  mdvHistory.index = n;
}

// An in-document place (js/links.js, and a link to the document on screen): a new place of the same document
function mdvHistoryPushPlace(hash) {
  const id = mdvHistory.shown;
  if (!id || mdvHistory.index < 0) {
    try { history.pushState(history.state, '', hash); } catch (e) { /* the jump still happens */ }
    return;
  }
  mdvHistoryTagHere();
  mdvHistoryMoveTo(mdvHistory.index + 1, id);
  mdvHistoryWrite('pushState', mdvHistoryState(id, mdvHistory.index), hash);
  mdvHistoryChanged();
}

// The browser made an in-document place itself (a "#" permalink): it is named as one of the document on screen
function mdvHistoryNoteFragment() {
  if (!mdvHistory.fragment) return;
  mdvHistory.fragment = false;
  const id = mdvHistory.shown;
  if (!id || mdvHistory.index < 0 || (history.state && history.state.mdvDoc)) return;
  mdvHistoryMoveTo(mdvHistory.index + 1, id);
  mdvHistoryWrite('replaceState', Object.assign({}, history.state, mdvHistoryState(id, mdvHistory.index)), location.href);
  mdvHistoryChanged();
}

// Comment work not in the file yet, as the reader leaves a document (js/live-reload.js reads the comment code's state)
function mdvHistoryUnsavedNow() { return typeof mdvCommentWorkUnsaved === 'function' ? mdvCommentWorkUnsaved() : false; }

// Just before a document replaces the page (the old one is still on screen): the record of the one being left keeps
// the reader's place, the link they followed, and its text as it is now, with any comment changes
mdvOnDocumentOpening((event) => {
  if (event.kind === 'first' || event.kind === 'reload') return;
  let out = mdvHistoryRecord();
  if (!out && event.previous) {
    // A document that was on screen before the viewer followed renders (the #demo page) gets the page's place
    out = mdvHistoryAdd(event.previous);
    mdvHistory.order = [out.id];
    mdvHistory.index = 0;
    mdvHistory.shown = out.id;
  }
  if (out) {
    out.position = event.position;
    out.link = event.kind === 'open' ? mdvHistory.leaving : null;
    out.unsaved = mdvHistoryUnsavedNow();
    if (typeof event.previousText === 'string' && event.previousText !== out.doc.text) {
      const sourceText = typeof out.doc.sourceText === 'string' ? out.doc.sourceText : out.doc.text;
      out.doc = Object.assign({}, out.doc, { text: event.previousText, sourceText });
    }
  }
  mdvHistory.leaving = null;
  if (event.kind === 'history') {
    const { id, n } = event.history;
    if (!mdvHistory.docs.has(id)) mdvHistoryAdd(event.doc, id);
    mdvHistory.order[n] = id;
    mdvHistory.index = n;
    mdvHistory.shown = id;
    return;
  }
  const entry = mdvHistoryAdd(event.doc);
  mdvHistory.shown = entry.id;
  if (event.push && out) {
    mdvHistoryTagHere();
    mdvHistoryMoveTo(mdvHistory.index + 1, entry.id);
    mdvHistoryWrite('pushState', mdvHistoryState(entry.id, mdvHistory.index), mdvHistoryUrl(event.doc, { fragment: event.fragment }));
  } else {
    if (mdvHistory.index < 0) mdvHistory.index = 0;
    mdvHistory.order[mdvHistory.index] = entry.id;
    mdvHistoryWrite('replaceState', mdvHistoryState(entry.id, mdvHistory.index), mdvHistoryUrl(event.doc, { fragment: event.fragment }));
  }
});

// Once it is on screen: the record holds the document as shown
mdvOnDocumentOpened((event) => {
  if (event.kind === 'first') mdvHistoryFirst(event.doc);
  else {
    const record = mdvHistoryRecord();
    if (record) {
      record.doc = event.doc;
      if (event.kind !== 'history') record.unsaved = false;
    }
  }
  // A link's tooltip (js/links.js) names a link of the document that was replaced: the pointer that rested on
  // the link that was followed never left it, so nothing else would hide it
  if (event.kind === 'open' || event.kind === 'history') {
    const tip = document.getElementById('linkTooltip');
    if (tip) tip.classList.remove('visible');
  }
  mdvHistoryChanged();
});

// The first document of the page. After a reload of the page, the tab's place on screen still names a document: when
// it is this one, the place keeps its id (the in-document places after it carry that id too), and the places the tab
// kept come back from sessionStorage.
function mdvHistoryFirst(doc) {
  const prior = history.state && history.state.mdvDoc;
  const n = prior && Number.isInteger(prior.n) && prior.n >= 0 ? prior.n : 0;
  const same = !!prior && typeof prior.id === 'string' && prior.name === doc.name && (prior.path || null) === (doc.path || null);
  mdvHistory.docs = new Map();
  mdvHistory.order = [];
  if (prior && typeof prior.id === 'string') mdvHistoryLoad(prior);
  const record = (same && mdvHistory.docs.get(prior.id)) || mdvHistoryAdd(doc, same ? prior.id : null);
  record.doc = doc;
  mdvHistory.order[n] = record.id;
  mdvHistory.index = n;
  mdvHistory.shown = record.id;
  // A chosen, dropped or pasted document names itself in the address, as the viewer always did
  if (doc.kind === 'file' || doc.kind === 'pasted') {
    mdvHistoryWrite('replaceState', Object.assign({}, history.state, mdvHistoryState(record.id, n)), mdvHistoryUrl(doc, { first: true }));
  }
}

// ------- Keeping the places across a reload of the page -------
function mdvHistorySave() {
  const { order, index } = mdvHistory;
  if (index < 0) return;
  const from = Math.max(0, index - MDV_HISTORY_POSITIONS / 2);
  const kept = order.map((id, n) => (n >= from && n < from + MDV_HISTORY_POSITIONS ? id || null : null));
  const docs = {};
  for (const id of kept) {
    const r = id && mdvHistory.docs.get(id);
    if (r && !docs[id]) {
      const d = r.doc || {};
      docs[id] = { doc: { kind: d.kind, path: d.path || null, name: d.name, title: d.title || null }, position: r.position || null, link: r.link || null };
    }
  }
  try { sessionStorage.setItem(MDV_HISTORY_STORE, JSON.stringify({ v: 1, order: kept, docs })); } catch (e) { /* storage off: only this page's life */ }
}

function mdvHistoryLoad(prior) {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(MDV_HISTORY_STORE) || 'null'); } catch (e) { saved = null; }
  if (!saved || saved.v !== 1 || !Array.isArray(saved.order) || saved.order[prior.n] !== prior.id || !saved.docs) return;
  mdvHistory.order = saved.order.map((id) => (typeof id === 'string' && saved.docs[id] ? id : undefined));
  for (const [id, r] of Object.entries(saved.docs)) {
    if (!r || !r.doc) continue;
    const record = mdvHistoryAdd(Object.assign({}, r.doc, { path: r.doc.path || null }), id);
    record.position = r.position || null;
    record.link = r.link || null;
  }
}

// After every change: the far texts go, the buttons follow, and the places are written down
function mdvHistoryChanged() {
  mdvHistoryTrim();
  mdvHistoryButtons();
  mdvHistorySave();
}

// Records of places the browser dropped (a new document after going back) go; far ones keep only where to read them from
function mdvHistoryTrim() {
  const live = new Set(mdvHistory.order.filter(Boolean));
  for (const id of [...mdvHistory.docs.keys()]) if (!live.has(id)) mdvHistory.docs.delete(id);
  const near = new Set();
  for (let d = 0; near.size < MDV_HISTORY_TEXTS && d < mdvHistory.order.length; d++) {
    for (const j of [mdvHistory.index - d, mdvHistory.index + d]) if (mdvHistory.order[j]) near.add(mdvHistory.order[j]);
  }
  for (const [id, record] of mdvHistory.docs) {
    const d = record.doc;
    if (near.has(id) || record.unsaved || !d || typeof d.text !== 'string') continue;
    const readable = !!d.handle || (!!d.path && (d.kind === 'http' || d.kind === 'desktop' || d.kind === 'folder'));
    if (readable) record.doc = Object.assign({}, d, { text: undefined, sourceText: undefined });
  }
}

// ------- Going back and forward -------
// The nearest place before (dir -1) or after (+1) that belongs to another document: {n, record}, or {n, record: null}
// for a place this page does not know (one from before a reload of the page), or null
function mdvHistoryTarget(dir) {
  const { order, index } = mdvHistory;
  if (index < 0) return null;
  const here = mdvHistory.shown || order[index];
  for (let n = index + dir; n >= 0 && (dir < 0 || n < order.length); n += dir) {
    const id = order[n];
    if (!id) return { n, record: null };
    if (id !== here) return { n, record: mdvHistory.docs.get(id) || null };
  }
  return null;
}

function mdvHistoryGo(dir) {
  const target = mdvHistoryTarget(dir);
  if (!target) return false; // nothing there: Alt+← and the like stay the browser's
  history.go(target.n - mdvHistory.index);
  return true;
}
function mdvHistoryBack() { return mdvHistoryGo(-1); }
function mdvHistoryForward() { return mdvHistoryGo(1); }

window.addEventListener('popstate', (e) => {
  const st = e.state && e.state.mdvDoc;
  if (!st) { mdvHistoryNoteFragment(); return; }
  const from = mdvHistory.index;
  if (Number.isInteger(st.n)) { mdvHistory.order[st.n] = st.id; mdvHistory.index = st.n; }
  // A place in the document on screen: the browser scrolls there
  if (st.id === mdvHistory.shown) { mdvHistoryChanged(); return; }
  mdvHistoryShow(st, from);
});
window.addEventListener('hashchange', mdvHistoryNoteFragment);

// The "#" permalink after a heading is the browser's own jump; the place it makes is named when it arrives
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('#mdBody a.header-anchor[href^="#"]') : null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (location.hash === a.hash) return;
  mdvHistoryTagHere();
  mdvHistory.fragment = true;
});

// Back or Forward moved the tab to a place of another document (`from` is where it was): that document is read and shown
async function mdvHistoryShow(st, from) {
  const going = mdvHistory.going = {};
  const record = mdvHistory.docs.get(st.id) || null;
  const kept = record && record.doc && typeof record.doc.text === 'string' ? record.doc : null;
  let doc = kept;
  let readAgain = false;
  // The version on disk now, unless the reader left comment changes in the kept text: those stay, and live reload asks
  // before it replaces them
  if (!(kept && record.unsaved)) {
    const fresh = await mdvHistoryRead(record && record.doc ? record.doc : st, kept ? MDV_HISTORY_FRESH_MS : MDV_HISTORY_READ_MS);
    if (mdvHistory.going !== going) return; // the reader went somewhere else meanwhile
    if (fresh) {
      readAgain = true;
      doc = Object.assign({}, record ? record.doc : null, fresh);
      if (typeof fresh.text === 'string') doc.sourceText = fresh.text;
    }
  }
  if (!doc) {
    mdvHistoryProblem(st.name || 'That document', 'it can no longer be opened from here');
    mdvHistoryReturn(st, from);
    return;
  }
  const opens = mdvOpenSeq;
  const shown = await mdvOpenDocument(doc, { push: false, history: { id: st.id, n: st.n }, position: record ? record.position : null });
  if (mdvHistory.going !== going) return;
  if (!shown) {
    if (mdvOpenSeq !== opens + 1) return; // a newer open overtook this one
    mdvHistoryProblem(doc.name, 'it could not be read');
    mdvHistoryReturn(st, from);
    return;
  }
  // Its comment changes are still not in its file: the comment code says so again, and live reload asks before it
  // replaces them
  if (record && record.unsaved && typeof doc.text === 'string' && rawMarkdown === doc.text && typeof mdvDirty !== 'undefined') {
    mdvDirty = true;
    record.unsaved = true;
  }
  // The file changed while the reader was away
  const left = kept && (typeof kept.sourceText === 'string' ? kept.sourceText : kept.text);
  if (readAgain && typeof left === 'string' && rawMarkdown !== left && typeof mdvLiveToast === 'function') mdvLiveToast('Updated since you left');
  mdvHistoryFocus(record);
}

// The focus goes back to the link the reader followed out of the document, or to the words they are back at, so
// Tab goes on from there
function mdvHistoryFocus(record) {
  const body = document.getElementById('mdBody');
  if (!body) return;
  const link = record && record.link && typeof mdvFindLink === 'function' ? mdvFindLink(record.link) : null;
  if (link) { link.focus({ preventScroll: true }); return; }
  const place = typeof mdvBlockAtLine === 'function' ? mdvBlockAtLine(body, mdvToolbarHeight() + 8) : null;
  const el = place || body.querySelector('h1, h2, h3, h4, h5, h6') || body;
  if (typeof mdvFocusInDocument === 'function') mdvFocusInDocument(el);
}

// The browser moved to a place whose document could not be shown: it moves back to where it was, so the address and
// the buttons never name a document the page does not show (that popstate names a place of the document on screen)
function mdvHistoryReturn(st, from) {
  if (!(from >= 0) || !Number.isInteger(st.n) || st.n === from || mdvHistory.index !== st.n) return;
  history.go(from - st.n);
}

// Reads a document again from where it came from ({kind, path, name, handle}), within `ms`: a document, or null.
// A file with a handle is read by the load seam itself (through the comment code), so it comes back without text.
async function mdvHistoryRead(src, ms) {
  try {
    if (src.handle) return Object.assign({}, src, { text: undefined, sourceText: undefined });
    if (src.kind === 'http' && src.path) return await mdvFetchDocument(new URL(src.path, location.href), src.path, ms);
    if (src.kind === 'desktop' && src.path && window.mdvHost && typeof window.mdvHost.readDocument === 'function') {
      return mdvFromDesktop(await mdvWithin(window.mdvHost.readDocument(src.path), ms));
    }
    const folder = window.mdvFolder;
    if (src.path && folder && folder.kind && typeof folder.read === 'function') return await mdvWithin(folder.read(src.path), ms);
  } catch (e) { /* gone, unreadable, or too slow */ }
  return null;
}

// Resolves as `promise` does, or rejects after `ms`
function mdvWithin(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer = 0;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('it took too long')), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function mdvHistoryProblem(name, why) {
  const text = `${name} could not be opened: ${why}.`;
  if (typeof mdvShowToast === 'function') mdvShowToast(text, 'error');
  else console.warn(text);
}

// ------- The toolbar's Back and Forward -------
function mdvHistoryKeyNames() {
  return (typeof MDV_IS_MAC !== 'undefined' && MDV_IS_MAC) ? ['⌥←', '⌥→'] : ['Alt+←', 'Alt+→'];
}

// Shown once there is somewhere to go; each names the document it goes to
function mdvHistoryButtons() {
  const nav = document.getElementById('mdvHistoryNav');
  const back = document.getElementById('mdvBackBtn');
  const forward = document.getElementById('mdvForwardBtn');
  if (!nav || !back || !forward) return;
  const before = mdvHistoryTarget(-1);
  const after = mdvHistoryTarget(1);
  const keys = mdvHistoryKeyNames();
  nav.hidden = !before && !after;
  back.disabled = !before;
  forward.disabled = !after;
  const name = (t) => (t && t.record && t.record.doc && t.record.doc.name) || '';
  const backName = name(before) ? 'Back to ' + name(before) : 'Back';
  const forwardName = name(after) ? 'Forward to ' + name(after) : 'Forward';
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
