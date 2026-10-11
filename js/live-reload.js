// ============================================
// Live reload: the document follows its file
// ============================================
// Status reports, plans and handoffs change while they are read. When the file of the document on screen changes,
// the new version is shown where the reader is (js/reading-place.js keeps their words in place and their folds
// folded), the blocks that changed are marked for a moment, and a quiet note says where: "Updated: Status".
//
// What the reader sees of it (the note, the marks of what changed, the question and the mark at the top right) is
// js/live-notes.js.
//
// A document with comment work that is not in its file yet is never replaced under the reader. With unsaved
// comment changes, "Changed on disk: reload?" asks first; Reload keeps those changes in the comments panel, and
// "Not now" leaves a quiet "Newer version on disk" mark at the top right that asks again when clicked (or Alt+R).
// While a comment box is open (typed into or not), the new version waits, marked the same way, and is shown once
// the box closes: a reload would leave the box pointing at text that is gone, and it could never be saved.
//
// Where a change is noticed:
//   - a file opened through a handle (the Open button and drag-and-drop in Chromium, the writable open, a folder):
//     its modification time and size, every 1.5 s; the text is read only when one of them moves;
//   - a document from a ?file= link over http: a conditional request (If-None-Match / If-Modified-Since) every 2 s;
//   - the desktop app: the shell watches the window's own file and js/host.js shows each new version (this file adds
//     the note, through mdvHost.onDocumentChanged); a document opened in the window from a link is not watched by
//     the shell, so it is read through the bridge every 2 s.
// Only while the page is visible: a hidden tab costs nothing, and a page that becomes visible again looks at once.
// Nothing is looked at while a comment save is writing the file or another document is being opened.
//
// A look that has not answered after 8 s has failed (a server that hangs, a network volume that stalls): it never
// stops the looks that follow, and a look about a document no longer on screen is dropped. A look that fails waits
// longer each time (up to 30 s). A file that is not there (removed, renamed, a branch switch) says so at the top
// right, and is looked at every 4 s at most until it comes back.
//
// A new version is shown once two looks agree on it (the second 300 ms after the first): a program that saves by
// emptying the file and then writing it would otherwise be caught half-way, and the reader would lose their place to
// an empty page. A file that keeps changing (an agent writing into it all the time) is shown at every third look
// instead of never; an empty version is never shown while the file is changing.
//
// What counts as unsaved comment work is the comment code's own state, read here: mdvDirty (a change not written
// yet), mdvWritesQueued (a save in flight), and a conflict or error notice of the document load on screen
// (mdvNotices, mdvLoadSeq). When the comment code is already asking about the file (its conflict notice offers
// "Reload from disk"), this does not ask again.

const MDV_LIVE_HANDLE_MS = 1500;
const MDV_LIVE_HTTP_MS = 2000;
const MDV_LIVE_DESKTOP_MS = 2000;
// A look that reads the whole file (the desktop bridge; an http server that sends no validators) is made less
// often for a large document; a look that fails (the server is down, a timeout) waits longer each time
const MDV_LIVE_LARGE = 1000000;
const MDV_LIVE_LARGE_MS = 10000;
const MDV_LIVE_MAX_BACKOFF_MS = 30000;
const MDV_LIVE_GONE_MS = 4000;
const MDV_LIVE_TIMEOUT_MS = 8000;
const MDV_LIVE_SETTLE_MS = 300;

const mdvLive = {
  timer: 0,
  look: null,          // the look on its way: {gen, over, abort}; a tick starts no second look for the same document
  gen: 0,              // counts documents shown; a look that started before the latest one is dropped
  key: null,           // the source the last look was about
  seen: null,          // its version the last look saw (time and size, a version token, or the text)
  base: null,          // http and desktop: the text of the version on screen, as its source gave it
  validators: null,    // http: {etag, lastModified, conditional}
  failures: 0,         // looks in a row that failed
  gone: false,         // the last look found no file
  windowFile: null,    // desktop: the window's own file, which the shell watches
  candidate: null,     // a new version seen once; it is shown when the next look sees it again
  unsettled: 0,        // looks in a row that each saw another new version
  soon: false,         // the look asked for the next one in 300 ms
  pending: null,       // {target, change}: the newer version waiting for the reader
  deferred: null,      // why it waits without the question: 'typing' (a comment box is open) or 'dismissed' (Not now)
  prompt: null,        // the question, while it is shown
};

