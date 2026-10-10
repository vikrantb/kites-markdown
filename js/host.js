// ============================================
// Host bridge: the desktop app, or the browser
// ============================================
// window.mdvHost is the only contract between the viewer and the desktop shell (docs/desktop.md).
//
// In a browser, kind is 'browser', every method is a no-op that returns null, and nothing else here
// runs: the viewer behaves exactly as before.
//
// In the desktop app (Tauri), the window's document comes from the shell, which also saves it, follows
// its links and watches it for changes. This script:
//   - renders the window's document at start, and live-reloads it when another program changes it,
//     keeping the reading position;
//   - follows links: Markdown files open in their own window, web and mail links in the default app,
//     and the page itself never navigates away;
//   - shows images with relative paths, through the asset protocol;
//   - routes the Open button to the native Open panel, and keeps every other way of loading a
//     different document (paste, File System Access) from linking it to this window's file.
//
// It is loaded last, after comments.js, because it wraps the final renderMarkdown. So window.mdvHost
// exists from DOMContentLoaded on: check it when you use it, never while the scripts load.
(function () {
  'use strict';

  const MARKDOWN = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;
  const tauri = window.__TAURI_INTERNALS__ && window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__ : null;

  if (!tauri) {
    const none = () => Promise.resolve(null);
    window.mdvHost = {
      kind: 'browser',
      currentPath: null,
      currentMtimeMs: null,
      initialDocument: none,
      readDocument: none,
      saveDocument: none,
      openPath: none,
      openExternal: none,
      openDialog: none,
      resourceUrl: () => null,
      makeDefault: none,
      onDocumentChanged: () => () => {},
      selfTestRequested: none,
      reportSelfTest: none,
      resolvePath: () => null,
      reloadFromDisk: none,
    };
    return;
  }

  // ---------------------------------------------------------------
  // Paths. Documents may be POSIX (/home/reader/notes.md) or Windows (C:\notes\a.md, \\server\share\a.md).
  // ---------------------------------------------------------------
  const isWindowsPath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);

  function normalizeSegments(parts) {
    const out = [];
    for (const s of parts) {
      if (!s || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return out;
  }

  function splitWindows(p) {
    const s = p.replace(/\//g, '\\');
    if (/^[a-zA-Z]:\\/.test(s)) return { root: s.slice(0, 3), rest: s.slice(3) };
    if (s.startsWith('\\\\')) {
      const parts = s.slice(2).split('\\');
      return { root: '\\\\' + parts.slice(0, 2).join('\\') + '\\', rest: parts.slice(2).join('\\') };
    }
    return null;
  }

  // Resolves `target` (relative or absolute) against the folder of `base`, a document's path.
  function resolvePath(target, base) {
    if (!target) return null;
    base = base === undefined ? host.currentPath : base;
    const windows = base ? isWindowsPath(base) : isWindowsPath(target);
    if (windows) {
      const absolute = splitWindows(target);
      if (absolute) return absolute.root + normalizeSegments(absolute.rest.split('\\')).join('\\');
      const b = base && splitWindows(base);
      if (!b) return null;
      const rel = target.replace(/\//g, '\\');
      if (rel.startsWith('\\')) return b.root + normalizeSegments(rel.split('\\')).join('\\');
      const folder = b.rest.split('\\').slice(0, -1);
      return b.root + normalizeSegments(folder.concat(rel.split('\\'))).join('\\');
    }
    if (target.startsWith('/')) return '/' + normalizeSegments(target.split('/')).join('/');
    if (!base) return null;
    const folder = base.split('/').slice(0, -1);
    return '/' + normalizeSegments(folder.concat(target.split('/'))).join('/');
  }

  const caseInsensitive = /Mac|Win/i.test(navigator.platform || navigator.userAgent || '');
  const samePath = (a, b) => !!a && !!b && (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  const baseName = (p) => String(p).split(/[\\/]/).pop();

  // What a link or image source points at.
  function classify(raw) {
    const href = String(raw == null ? '' : raw).trim();
    if (!href) return { kind: 'none' };
    if (href.startsWith('#')) return { kind: 'anchor', fragment: href.slice(1) };
    if (isWindowsPath(href)) return Object.assign({ kind: 'local' }, splitLocal(href, false));
    if (href.startsWith('//')) return { kind: 'external', url: 'https:' + href };
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
    if (scheme) {
      const name = scheme[1].toLowerCase();
      if (name === 'http' || name === 'https' || name === 'mailto') return { kind: 'external', url: href };
      if (name === 'file') {
        const local = fileUrlToPath(href);
        return local ? Object.assign({ kind: 'local' }, local) : { kind: 'refused', scheme: name };
      }
      return { kind: 'refused', scheme: name };
    }
    return Object.assign({ kind: 'local' }, splitLocal(href, true));
  }

  function splitLocal(href, encoded) {
    let path = href;
    let fragment = '';
    const hash = path.indexOf('#');
    if (hash >= 0) { fragment = path.slice(hash + 1); path = path.slice(0, hash); }
    const query = path.indexOf('?');
    if (query >= 0) path = path.slice(0, query);
    if (encoded) {
      try { path = decodeURIComponent(path); } catch (_) { /* keep it as written */ }
    }
    return { path, fragment };
  }

  function fileUrlToPath(href) {
    try {
      const u = new URL(href);
      let path = decodeURIComponent(u.pathname);
      if (u.host) path = '\\\\' + u.host + path.replace(/\//g, '\\');
      else if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
      return { path, fragment: u.hash ? u.hash.slice(1) : '' };
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------
  // The bridge
  // ---------------------------------------------------------------
  const internals = window.__TAURI_INTERNALS__;
  const label = (internals.metadata && internals.metadata.currentWebview && internals.metadata.currentWebview.label) || null;
  const call = (command, args) => tauri.core.invoke(command, args || {});
  // Only this window's events: the shell addresses each event to one window.
  const listen = (event, handler) => tauri.event.listen(event, (e) => handler(e.payload), label ? { target: label } : undefined);
  const errorText = (e) => (e && (e.message || e.code)) || String(e);

  const subscribers = new Set();
  let savesInFlight = 0;
  let pendingChange = null;
  let documentName = '';

  const host = {
    kind: 'desktop',
    currentPath: null,
    currentMtimeMs: null,

    initialDocument: () => call('mdv_initial_document'),

    // Rejects with {code, message} for a missing or non-Markdown file.
    readDocument: (path) => call('mdv_read_document', { path }),

    // Never rejects: {ok:true, mtimeMs} or {ok:false, reason:'conflict'|'not-allowed'|'io', currentMtimeMs?, message}.
    async saveDocument(path, text, expectedMtimeMs) {
      savesInFlight++;
      try {
        const result = await call('mdv_save_document', { path, text, expectedMtimeMs });
        if (result && result.ok && samePath(path, host.currentPath)) host.currentMtimeMs = result.mtimeMs;
        return result;
      } catch (e) {
        return { ok: false, reason: 'io', message: errorText(e) };
      } finally {
        savesInFlight--;
      }
    },

    async openDialog() {
      try { await call('mdv_open_dialog'); } catch (e) { notice(errorText(e), 'error'); }
    },

    async openPath(path) {
      try {
        await call('mdv_open_path', { path });
        return { ok: true };
      } catch (e) {
        notice(errorText(e), 'error');
        return { ok: false, message: errorText(e) };
      }
    },

    async openExternal(url) {
      try {
        await call('mdv_open_external', { url });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: errorText(e) };
      }
    },

    resourceUrl: (absPath) => tauri.core.convertFileSrc(absPath),

    makeDefault: () => call('mdv_make_default').catch((e) => ({ ok: false, message: errorText(e) })),

    // cb({path, text, mtimeMs}) after another program changes this window's file. Returns an unsubscribe.
    onDocumentChanged(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },

    selfTestRequested: () => call('mdv_self_test_requested').catch(() => false),
    reportSelfTest: (stats) => call('mdv_self_test_report', { stats }),

    // Resolves a path written in the document (relative to its folder) to an absolute one.
    resolvePath: (target) => resolvePath(target),

    // Re-reads this window's file and re-renders it, keeping the reading position.
    async reloadFromDisk() {
      if (!host.currentPath) return null;
      const doc = await host.readDocument(host.currentPath);
      applyChange(doc);
      return doc;
    },
  };
  window.mdvHost = host;

  // ---------------------------------------------------------------
  // Showing a document
  // ---------------------------------------------------------------
  function showDocument(doc, keepPosition) {
    const anchor = keepPosition ? captureReadingPosition() : null;
    host.currentPath = doc.path;
    host.currentMtimeMs = doc.mtimeMs;
    documentName = doc.name;
    // The window's document is the file the shell read; no File System Access handle belongs to it.
    if (typeof mdvFileHandle !== 'undefined') mdvFileHandle = null;
    rawMarkdown = doc.text;
    currentFileName = doc.name;
    renderMarkdown(doc.text, doc.name);
    document.title = doc.name;
    if (anchor) restoreReadingPosition(anchor);
    if (doc.readOnly && !keepPosition) notice(doc.readOnly);
  }

  function hasUnsavedWork() {
    return savesInFlight > 0 || (typeof mdvSaveTimer !== 'undefined' && !!mdvSaveTimer);
  }

  function onDocumentChanged(doc) {
    if (!doc || !samePath(doc.path, host.currentPath)) return;
    for (const cb of subscribers) {
      try { cb({ path: doc.path, text: doc.text, mtimeMs: doc.mtimeMs }); } catch (e) { console.warn('onDocumentChanged:', e); }
    }
    const asked = doc.reason === 'reload';
    if (!asked && doc.text === rawMarkdown) {
      host.currentMtimeMs = doc.mtimeMs; // only the time moved (a touch, or a save of identical text)
      return;
    }
    if (!asked && hasUnsavedWork()) {
      // A comment is about to be saved. Its save will be refused as a conflict, never written over the
      // other program's change; the person decides when to load the new version.
      pendingChange = doc;
      notice(`${documentName} changed on disk.`, 'info', { label: 'Reload', run: () => applyChange(pendingChange) }, true);
      return;
    }
    applyChange(doc);
  }

  function applyChange(doc) {
    if (!doc) return;
    pendingChange = null;
    dismissNotice('sticky');
    showDocument(doc, true);
  }

  function onDocumentOpened(doc) {
    if (!doc || (host.currentPath && !samePath(doc.path, host.currentPath))) return;
    if (host.currentPath && doc.mtimeMs === host.currentMtimeMs) return; // already showing it
    showDocument(doc, false);
  }

  // The reading position, by the heading at the top of the window (or by proportion when there is none).
  function captureReadingPosition() {
    const body = document.getElementById('mdBody');
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const position = { ratio: max > 0 ? window.scrollY / max : 0, atTop: window.scrollY < 4, id: null, offset: 0 };
    if (!body) return position;
    const toolbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-height')) || 52;
    let chosen = null;
    for (const h of body.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')) {
      if (h.getBoundingClientRect().top <= toolbar + 8) chosen = h;
      else break;
    }
    if (chosen) { position.id = chosen.id; position.offset = chosen.getBoundingClientRect().top; }
    return position;
  }

  let stopRestoring = () => {};

  function restoreReadingPosition(position) {
    stopRestoring();
    const place = () => {
      if (position.atTop) { window.scrollTo({ top: 0, behavior: 'instant' }); return; }
      const el = position.id && document.getElementById(position.id);
      if (el) {
        window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - position.offset, behavior: 'instant' });
      } else {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ top: Math.max(0, position.ratio * max), behavior: 'instant' });
      }
    };
    place();
    // Diagrams and images change the layout after the first paint: hold the position until they settle
    // or the person scrolls.
    const body = document.getElementById('mdBody');
    if (!body || typeof ResizeObserver === 'undefined') return;
    const inputs = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    let done = false;
    let timer = 0;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer.disconnect();
      for (const t of inputs) window.removeEventListener(t, stop, true);
    };
    const observer = new ResizeObserver(() => { if (!done) place(); });
    observer.observe(body);
    for (const t of inputs) window.addEventListener(t, stop, true);
    timer = setTimeout(stop, 2500);
    stopRestoring = stop;
  }

  // ---------------------------------------------------------------
  // After every render: relative images load through the asset protocol
  // ---------------------------------------------------------------
  function rewriteImages() {
    const body = document.getElementById('mdBody');
    if (!body) return;
    for (const img of body.querySelectorAll('img[src]')) {
      if (img.dataset.mdvSrc) continue;
      const src = img.getAttribute('src');
      const target = classify(src);
      if (target.kind === 'external' && src.startsWith('//')) { img.setAttribute('src', target.url); continue; }
      if (target.kind !== 'local' || !target.path) continue;
      const abs = resolvePath(target.path);
      if (!abs) continue;
      img.dataset.mdvSrc = src;
      img.setAttribute('src', host.resourceUrl(abs));
    }
  }

  // A link card shows where its link goes. For a file next to the document that is the path as
  // written, not the app's internal page address.
  function labelFileLinkCards() {
    const body = document.getElementById('mdBody');
    if (!body) return;
    for (const card of body.querySelectorAll('a.link-chip')) {
      const target = classify(card.getAttribute('href'));
      const url = card.querySelector('.link-chip-url');
      if (target.kind === 'local' && target.path && url) url.textContent = target.path;
    }
  }

  function wrapRenderMarkdown() {
    const inner = window.renderMarkdown;
    if (typeof inner !== 'function' || inner.mdvHostWrapped) return;
    const wrapped = function (source, title) {
      const result = inner.apply(this, arguments);
      try { rewriteImages(); } catch (e) { console.warn('host: images', e); }
      try { labelFileLinkCards(); } catch (e) { console.warn('host: link cards', e); }
      return result;
    };
    wrapped.mdvHostWrapped = true;
    window.renderMarkdown = wrapped;
  }

  // ---------------------------------------------------------------
  // Links: the page never navigates away
  // ---------------------------------------------------------------
  function scrollToFragment(fragment) {
    let id = fragment;
    try { id = decodeURIComponent(fragment); } catch (_) { /* as written */ }
    const el = document.getElementById(id) || document.getElementsByName(id)[0];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function follow(link) {
    if (link.kind === 'anchor') { scrollToFragment(link.fragment); return; }
    if (link.kind === 'external') {
      host.openExternal(link.url).then((r) => { if (!r.ok) notice(r.message, 'error'); });
      return;
    }
    if (link.kind === 'refused') { notice(`${link.scheme}: links are not opened from documents.`); return; }
    if (link.kind !== 'local') return;
    if (!link.path) { if (link.fragment) scrollToFragment(link.fragment); return; }
    const abs = resolvePath(link.path);
    if (!abs) { notice('This document has no folder, so its relative links cannot be followed.'); return; }
    if (!MARKDOWN.test(abs)) {
      notice(`Kites Markdown opens only Markdown files, so ${baseName(abs)} was not opened.`);
      return;
    }
    if (samePath(abs, host.currentPath)) { if (link.fragment) scrollToFragment(link.fragment); return; }
    host.openPath(abs);
  }

  function onActivate(e) {
    const target = e.target;
    // The Open button and Ctrl/Cmd+O click the hidden file input. The native Open panel replaces it,
    // because it knows the file's path (needed to save, live-reload and show relative images).
    if (e.type === 'click' && target && target.id === 'fileInput') {
      e.preventDefault();
      host.openDialog();
      return;
    }
    const a = target && target.closest ? target.closest('a[href]') : null;
    if (!a) return;
    if (e.type === 'auxclick' && e.button !== 1) return;
    const link = classify(a.getAttribute('href'));
    const plain = e.type === 'click' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    if (link.kind === 'anchor' && plain) return; // an in-page jump: the viewer and the page handle it
    e.preventDefault();
    if (e.type === 'auxclick' && link.kind === 'anchor') return;
    follow(link);
  }

  // ---------------------------------------------------------------
  // Notices: a small message at the bottom of the window
  // ---------------------------------------------------------------
  let noticeBox = null;

  function notice(message, kind, action, sticky) {
    if (!message) return;
    if (!noticeBox) {
      noticeBox = document.createElement('div');
      noticeBox.id = 'mdvHostNotices';
      noticeBox.setAttribute('role', 'status');
      noticeBox.setAttribute('aria-live', 'polite');
      Object.assign(noticeBox.style, {
        position: 'fixed', left: '50%', bottom: 'calc(var(--tts-height, 0px) + 22px)', transform: 'translateX(-50%)',
        zIndex: '10000', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
        maxWidth: 'min(640px, calc(100vw - 32px))', pointerEvents: 'none',
      });
      document.body.appendChild(noticeBox);
    }
    if (sticky) dismissNotice('sticky');
    const item = document.createElement('div');
    item.dataset.kind = sticky ? 'sticky' : 'transient';
    Object.assign(item.style, {
      display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderRadius: '10px',
      background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #222)',
      border: `1px solid ${kind === 'error' ? 'var(--accent-danger, #b85450)' : 'var(--border-primary, #ddd)'}`,
      boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,.18))', font: '500 13px/1.45 var(--font-ui, system-ui, sans-serif)',
      pointerEvents: 'auto', opacity: '0', transition: 'opacity 160ms ease',
    });
    const text = document.createElement('span');
    text.textContent = message;
    item.appendChild(text);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      Object.assign(button.style, {
        font: 'inherit', fontWeight: '600', padding: '5px 12px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid var(--accent, #6b8f71)', background: 'var(--accent, #6b8f71)', color: 'var(--text-inverse, #fff)',
      });
      button.addEventListener('click', () => { item.remove(); action.run(); });
      item.appendChild(button);
    }
    noticeBox.appendChild(item);
    requestAnimationFrame(() => { item.style.opacity = '1'; });
    if (!sticky) setTimeout(() => { item.style.opacity = '0'; setTimeout(() => item.remove(), 200); }, 5200);
  }

  function dismissNotice(kind) {
    if (!noticeBox) return;
    for (const item of noticeBox.querySelectorAll(`[data-kind="${kind}"]`)) item.remove();
  }

  // ---------------------------------------------------------------
  // The page in the app
  // ---------------------------------------------------------------
  function adaptPage() {
    // File System Access is how the browser build saves. In the app the shell saves the window's own
    // file, so the browser-only buttons go, and the pickers are removed so no code path can link this
    // window to a different file than the one it shows.
    for (const id of ['mdvOpenBtn', 'mdvWorkspaceBtn']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
      try { delete Window.prototype[name]; delete window[name]; } catch (_) { /* not present */ }
    }

    // The app's name where the browser build says "Markdown Viewer", until a document replaces it.
    const title = document.getElementById('titleText');
    if (title && !host.currentPath) title.textContent = 'Kites Markdown';
    document.title = 'Kites Markdown';
    // On a Mac the shortcuts are Command-based (the viewer accepts Ctrl or Cmd), so say so.
    if (/Mac/i.test(navigator.platform || '')) {
      for (const kbd of document.querySelectorAll('.paste-hint kbd, #shortcutsOverlay kbd')) {
        if (kbd.textContent.trim() === 'Ctrl') kbd.textContent = '⌘';
      }
    }

    const zone = document.getElementById('dropZone');
    if (!zone) return;
    const sub = zone.querySelector('.drop-zone-sub');
    if (sub) sub.textContent = 'Drag a Markdown file here, or choose one.';
    const open = zone.querySelector('.drop-btn');
    if (open) {
      for (const node of open.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) node.textContent = ' Open a file… ';
      }
    }
    if (!document.getElementById('mdvDefaultApp')) {
      const offer = document.createElement('div');
      offer.id = 'mdvDefaultApp';
      Object.assign(offer.style, { marginTop: '22px', paddingTop: '18px', borderTop: '1px solid var(--border-secondary, #eee)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' });
      const line = document.createElement('div');
      line.className = 'paste-hint';
      line.textContent = 'Open every .md file here with a double-click.';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = 'Make Kites Markdown the default';
      button.addEventListener('click', async (e) => {
        e.stopPropagation();
        button.disabled = true;
        const result = await host.makeDefault();
        button.disabled = false;
        if (result) notice(result.message, result.ok ? 'info' : 'error');
      });
      offer.appendChild(line);
      offer.appendChild(button);
      zone.appendChild(offer);
    }
  }

  function guardDocumentReplacement() {
    // A paste outside a text field replaces the document in the browser build. Here that would show
    // text this window's file does not contain, so it is allowed only in an empty window.
    window.addEventListener('paste', (e) => {
      if (!host.currentPath) return;
      const t = e.target;
      if (t && (t.isContentEditable || (t.closest && t.closest('input, textarea, select')))) return;
      e.stopImmediatePropagation();
      notice(`This window shows ${documentName}. To read pasted Markdown, open a new window (File → New Window) and paste there.`);
    }, true);
    // Files dropped on the window are opened by the shell, which knows their paths.
    window.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  function showDragging(on) {
    const zone = document.getElementById('dropZone');
    if (zone) zone.classList.toggle('drag-over', on);
  }

  async function boot() {
    adaptPage();
    guardDocumentReplacement();
    document.addEventListener('click', onActivate, true);
    document.addEventListener('auxclick', onActivate, true);
    wrapRenderMarkdown();
    // Listen before asking for the document: a document the shell hands over in between arrives as an
    // event, one handed over before is returned by initialDocument.
    await Promise.all([
      listen('mdv://document-changed', onDocumentChanged),
      listen('mdv://open-document', onDocumentOpened),
      listen('mdv://notice', (p) => notice(p && p.message)),
      listen('tauri://drag-enter', () => showDragging(true)),
      listen('tauri://drag-leave', () => showDragging(false)),
      listen('tauri://drag-drop', () => showDragging(false)),
    ]);
    const doc = await host.initialDocument();
    if (doc && !host.currentPath) showDocument(doc, false);
  }

  const start = () => boot().catch((e) => console.error('Kites Markdown could not start:', e));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
