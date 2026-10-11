// ============================================
// Live reload: the document follows its file
// ============================================
// Status reports, plans and handoffs change while they are read. When the file of the document on screen
// changes, the new version is shown where the reader is (the load seam keeps the heading at the top of the
// window in place) and a quiet "Updated" note says so. A document with comment changes that are not in its file
// yet is never replaced under the reader: "Changed on disk: reload?" asks first, and Reload keeps those changes
// in the comments panel (the comment code keeps the text of a document it no longer shows, to download).
//
// Where a change is noticed:
//   - a file opened through the File System Access API (the comment code's handle, mdvFileHandle): its
//     modification time and size, every 1.5 s; the text is read only when one of them moves;
//   - a document from a ?file= link over http: a conditional request (If-None-Match / If-Modified-Since) every 2 s;
//   - the desktop app: the shell watches the window's own file and js/host.js shows each new version (this file
//     only adds the "Updated" note, through mdvHost.onDocumentChanged); a document opened in the window from a
//     link is not watched by the shell, so it is read through the bridge every 2 s.
// Only while the page is visible: a hidden tab costs nothing, and a page that becomes visible again looks at once.
// Nothing is looked at while a comment save is writing the file or another document is being opened. A new
// version is shown only once two looks 300 ms apart agree: a program that saves by emptying the file and then
// writing it would otherwise be caught half-way, and the reader would lose their place to an empty page.
//
// What counts as unsaved comment work is the comment code's own state, read and never written: mdvDirty (a change
// not written yet), mdvWritesQueued (a save in flight), and a conflict or error notice of the document load on
// screen (mdvNotices, mdvLoadSeq); plus a comment being typed in the add-comment box. When the comment code is
// already asking about the file (its conflict notice offers "Reload from disk"), this does not ask again.

const MDV_LIVE_HANDLE_MS = 1500;
const MDV_LIVE_HTTP_MS = 2000;
const MDV_LIVE_DESKTOP_MS = 2000;
// A look that reads the whole file (the desktop bridge; an http server that sends no validators) is made less
// often for a large document; a look that fails (the server is down, the file was removed) waits longer each time
const MDV_LIVE_LARGE = 1000000;
const MDV_LIVE_LARGE_MS = 10000;
const MDV_LIVE_MAX_BACKOFF_MS = 30000;

const mdvLive = {
  timer: 0,
  running: false,
  gen: 0,              // counts documents shown; a look that started before the latest one is dropped
  key: null,           // the source the last look was about
  seen: null,          // its version the last look saw (time and size, a version token, or the text)
  base: null,          // http and desktop: the text of the version on screen, as its source gave it
  validators: null,    // http: {etag, lastModified, conditional}
  failures: 0,         // looks in a row that failed
  windowFile: null,    // desktop: the window's own file, which the shell watches
  checkOnce: false,    // desktop: look at the window's own file once (after Back or Forward returned to it)
  candidate: null,     // a new version seen once; it is shown when the next look, 300 ms later, sees it again
  soon: false,         // the look asked for that next look
  pending: null,       // {target, change} that the prompt asks about
  prompt: null,        // the prompt, while it is shown
};
const MDV_LIVE_SETTLE_MS = 300;

// What to watch for the document on screen: {kind, key, every, …}, or null
function mdvLiveTarget() {
  const shown = mdvShownDocument();
  if (!shown) return null;
  const host = window.mdvHost;
  if (mdvInDesktopApp()) {
    if (shown.kind !== 'desktop' || !shown.path || typeof host.readDocument !== 'function') return null;
    if (mdvLive.windowFile && mdvSamePath(shown.path, mdvLive.windowFile, 'desktop')) {
      return mdvLive.checkOnce ? { kind: 'desktop', key: 'desktop:' + shown.path, path: shown.path, every: 0 } : null;
    }
    return { kind: 'desktop', key: 'desktop:' + shown.path, path: shown.path, every: mdvLiveEvery(MDV_LIVE_DESKTOP_MS, true) };
  }
  const handle = typeof mdvFileHandle !== 'undefined' ? mdvFileHandle : null;
  if (handle && typeof handle.getFile === 'function') return { kind: 'handle', key: handle, handle, every: mdvLiveEvery(MDV_LIVE_HANDLE_MS, false) };
  if (shown.kind === 'http' && shown.path && /^https?:$/.test(location.protocol)) {
    const url = new URL(shown.path, location.href);
    url.hash = '';
    const whole = !(mdvLive.validators && mdvLive.validators.conditional);
    return { kind: 'http', key: 'http:' + url.href, url: url.href, every: mdvLiveEvery(MDV_LIVE_HTTP_MS, whole) };
  }
  return null;
}