// What to watch for the document on screen: {kind, key, every, …}, or null
function mdvLiveTarget() {
  const shown = mdvShownDocument();
  if (!shown) return null;
  const host = window.mdvHost;
  if (mdvInDesktopApp()) {
    if (shown.kind !== 'desktop' || !shown.path || typeof host.readDocument !== 'function') return null;
    if (mdvLive.windowFile && mdvSamePath(shown.path, mdvLive.windowFile, 'desktop')) return null; // the shell watches it
    return { kind: 'desktop', key: 'desktop:' + shown.path, path: shown.path, every: mdvLiveEvery(MDV_LIVE_DESKTOP_MS, true) };
  }
  const handle = typeof mdvFileHandle !== 'undefined' ? mdvFileHandle : null;
  if (handle && typeof handle.getFile === 'function') return { kind: 'handle', key: handle, handle, every: mdvLiveEvery(MDV_LIVE_HANDLE_MS, false) };
  if (shown.kind === 'http' && shown.path && /^https?:$/.test(location.protocol)) {
    const url = new URL(shown.path, location.href);
    url.hash = '';
    const whole = !(mdvLive.validators && mdvLive.validators.conditional);
    return { kind: 'http', key: 'http:' + url.href, url: url.href, every: mdvLiveEvery(MDV_LIVE_HTTP_MS, whole, true) };
  }
  return null;
}

// How long until the next look: longer for a large file read whole, after failed looks, and (over http, where each
// miss is a line in the browser's console) while the file is not there
function mdvLiveEvery(ms, readsWholeFile, logsMisses) {
  if (readsWholeFile && typeof mdvLive.base === 'string' && mdvLive.base.length > MDV_LIVE_LARGE) ms = MDV_LIVE_LARGE_MS;
  if (mdvLive.failures) return Math.min(MDV_LIVE_MAX_BACKOFF_MS, ms * 2 ** mdvLive.failures);
  if (mdvLive.gone && logsMisses) return Math.max(ms, MDV_LIVE_GONE_MS);
  return ms;
}

function mdvLiveSchedule(delay) {
  clearTimeout(mdvLive.timer);
  mdvLive.timer = 0;
  if (document.visibilityState === 'hidden') return;
  const target = mdvLiveTarget();
  if (!target) return;
  mdvLive.timer = setTimeout(mdvLiveTick, delay != null ? delay : target.every);
}

async function mdvLiveTick() {
  mdvLive.timer = 0;
  if (document.visibilityState === 'hidden') return;
  const target = mdvLiveTarget();
  if (!target) return;
  // A look on its way schedules the next one. It ends by its timeout at the latest, and a new document drops it.
  if (mdvLive.look) return;
  if (mdvLive.pending && mdvLiveCommentsAsking()) mdvLiveClearPending(); // the comment code asks instead
  else mdvLiveBoxChanged();
  let soon = false;
  if (!mdvLiveBusy()) {
    const look = mdvLive.look = { gen: mdvLive.gen, over: false, abort: null };
    const result = await mdvLiveRun(target, look);
    if (look.gen !== mdvLive.gen) return; // another document is on screen; its own looks are scheduled
    mdvLiveNote(result);
    soon = mdvLive.soon;
  }
  mdvLive.soon = false;
  if (!mdvLive.timer) mdvLiveSchedule(soon ? MDV_LIVE_SETTLE_MS : null);
}

// One look, ended by MDV_LIVE_TIMEOUT_MS at the latest: 'ok', 'gone' (no file), 'error' or 'stale' (it no longer matters)
async function mdvLiveRun(target, look) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  look.signal = controller ? controller.signal : undefined;
  look.abort = () => { look.over = true; if (controller) controller.abort(); };
  let timer = 0;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { look.abort(); resolve('error'); }, MDV_LIVE_TIMEOUT_MS); });
  try {
    return await Promise.race([mdvLiveLook(target, look).catch(() => (look.over ? 'stale' : 'error')), timeout]);
  } finally {
    clearTimeout(timer);
    look.over = true; // whatever the look still does after its time is up is dropped
    if (mdvLive.look === look) mdvLive.look = null;
  }
}

