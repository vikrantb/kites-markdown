// ============================================
// Links between documents: they open in the viewer
// ============================================
// A relative link to a Markdown file opens inside the viewer, through the load seam (mdvOpenDocument), as a new place
// in Back/Forward (js/history.js):
//   a folder is open (window.mdvFolder)   mdvFolder.resolve, then mdvFolder.read
//   the desktop app                       mdvHost.readDocument, in the same window (Cmd/Ctrl-click opens it in a window
//                                         of its own: js/host.js)
//   a page served over http(s)            fetch, relative to the document's own address
//   otherwise (a file:// page)            the browser's own behaviour
// A link to the document on screen with a #fragment goes there, as an in-document link does. The new document opens
// at its top (or its #fragment) with the focus there; Back returns the focus to the link.
//
// Over http(s) each such link carries the viewer's own address for its file (markdown-viewer.html?file=…), so every
// gesture the browser offers opens the viewer: a middle click, "Open link in new tab", "Copy link address", and the
// address the status bar shows. The link as the document wrote it is kept aside (mdvLinkHref); the document's HTML
// itself is never trusted to say it.

const MDV_MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;
const mdvWrittenHref = new WeakMap(); // a link whose href now holds the viewer's address → the href the document wrote

// The link's href as the document wrote it
function mdvLinkHref(a) { return mdvWrittenHref.has(a) ? mdvWrittenHref.get(a) : a.getAttribute('href'); }

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
  return mdvHttpPlan(link, shown);
}

// Over http(s): the file the link names on this server, relative to the document's own address
function mdvHttpPlan(link, shown) {
  if (!/^https?:$/.test(location.protocol)) return null;
  const base = shown && shown.kind === 'http' && shown.path ? new URL(shown.path, location.href) : new URL(location.href);
  let url;
  try { url = new URL(link.href, base); } catch (e) { return null; }
  if (url.origin !== location.origin) return null;
  url.hash = '';
  const path = mdvPagePath(url);
  const same = !!shown && shown.kind === 'http' && mdvSamePath(path, shown.path, 'http');
  return { kind: 'http', path, url, same, read: () => mdvFetchDocument(url, path, MDV_HISTORY_READ_MS) };
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

// Fetches a document over http, giving up after `ms`
async function mdvFetchDocument(url, path, ms) {
  const controller = ms > 0 && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ms) : 0;
  try {
    const resp = await fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined });
    if (!resp.ok) throw new Error(resp.status === 404 ? 'it was not found' : 'the server answered ' + resp.status);
    const text = await resp.text();
    return { name: mdvBaseName(url.pathname), text, path, kind: 'http' };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('the server did not answer');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// A document the desktop bridge read: {path, name, text, mtimeMs, version, …}
function mdvFromDesktop(d) {
  if (!d || typeof d.text !== 'string') throw new Error('it could not be read');
  return { name: d.name, text: d.text, path: d.path, mtimeMs: d.mtimeMs, kind: 'desktop' };
}

// A link of the document on screen, named so it can be found again after the page is drawn again: its href as written,
// and its rank among the links with that href
function mdvLinkKey(a) {
  const href = mdvLinkHref(a);
  const body = document.getElementById('mdBody');
  const same = body ? [...body.querySelectorAll('a[href]')].filter((x) => mdvLinkHref(x) === href) : [];
  return { href, nth: Math.max(0, same.indexOf(a)) };
}

function mdvFindLink(key) {
  const body = document.getElementById('mdBody');
  if (!body || !key || typeof key.href !== 'string') return null;
  const same = [...body.querySelectorAll('a[href]')].filter((x) => mdvLinkHref(x) === key.href);
  return same[Math.min(key.nth || 0, same.length - 1)] || null;
}

async function mdvFollowPlan(plan, link, a) {
  if (plan.same) {
    mdvGoToFragment(link.fragment);
    return;
  }
  // Counts from the click, before the file is read: an open the reader asks for meanwhile (Back, the sidebar) wins
  const open = mdvBeginOpen();
  let doc = null;
  try {
    doc = await plan.read();
  } catch (e) {
    if (open.current()) mdvHistoryProblem(mdvBaseName(link.path), (e && (e.message || e.code)) || 'it could not be read');
    return;
  }
  if (!open.current()) return; // the reader went somewhere else meanwhile
  if (!doc || (typeof doc.text !== 'string' && !doc.handle)) {
    mdvHistoryProblem(mdvBaseName(link.path), 'it could not be read');
    return;
  }
  // Back returns the focus to this link (js/history.js keeps it with the document being left)
  mdvHistory.leaving = a && a.closest('#mdBody') ? mdvLinkKey(a) : a ? { href: mdvLinkHref(a), nth: 0 } : null;
  const shown = await mdvOpenDocument(doc, { push: true, fragment: link.fragment || null, begun: open });
  mdvHistory.leaving = null;
  if (!shown) {
    if (open.current()) mdvHistoryProblem(doc.name || mdvBaseName(link.path), 'it could not be shown');
    return;
  }
  // The keyboard goes on from the new document's start (a #fragment has the focus already)
  if (!link.fragment) {
    const body = document.getElementById('mdBody');
    const start = body && (body.querySelector('h1, h2, h3, h4, h5, h6') || body);
    if (start && typeof mdvFocusInDocument === 'function') mdvFocusInDocument(start);
  }
}

// A link to the document on screen: to its #fragment, as an in-document link goes (js/links.js)
function mdvGoToFragment(fragment) {
  if (!fragment) return;
  const target = typeof mdvLinkTarget === 'function' ? mdvLinkTarget('#' + fragment) : null;
  if (!target) return;
  if (location.hash !== '#' + fragment) mdvHistoryPushPlace('#' + fragment);
  mdvGoTo(target);
}

// Over http, the viewer's own address for a linked file (the browser would show the file's raw text). A document of
// the open folder has none: its links are read through the folder, which a new tab does not have.
function mdvViewerAddressFor(link) {
  if (mdvInDesktopApp()) return null;
  const shown = mdvShownDocument();
  const folder = window.mdvFolder;
  if (folder && folder.kind && (!shown || shown.kind !== 'http')) return null;
  const plan = mdvHttpPlan(link, shown);
  if (!plan) return null;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('file', plan.path);
  url.hash = link.fragment ? '#' + link.fragment : '';
  return url.href;
}

// Each render: the document's links to Markdown files (and the links panel's) carry the viewer's address for them
function mdvPointLinksAtTheViewer() {
  if (!/^https?:$/.test(location.protocol) || mdvInDesktopApp()) return;
  for (const a of document.querySelectorAll('#mdBody a[href], #linksPanelContent a[href]')) {
    if (mdvWrittenHref.has(a)) continue;
    const written = a.getAttribute('href');
    const link = mdvMarkdownLink(written);
    const address = link ? mdvViewerAddressFor(link) : null;
    if (!address) continue;
    mdvWrittenHref.set(a, written);
    a.setAttribute('href', address);
  }
}
mdvOnDocumentDrawn(mdvPointLinksAtTheViewer);

// In the capture phase on window: before js/host.js, which would open the file in a window of its own, and before
// the page's other click listeners
window.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const inPanel = !a.closest('#mdBody') && !!a.closest('#linksPanelContent');
  if (!inPanel && !a.closest('#mdBody')) return;
  const link = mdvMarkdownLink(mdvLinkHref(a));
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
  mdvFollowPlan(plan, link, a);
}, true);