// How long until the next look: longer for a large file read whole, and after failed looks
function mdvLiveEvery(ms, readsWholeFile) {
  if (readsWholeFile && typeof mdvLive.base === 'string' && mdvLive.base.length > MDV_LIVE_LARGE) ms = MDV_LIVE_LARGE_MS;
  return mdvLive.failures ? Math.min(MDV_LIVE_MAX_BACKOFF_MS, ms * 2 ** mdvLive.failures) : ms;
}

function mdvLiveSchedule(delay) {
  clearTimeout(mdvLive.timer);
  mdvLive.timer = 0;
  if (document.visibilityState === 'hidden') return;
  const target = mdvLiveTarget();
  if (!target) return;
  const wait = delay != null ? delay : target.every;
  if (wait == null || (wait === 0 && delay == null)) return;
  mdvLive.timer = setTimeout(mdvLiveTick, wait);
}

async function mdvLiveTick() {
  mdvLive.timer = 0;
  if (document.visibilityState === 'hidden' || mdvLive.running) return; // a running look schedules the next one
  const target = mdvLiveTarget();
  if (!target) return;
  const busy = mdvLiveBusy();
  if (!busy) {
    mdvLive.running = true;
    try {
      mdvLive.failures = (await mdvLiveLook(target, mdvLive.gen)) === false ? mdvLive.failures + 1 : 0;
    } catch (e) {
      // A file that is gone, unreadable or half-written keeps the version on screen; the next look, later, tries again
      mdvLive.failures++;
    } finally {
      mdvLive.running = false;
    }
    if (target.every === 0 && !mdvLive.soon) mdvLive.checkOnce = false; // done, unless it saw a version to confirm
  }
  if (mdvLive.prompt && mdvLiveCommentsAsking()) mdvLiveHidePrompt();
  // A new version seen once is looked at again shortly; a one-time look that had to wait tries again
  const soon = mdvLive.soon;
  mdvLive.soon = false;
  if (!mdvLive.timer) mdvLiveSchedule(soon ? MDV_LIVE_SETTLE_MS : busy && target.every === 0 ? 500 : null);
}

// A comment save writing the file, or another document being opened: not a moment to look
function mdvLiveBusy() {
  try {
    if (typeof mdvWritesQueued === 'number' && mdvWritesQueued > 0) return true;
    if (typeof mdvDocumentChanging === 'function' && mdvDocumentChanging()) return true;
  } catch (e) { /* the comment code is not there */ }
  return !!mdvPendingOpen;
}