function mdvLiveNote(result) {
  if (result === 'stale') return;
  if (result === 'error') { mdvLive.failures++; return; }
  mdvLive.failures = 0;
  const gone = result === 'gone';
  if (gone !== mdvLive.gone) {
    mdvLive.gone = gone;
    mdvLiveUpdateChip();
  }
}

// A comment save writing the file, or another document being opened: not a moment to look
function mdvLiveBusy() {
  try {
    if (typeof mdvWritesQueued === 'number' && mdvWritesQueued > 0) return true;
    if (typeof mdvDocumentChanging === 'function' && mdvDocumentChanging()) return true;
  } catch (e) { /* the comment code is not there */ }
  return !!mdvPendingOpen;
}

async function mdvLiveLook(target, look) {
  const stale = () => look.over || look.gen !== mdvLive.gen;
  if (mdvLive.key !== target.key) {
    mdvLive.key = target.key;
    mdvLive.seen = null;
    mdvLive.candidate = null;
    mdvLive.unsettled = 0;
    mdvLive.validators = null;
  }
  if (target.kind === 'handle') {
    let file;
    try { file = await target.handle.getFile(); } catch (e) { return e && e.name === 'NotFoundError' ? 'gone' : 'error'; }
    if (stale()) return 'stale';
    const sig = file.lastModified + ':' + file.size;
    if (mdvLive.seen === sig) return 'ok';
    const text = await mdvLiveDecode(file);
    if (stale()) return 'stale';
    if (text == null) return 'ok'; // it changed while it was read: the next look reads it
    if (mdvLiveKnownText(target.handle, text)) { mdvLive.seen = sig; mdvLiveSettled(); return 'ok'; }
    return mdvLiveNewVersion(target, sig, { text });
  }
  if (target.kind === 'http') {
    const v = mdvLive.validators;
    const headers = {};
    if (v && v.conditional && !mdvLive.candidate) {
      if (v.etag) headers['If-None-Match'] = v.etag;
      if (v.lastModified) headers['If-Modified-Since'] = v.lastModified;
    }
    const resp = await fetch(target.url, { cache: 'no-store', headers, signal: look.signal });
    if (stale()) return 'stale';
    if (resp.status === 304) return 'ok';
    if (resp.status === 404 || resp.status === 410) return 'gone';
    if (!resp.ok) return 'error';
    const validators = mdvLiveValidators(resp);
    const text = await resp.text();
    if (stale()) return 'stale';
    mdvLive.validators = validators;
    if (text === mdvLive.seen) return 'ok';
    if (mdvLiveIsOnScreen(text)) { mdvLive.seen = text; mdvLiveSettled(); return 'ok'; }
    return mdvLiveNewVersion(target, text, { text });
  }
  if (target.kind === 'desktop') {
    let doc;
    try { doc = await window.mdvHost.readDocument(target.path); } catch (e) { return e && e.code === 'not-found' ? 'gone' : 'error'; }
    if (stale()) return 'stale';
    if (!doc || typeof doc.text !== 'string') return 'error';
    const sig = doc.version || doc.text;
    if (mdvLive.seen === sig) return 'ok';
    if (mdvLiveIsOnScreen(doc.text)) { mdvLive.seen = sig; mdvLiveSettled(); return 'ok'; }
    return mdvLiveNewVersion(target, sig, { text: doc.text, doc });
  }
  return 'ok';
}

// A version that is not the one on screen. It is shown when the next look sees it again; while the file keeps
// changing, the newest one is shown at the third look in a row that sees another version (unless it is empty).
async function mdvLiveNewVersion(target, sig, change) {
  if (mdvLive.candidate !== sig) {
    mdvLive.unsettled++;
    if (mdvLive.unsettled < 3 || !change.text.trim()) {
      mdvLive.candidate = sig;
      mdvLive.soon = mdvLive.unsettled === 1; // looked at again shortly; after that, at the usual pace
      return 'ok';
    }
  }
  mdvLiveSettled();
  mdvLive.seen = sig;
  await mdvLiveChanged(target, change);
  return 'ok';
}

// The file holds the version on screen again (or a new one is being shown): nothing waits
function mdvLiveSettled() {
  mdvLive.candidate = null;
  mdvLive.unsettled = 0;
}

