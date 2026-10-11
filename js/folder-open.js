// ============================================
// Opening the folder's documents: the last request wins, and the reader's place is kept
// ============================================
// The sidebar, quick open, search in files and recent documents all show a document through mdvFolderOpenFile or
// mdvFolderShow, which hand it to the load seam (mdvOpenDocument, js/files.js); nothing here renders a document.
//   - The last request wins, whatever route it came by: each open begins at the seam before its file is read
//     (mdvBeginOpen), so a read that finishes after the reader asked for another document (here, a link, Back) is
//     dropped. The seam keeps that one order for every open; this file keeps none of its own.
//   - Returning to a document from here opens it at the reader's place in it, as Back and Forward do (places).
//   - The render that follows is told which document it is (mdvFolderState.pendingOpen, js/folder.js), and a seam
//     that declines or fails leaves nothing behind that a later render could be mistaken for.

// ------- The reader's place in each document -------
// Taken from the load seam as the reader leaves a document of the folder (mdvOnDocumentOpening, js/files.js: its
// event carries the place in the document being replaced), and handed back (mdvOpenDocument's opts.position) when
// they return to it from here, so flipping between a status file and a long handoff keeps the place in both, as
// Back and Forward do. The position is the seam's own record; this file only keeps it.
const MDV_FOLDER_PLACES_MAX = 60;
const mdvFolderPlaces = new Map(); // place key → position, the most recently left last

// A document's place is kept by its path: in the desktop app its path on disk (with or without a folder open); in
// a browser its path in the open folder, for as long as that folder is open.
function mdvFolderPlaceKey(path) {
  if (!path) return null;
  if (mdvFolderIsDesktop()) return 'd:' + (mdvFolderCaseless ? path.toLowerCase() : path);
  return mdvFolderState.kind === 'browser' ? 'b' + mdvFolderState.openId + ':' + path : null;
}

function mdvFolderNoteLeaving(event) {
  if (!event || !event.position || (event.kind !== 'open' && event.kind !== 'history')) return;
  const s = mdvFolderState;
  const key = mdvFolderPlaceKey(mdvFolderIsDesktop() ? s.shown && s.shown.path : s.current);
  if (!key) return;
  mdvFolderPlaces.delete(key);
  mdvFolderPlaces.set(key, event.position);
  if (mdvFolderPlaces.size > MDV_FOLDER_PLACES_MAX) mdvFolderPlaces.delete(mdvFolderPlaces.keys().next().value);
}
mdvOnDocumentOpening(mdvFolderNoteLeaving);

function mdvFolderPlaceOf(path) {
  const key = mdvFolderPlaceKey(path);
  return key ? mdvFolderPlaces.get(key) || null : null;
}

// Shows a document through the load seam (js/files.js), at the reader's place in it when they read it before
// (atPlace), and resolves once it is on screen. begun: the open as mdvBeginOpen() began it, before the file was read.
// pendingOpen tells the render that follows which document it is.
async function mdvFolderShow(doc, identity, { atPlace = true, begun } = {}) {
  const s = mdvFolderState;
  const pending = { text: doc.text, identity };
  s.pendingOpen = pending;
  const shown = identity.path ? mdvFolderWhenShowing(identity.path, 5000) : null;
  const place = atPlace ? mdvFolderPlaceOf(identity.path) : null;
  const opts = { push: true, begun };
  if (place) opts.position = place;
  let result;
  try {
    result = await window.mdvOpenDocument(doc, opts);
  } catch (e) {
    console.error('folder: mdvOpenDocument failed:', e);
    if (s.pendingOpen === pending) s.pendingOpen = null;
    mdvFolderToast((doc.name || identity.name) + ' could not be shown: ' + mdvFolderSentence(String((e && e.message) || e)), 'error');
    return false;
  }
  // The seam declined (false): the document on screen stays, and a later render with the same text is not this one.
  if (result === false) {
    if (s.pendingOpen === pending) s.pendingOpen = null;
    return false;
  }
  return shown ? shown : true;
}

// ------- Opening one of the folder's documents -------
// Through mdvOpenDocument (js/files.js) only. opts.newWindow (Cmd/Ctrl-click, desktop): its own window, as a link
// does. opts.then(): runs once the document is on screen (search across files scrolls to the match there), and the
// document then opens at its top rather than at the reader's earlier place. opts.focus: the keyboard focus moves
// into the document once it is shown (Enter on a row of the sidebar).
async function mdvFolderOpenFile(path, opts = {}) {
  const s = mdvFolderState;
  if (mdvFolderIsDesktop() && opts.newWindow) {
    await window.mdvHost.openPath(path);
    return true;
  }
  const open = mdvBeginOpen();
  const entry = s.byPath.get(path);
  const label = (entry && entry.rel) || mdvFolderBaseName(path);
  let doc;
  try {
    doc = await mdvFolderRead(path);
  } catch (e) {
    if (!open.current()) return false;
    mdvFolderToast(mdvFolderSentence((e && e.message) || (label + ' could not be read')), 'error');
    if (e && e.code === 'not-found') mdvFolderRefresh();
    return false;
  }
  if (!open.current()) return false; // the reader asked for another document meanwhile
  const done = () => {
    if (!open.current()) return;
    if (opts.then) opts.then();
    if (opts.focus) mdvFolderFocusDocument();
  };
  // Already on screen, exactly: nothing to load, only the place to show.
  if (s.current && mdvFolderSamePath(s.current, doc.path) && rawMarkdown === doc.text) {
    done();
    return true;
  }
  const identity = { kind: doc.handle ? 'handle' : 'path', path: doc.path, name: doc.name, handle: doc.handle || null };
  const ok = await mdvFolderShow(doc, identity, { atPlace: !opts.then, begun: open });
  if (ok) done();
  return ok;
}

// The keyboard focus on the document itself (not on a control), so Space and the arrows scroll it and Tab goes on
// into it. Nothing scrolls.
function mdvFolderFocusDocument() {
  const body = document.getElementById('mdBody');
  if (!body || !body.childElementCount) return;
  if (typeof mdvFocusInDocument === 'function') mdvFocusInDocument(body);
  else { body.tabIndex = -1; body.focus({ preventScroll: true }); }
}

function mdvFolderWhenShowing(path, ms) {
  return new Promise((resolve) => {
    const stop = mdvFolderOn('shown', (identity) => {
      if (identity && mdvFolderSamePath(identity.path, path)) { stop(); clearTimeout(timer); resolve(true); }
    });
    const timer = setTimeout(() => { stop(); resolve(false); }, ms);
  });
}