async function mdvLiveLook(target, gen) {
  const stale = () => gen !== mdvLive.gen;
  if (mdvLive.key !== target.key) {
    mdvLive.key = target.key;
    mdvLive.seen = null;
    mdvLive.candidate = null;
    mdvLive.validators = null;
  }
  if (target.kind === 'handle') {
    const file = await target.handle.getFile();
    if (stale()) return;
    const sig = file.lastModified + ':' + file.size;
    if (mdvLive.seen === sig) return;
    const text = await mdvLiveDecode(file);
    if (stale() || text == null) return;
    if (mdvLiveKnownText(target.handle, text)) { mdvLive.seen = sig; mdvLive.candidate = null; return; }
    if (mdvLiveUnsettled(sig)) return;
    mdvLive.seen = sig;
    await mdvLiveChanged(target, { text });
    return;
  }
  if (target.kind === 'http') {
    const v = mdvLive.validators;
    const headers = {};
    if (v && v.conditional && !mdvLive.candidate) {
      if (v.etag) headers['If-None-Match'] = v.etag;
      if (v.lastModified) headers['If-Modified-Since'] = v.lastModified;
    }
    const resp = await fetch(target.url, { cache: 'no-store', headers });
    if (stale()) return;
    if (resp.status === 304) return;
    if (!resp.ok) return false; // not there right now: the version on screen stays, and the next look waits longer
    const validators = mdvLiveValidators(resp);
    const text = await resp.text();
    if (stale()) return;
    mdvLive.validators = validators;
    if (text === mdvLive.seen) return;
    if (text === mdvLive.base) { mdvLive.seen = text; mdvLive.candidate = null; return; }
    if (mdvLiveUnsettled(text)) return;
    mdvLive.seen = text;
    await mdvLiveChanged(target, { text });
    return;
  }
  if (target.kind === 'desktop') {
    const doc = await window.mdvHost.readDocument(target.path);
    if (stale() || !doc || typeof doc.text !== 'string') return;
    const sig = doc.version || doc.text;
    if (mdvLive.seen === sig) return;
    if (doc.text === mdvLive.base) { mdvLive.seen = sig; mdvLive.candidate = null; return; }
    if (mdvLiveUnsettled(sig)) return;
    mdvLive.seen = sig;
    await mdvLiveChanged(target, { text: doc.text, doc });
  }
}