// The file's text, decoded as the comment code decodes it; null when it changed while being read
async function mdvLiveDecode(file) {
  let buffer;
  try { buffer = await file.arrayBuffer(); } catch (e) { return null; }
  if (typeof mdvDecode === 'function') return mdvDecode(buffer).text;
  return new TextDecoder('utf-8').decode(buffer);
}

// The text of a version the viewer knows: the one the comment code last read or wrote (its own save is no
// change), or the one on screen
function mdvLiveKnownText(handle, text) {
  try {
    const base = mdvBases.get(handle);
    if (base && !base.overwrite && typeof base.text === 'string') return base.text === text;
  } catch (e) { /* the comment code is not there */ }
  return text === rawMarkdown;
}

// The source holds the version on screen: the one it gave, or the one the page shows now
function mdvLiveIsOnScreen(text) {
  if (text === mdvLive.base) return true;
  const shown = typeof mdvDocText === 'string' ? mdvDocText : rawMarkdown;
  if (text !== shown) return false;
  mdvLive.base = text;
  return true;
}

// A Last-Modified time stamp has whole seconds: one taken less than 2 s before the response may name two
// versions saved in the same second, and a conditional request with it could be told "not modified" about the
// second one. Such a response's validators are not sent; the next request asks for the whole file.
function mdvLiveValidators(resp) {
  const etag = resp.headers.get('etag');
  const lastModified = resp.headers.get('last-modified');
  const modified = Date.parse(lastModified || '');
  const now = Date.parse(resp.headers.get('date') || '') || Date.now();
  const settled = Number.isFinite(modified) ? now - modified >= 2000 : !!etag;
  return { etag, lastModified, conditional: settled && !!(etag || lastModified) };
}

// Comment work on the document on screen that is not in its file yet (the comment code's own state, read here)
function mdvCommentWorkUnsaved() {
  try {
    if (typeof mdvDirty !== 'undefined' && mdvDirty) return true;
    if (typeof mdvWritesQueued === 'number' && mdvWritesQueued > 0) return true;
    if (typeof mdvNotices !== 'undefined' && typeof mdvLoadSeq !== 'undefined' &&
        mdvNotices.some((n) => n.loadSeq === mdvLoadSeq && (n.kind === 'conflict' || n.kind === 'error'))) return true;
  } catch (e) {
    return true; // cannot tell: never replace the page under the reader
  }
  return false;
}

// A comment being written: the add-comment box is open (typed into or not), or a reply has text in it
function mdvCommentBeingTyped() {
  if (document.querySelector('.mdv-add-popup')) return true;
  return [...document.querySelectorAll('#mdvSidebar textarea')].some((t) => t.value.trim() !== '');
}

// Unsaved comment work on the document on screen: 'comments', 'typing' or null (see the top of this file)
function mdvLiveUnsavedWork() {
  if (mdvCommentBeingTyped()) return 'typing';
  return mdvCommentWorkUnsaved() ? 'comments' : null;
}

// The comment code's own conflict notice for this document load already offers "Reload from disk"
function mdvLiveCommentsAsking() {
  try {
    return mdvNotices.some((n) => n.kind === 'conflict' && n.loadSeq === mdvLoadSeq);
  } catch (e) {
    return false;
  }
}

async function mdvLiveChanged(target, change) {
  // A comment save is writing the file: what it finds there is the comment code's to settle (it refuses to write over
  // another program's change). The next look sees the file as the save left it.
  if (typeof mdvWritesQueued === 'number' && mdvWritesQueued > 0) {
    mdvLiveClearPending();
    mdvLive.seen = null;
    return;
  }
  mdvLive.pending = { target, change };
  mdvLiveWatchBox(true);
  const unsaved = mdvLiveUnsavedWork();
  if (unsaved === 'typing') { mdvLiveWaitForBox(); return; }
  if (unsaved === 'comments') {
    if (mdvLiveCommentsAsking()) { mdvLiveClearPending(); return; }
    if (mdvLive.deferred !== 'dismissed') mdvLiveShowPrompt();
    mdvLiveUpdateChip();
    return;
  }
  await mdvLiveApply(target, change);
}

// ------- Waiting while a comment is written -------
// While a newer version waits (the question, or the mark), the page's body is watched for the add-comment box coming
// and going; a reply being typed in the sidebar is checked at each look.
let mdvLiveBoxWatch = null;