// True the first time a new version is seen: it is looked at again in 300 ms, and taken only if it is still there
function mdvLiveUnsettled(sig) {
  if (mdvLive.candidate === sig) {
    mdvLive.candidate = null;
    return false;
  }
  mdvLive.candidate = sig;
  mdvLive.soon = true;
  return true;
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

// Unsaved comment work on the document on screen (see the top of this file)
function mdvLiveUnsavedWork() {
  try {
    if (typeof mdvDirty !== 'undefined' && mdvDirty) return 'comments';
    if (typeof mdvWritesQueued === 'number' && mdvWritesQueued > 0) return 'comments';
    if (typeof mdvNotices !== 'undefined' && typeof mdvLoadSeq !== 'undefined' &&
        mdvNotices.some((n) => n.loadSeq === mdvLoadSeq && (n.kind === 'conflict' || n.kind === 'error'))) return 'comments';
  } catch (e) {
    return 'comments'; // cannot tell: never replace the page under the reader
  }
  const box = document.querySelector('.mdv-add-popup textarea');
  return box && box.value.trim() ? 'typing' : null;
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
  const unsaved = mdvLiveUnsavedWork();
  if (unsaved) {
    if (!mdvLiveCommentsAsking()) mdvLiveShowPrompt(target, change, unsaved);
    return;
  }
  await mdvLiveApply(target, change);
}

// Shows the new version through the load seam, keeping the reader's place
async function mdvLiveApply(target, change) {
  mdvLiveHidePrompt();
  const shown = mdvShownDocument();
  if (!shown) return false;
  let doc;
  if (target.kind === 'handle') {
    // No text: the seam reads the file through the comment code, which records the version a save compares with
    doc = { name: shown.name, path: shown.path, handle: target.handle, kind: shown.kind, title: shown.title };
  } else {
    doc = Object.assign({}, shown, {
      text: change.text,
      fetchedText: target.kind === 'http' ? change.text : shown.fetchedText,
      mtimeMs: change.doc && Number.isFinite(change.doc.mtimeMs) ? change.doc.mtimeMs : shown.mtimeMs,
    });
  }
  const shownNow = await mdvOpenDocument(doc, { push: false });
  if (shownNow) mdvLiveToast('Updated');
  return shownNow;
}

// Every document shown starts a fresh watch: the next look compares its file with the version now on screen
mdvOnDocumentOpened((event) => {
  const doc = event.doc;
  mdvLive.gen++;
  mdvLive.key = null;
  mdvLive.seen = null;
  mdvLive.candidate = null;
  mdvLive.soon = false;
  mdvLive.validators = null;
  mdvLive.failures = 0;
  mdvLive.base = typeof doc.fetchedText === 'string' ? doc.fetchedText : doc.text;
  mdvLiveHidePrompt();
  if (mdvInDesktopApp() && event.kind === 'first' && doc.path) mdvLive.windowFile = doc.path;
  // Back or Forward to the window's own file: the shell sent its changes while another document was shown
  mdvLive.checkOnce = mdvInDesktopApp() && event.kind === 'history' && !!mdvLive.windowFile && mdvSamePath(doc.path, mdvLive.windowFile, 'desktop');
  // After Back or Forward, look at once whether the file changed while the reader was away
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

// The desktop app's own reload (js/host.js) gets the same quiet note
document.addEventListener('DOMContentLoaded', () => {
  const host = window.mdvHost;
  if (!mdvInDesktopApp() || typeof host.onDocumentChanged !== 'function') return;
  host.onDocumentChanged((doc) => {
    const before = rawMarkdown;
    // js/host.js shows the new version right after telling its subscribers, unless it asks first
    setTimeout(() => {
      if (doc && typeof doc.text === 'string' && rawMarkdown === doc.text && before !== doc.text) mdvLiveToast('Updated');
    }, 0);
  });
});

// ------- The quiet note and the question -------
const MDV_LIVE_ICON = 'M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5';

function mdvLiveIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', MDV_LIVE_ICON);
  svg.appendChild(path);
  return svg;
}

let mdvLiveToastTimer = 0;
function mdvLiveToast(text) {
  let el = document.getElementById('mdvLiveToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mdvLiveToast';
    el.className = 'mdv-live-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.replaceChildren(mdvLiveIcon(), document.createTextNode(text));
  el.classList.add('show');
  clearTimeout(mdvLiveToastTimer);
  mdvLiveToastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function mdvLiveShowPrompt(target, change, unsaved) {
  mdvLive.pending = { target, change };
  let el = document.getElementById('mdvLivePrompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mdvLivePrompt';
    el.className = 'mdv-live-prompt';
    el.setAttribute('role', 'alert');
    const text = document.createElement('div');
    text.className = 'mdv-live-prompt-text';
    const title = document.createElement('strong');
    title.className = 'mdv-live-prompt-title';
    title.textContent = 'Changed on disk: reload?';
    const detail = document.createElement('span');
    detail.className = 'mdv-live-prompt-detail';
    text.append(title, detail);
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'mdv-live-btn mdv-live-btn-primary';
    reload.dataset.action = 'live-reload';
    reload.textContent = 'Reload';
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'mdv-live-btn';
    later.dataset.action = 'live-dismiss';
    later.textContent = 'Not now';
    el.append(mdvLiveIcon(), text, reload, later);
    document.body.appendChild(el);
  }
  const shown = mdvShownDocument();
  const name = shown ? shown.name : 'The document';
  el.querySelector('.mdv-live-prompt-detail').textContent = unsaved === 'typing'
    ? `${name} has a newer version. The comment you are typing stays in its box.`
    : `${name} has a newer version. Your comment changes that are not saved yet stay in the comments panel.`;
  el.hidden = false;
  mdvLive.prompt = el;
  requestAnimationFrame(() => el.classList.add('show'));
}

function mdvLiveHidePrompt() {
  mdvLive.pending = null;
  const el = mdvLive.prompt || document.getElementById('mdvLivePrompt');
  mdvLive.prompt = null;
  if (!el) return;
  el.classList.remove('show');
  el.hidden = true;
}

mdvRegisterActions({
  'live-reload': {
    click: () => {
      const pending = mdvLive.pending;
      if (pending) mdvLiveApply(pending.target, pending.change);
      else mdvLiveHidePrompt();
    },
  },
  // The next version that arrives asks again
  'live-dismiss': { click: () => mdvLiveHidePrompt() },
});