function mdvLiveWatchBox(on) {
  if (!on) {
    if (mdvLiveBoxWatch) { mdvLiveBoxWatch.disconnect(); mdvLiveBoxWatch = null; }
    return;
  }
  if (mdvLiveBoxWatch || typeof MutationObserver === 'undefined') return;
  mdvLiveBoxWatch = new MutationObserver(mdvLiveBoxChanged);
  mdvLiveBoxWatch.observe(document.body, { childList: true });
}

function mdvLiveBoxChanged() {
  if (!mdvLive.pending) return;
  const typing = mdvLiveUnsavedWork() === 'typing';
  if (mdvLive.deferred === 'typing' && !typing) mdvLiveBoxClosed();
  else if (mdvLive.prompt && typing) mdvLiveWaitForBox(); // a box opened under the question: the question waits for it
}

function mdvLiveWaitForBox() {
  mdvLive.deferred = 'typing';
  mdvLiveHidePrompt();
  mdvLiveUpdateChip();
  mdvLiveWatchBox(true);
}

// The box closed: the waiting version is shown, or asked about when the comment left unsaved work
function mdvLiveBoxClosed() {
  if (mdvLive.deferred === 'typing') mdvLive.deferred = null;
  const pending = mdvLive.pending;
  if (pending) mdvLiveChanged(pending.target, pending.change);
}

// Shows the new version through the load seam, keeping the reader's place, and says where it changed
async function mdvLiveApply(target, change) {
  const shown = mdvShownDocument();
  if (!shown) return false;
  let doc;
  if (target.kind === 'handle') {
    // No text: the seam reads the file through the comment code, which records the version a save compares with
    doc = { name: shown.name, path: shown.path, handle: target.handle, kind: shown.kind, title: shown.title };
  } else {
    doc = Object.assign({}, shown, {
      text: change.text,
      sourceText: change.text,
      mtimeMs: change.doc && Number.isFinite(change.doc.mtimeMs) ? change.doc.mtimeMs : shown.mtimeMs,
    });
  }
  const before = mdvLiveBlockWords();
  const shownNow = await mdvOpenDocument(doc, { push: false });
  if (shownNow) {
    mdvLiveClearPending();
    mdvLiveAnnounce(before);
  }
  return shownNow;
}

function mdvLiveClearPending() {
  mdvLive.pending = null;
  mdvLive.deferred = null;
  mdvLiveWatchBox(false);
  mdvLiveHidePrompt();
  mdvLiveUpdateChip();
}

// Every document shown starts a fresh watch: the next look compares its file with the version now on screen
mdvOnDocumentOpened((event) => {
  const doc = event.doc;
  mdvLive.gen++;
  if (mdvLive.look) { // a look about the document that was replaced
    mdvLive.look.over = true;
    if (mdvLive.look.abort) mdvLive.look.abort();
    mdvLive.look = null;
  }
  mdvLive.key = null;
  mdvLive.seen = null;
  mdvLiveSettled();
  mdvLive.soon = false;
  mdvLive.validators = null;
  mdvLive.failures = 0;
  mdvLive.gone = false;
  mdvLive.base = typeof doc.sourceText === 'string' ? doc.sourceText : doc.text;
  mdvLiveClearPending();
  if (mdvInDesktopApp() && event.kind === 'first' && doc.path) mdvLive.windowFile = doc.path;
  // After Back or Forward, look at once whether the file changed again since it was read
  mdvLiveSchedule(event.kind === 'history' ? 0 : null);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(mdvLive.timer);
    mdvLive.timer = 0;
  } else {
    mdvLiveSchedule(0);
  }
});

// The desktop app's own reload (js/host.js) gets the same note
document.addEventListener('DOMContentLoaded', () => {
  const host = window.mdvHost;
  if (!mdvInDesktopApp() || typeof host.onDocumentChanged !== 'function') return;
  host.onDocumentChanged((doc) => {
    const before = rawMarkdown;
    const blocks = mdvLiveBlockWords();
    // js/host.js shows the new version right after telling its subscribers, unless it asks first
    setTimeout(() => {
      if (doc && typeof doc.text === 'string' && rawMarkdown === doc.text && before !== doc.text) mdvLiveAnnounce(blocks);
    }, 0);
  });
});
