// ============================================
// The rendered document, and copies of it
// ============================================
// What Export HTML (js/export.js), Copy as rich text (js/copy.js) and links to sections (js/section-links.js) share:
// - mdvOnRender: callbacks after every render, however it was started;
// - mdvDocumentAddress: the page's address and the document's file, while the address names the document on screen;
// - mdvSnapshot / mdvCleanSnapshot: a copy of the document as the reader sees it (#mdBody after every render pass:
//   diagrams drawn, math typeset), or of the part a selection covers, without the viewer's own controls and data;
// - mdvInlineImages: local images in such a copy as data: URIs, and a visible note for any that cannot be read;
// - mdvResolveLinks: the copy's links, made to work where the copy goes.
// Nothing here renders anything again: a copy is made of what is on screen.

const MDV_SVG_NS = 'http://www.w3.org/2000/svg';
const MDV_XHTML_NS = 'http://www.w3.org/1999/xhtml';

// ---------- After each render ----------
// renderMarkdown replaces #mdBody's children, and only a render changes them (the passes that follow it add their
// wrappers in the same task), so one observer of the children runs these callbacks once per render, after it
// returns, whoever started it: a load, a reload, a comment change.
const mdvRenderHooks = [];
function mdvOnRender(fn) { mdvRenderHooks.push(fn); }

(function mdvWatchRenders() {
  const body = document.getElementById('mdBody');
  if (!body || typeof MutationObserver !== 'function') return;
  new MutationObserver(() => {
    if (!body.childElementCount) return;
    for (const fn of mdvRenderHooks) {
      try { fn(body); } catch (e) { console.warn('after render:', e); }
    }
  }).observe(body, { childList: true });
})();

function mdvHasDocument() {
  const body = document.getElementById('mdBody');
  return !!body && body.style.display !== 'none' && body.childElementCount > 0;
}

function mdvToast(message, kind) {
  if (typeof mdvShowToast === 'function') mdvShowToast(message, kind);
  else console.log(message);
}

// ---------- Names ----------
// The document's title: its first h1 (else its first heading), as the outline names it; else the file name.
function mdvExportTitle() {
  const body = document.getElementById('mdBody');
  const h = body && (body.querySelector('h1') || body.querySelector('h2, h3, h4, h5, h6'));
  const words = h ? mdvHeadingText(h) : '';
  if (words) return words;
  const name = (document.getElementById('titleText') || {}).textContent || '';
  return name.trim() || 'Document';
}

// The document as the toolbar names it: the title it was rendered with (js/comments.js keeps it for each document),
// which is its ?file= path when the address loaded it; '' for text with no file (pasted, the demo). In the desktop
// app, the window's file name. (currentFileName is not this: a paste leaves the previous file's name in it.)
function mdvDocumentLabel() {
  const host = window.mdvHost;
  if (host && host.kind === 'desktop' && host.currentPath) return String(host.currentPath).split(/[\\/]/).pop();
  if (typeof mdvDocTitle === 'string') {
    const hasFile = typeof mdvDocHasFile === 'function' ? mdvDocHasFile() : true;
    return hasFile ? mdvDocTitle : '';
  }
  return typeof currentFileName === 'string' ? currentFileName : '';
}

// The file the document came from, as a name ('' for text with no file).
function mdvExportSourceName() {
  return mdvDocumentLabel().split('/').pop();
}

// A file name for the export: the source's name with a new extension, else the title.
function mdvExportFileName(ext) {
  const source = mdvExportSourceName();
  const base = (source ? source.replace(/\.[^.]+$/, '') : mdvExportTitle())
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  return (base || 'document') + ext;
}

// ---------- The document's address ----------
// A browser page's address names a document (?file=<path>) only when the page loaded that document from it, over
// http: loadFromUrl (js/files.js) fetched it. Opened any other way (the Open button, a drop, a file handle, a paste,
// a page opened as a file), the address still says ?file=, but of another file or of none. So the page remembers
// which document loadFromUrl showed, by the comment code's count of loaded documents (mdvLoadSeq, js/comments.js):
// drawing the same document again (a comment change) keeps the count; any other document moves it on.
// The load seam of wave 2 (mdvOpenDocument, stream L) keeps a record of the document on screen and how it was
// fetched; once it is merged, mdvDocumentAddress should read that record, so documents it fetches count too.
let mdvAddressLoad = null; // { seq, file, doc }: the document loadFromUrl showed, and where its file is

if (typeof loadFromUrl === 'function') {
  const mdvLoadFromAddress = loadFromUrl;
  // app.js starts the page with loadFromUrl(), after this script has run.
  loadFromUrl = async function () {
    const file = mdvAddressFile();
    const result = await mdvLoadFromAddress.apply(this, arguments);
    if (file && typeof mdvLoadSeq === 'number' && typeof mdvDocTitle === 'string' && mdvDocTitle === file) {
      const seq = mdvLoadSeq;
      const doc = await mdvFetchedFrom(file);
      if (mdvLoadSeq === seq) mdvAddressLoad = { seq, file, doc };
    }
    return result;
  };
}

function mdvAddressFile() {
  try { return new URL(location.href).searchParams.get('file') || ''; } catch (e) { return ''; }
}

// Where loadFromUrl found the file: next to the page, else under the workspace root path set in Settings.
async function mdvFetchedFrom(file) {
  const near = new URL(file, location.href);
  let root = '';
  try { root = localStorage.getItem('mdv-basepath') || ''; } catch (e) { root = ''; }
  if (!root) return near;
  try { if ((await fetch(near.href, { method: 'HEAD', cache: 'no-store' })).ok) return near; } catch (e) { /* not there */ }
  return new URL(root + file, location.href);
}

// { page, doc, file }: the page's address (without a fragment) and the document's file, as URLs, and the ?file=
// value, while the page shows the document its address names; else null.
function mdvDocumentAddress() {
  const a = mdvAddressLoad;
  if (!a || !/^https?:$/.test(location.protocol)) return null;
  if (typeof mdvLoadSeq !== 'number' || mdvLoadSeq !== a.seq || mdvAddressFile() !== a.file) return null;
  const page = new URL(location.href);
  page.hash = '';
  return { page, doc: a.doc, file: a.file };
}

// A file: URL for a path: POSIX (/home/a b/x.md), Windows (C:\x\y.md) or UNC (\\host\share\y.md).
function mdvFileUrl(path) {
  const p = String(path).replace(/\\/g, '/');
  const enc = (parts) => parts.map(encodeURIComponent).join('/');
  if (p.startsWith('//')) {
    const [host, ...rest] = p.slice(2).split('/');
    return `file://${host}/${enc(rest)}`;
  }
  const parts = p.split('/');
  if (/^[a-zA-Z]:$/.test(parts[0])) return `file:///${parts[0]}/${enc(parts.slice(1))}`;
  return 'file://' + enc(parts);
}

// ---------- A copy of the document ----------
// The rendered document, or the part of it a range covers, cloned. liveOf maps each cloned element back to the
// element on the page, for what only the page knows: computed styles, whether an image loaded, a diagram's size.
// The page's elements carry a numbered attribute only for the instant of the clone.
function mdvSnapshot(range) {
  const body = document.getElementById('mdBody');
  let scope = body;
  if (range) {
    scope = range.commonAncestorContainer;
    if (scope.nodeType !== 1) scope = scope.parentElement;
  }
  const live = Array.from(scope.getElementsByTagName('*'));
  live.forEach((el, i) => el.setAttribute('data-mdv-snap', String(i)));
  const liveOf = new WeakMap();
  let root;
  try {
    if (range) {
      // A range inside one block holds only its inner pieces: rebuild the path from #mdBody down to it, shallow,
      // so a code block, a table cell or a quote keeps what made it one.
      let piece = range.cloneContents();
      for (let a = scope; a && a !== body; a = a.parentElement) {
        const shell = a.cloneNode(false);
        shell.removeAttribute('data-mdv-snap');
        liveOf.set(shell, a);
        shell.appendChild(piece);
        piece = shell;
      }
      root = document.createElement('div');
      root.appendChild(piece);
    } else {
      root = document.createElement('article');
      for (const node of body.childNodes) root.appendChild(node.cloneNode(true));
    }
  } finally {
    for (const el of live) el.removeAttribute('data-mdv-snap');
  }
  for (const el of root.querySelectorAll('[data-mdv-snap]')) {
    const original = live[Number(el.getAttribute('data-mdv-snap'))];
    if (original) liveOf.set(el, original);
    el.removeAttribute('data-mdv-snap');
  }
  return { root, liveOf };
}

// What the viewer adds to a document and a copy leaves out. The heading permalinks stay in an exported page (they
// are plain in-page links there); a clipboard copy drops them too.
const MDV_SNAPSHOT_DROP = [
  '.section-toggle', '.diagram-expand-btn', '.section-minimap', '.mdv-chip', '.copy-btn',
  'button', 'script', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'form', 'link', 'meta', 'base',
  'textarea', 'select', 'input:not([type="checkbox"])',
].join(', ');
const MDV_SNAPSHOT_CLASSES = ['tts-active', 'mdv-flash', 'is-expandable', 'mdv-node-link', 'mdv-more-left', 'mdv-more-right', 'focused'];

function mdvCleanSnapshot(root, { clipboard = false } = {}) {
  // Every HTML comment: comment threads and their anchors, narration. They are the viewer's data, not the page.
  const comments = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) comments.push(n);
  comments.forEach((c) => c.remove());
  root.querySelectorAll(MDV_SNAPSHOT_DROP + (clipboard ? ', .header-anchor, .code-header' : '')).forEach((el) => {
    // A permalink follows its heading's words after a space: the space goes with it.
    const before = el.previousSibling;
    el.remove();
    if (before && before.nodeType === 3 && !before.nextSibling) before.nodeValue = before.nodeValue.replace(/\s+$/, '');
  });
  // A folded section is still part of the document.
  root.querySelectorAll('.section-content.collapsed').forEach((el) => el.classList.remove('collapsed'));
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name); // the sanitizer already removed these; checked again
      else if (name.startsWith('data-mdv') && name !== 'data-mdv-print-url' && name !== 'data-mdv-section') el.removeAttribute(attr.name);
      else if (name === 'data-action' || name === 'data-arg') el.removeAttribute(attr.name); // the viewer's controls
      else if (/(^|:)(href|src|action|formaction|xlink:href)$/.test(name) && /^\s*(javascript|vbscript):/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    el.removeAttribute('tabindex');
    if (el.classList.length) el.classList.remove(...MDV_SNAPSHOT_CLASSES);
    if (el.getAttribute('class') === '') el.removeAttribute('class');
  }
  // The lightbox made every image a button; a copy shows the image itself.
  for (const img of root.querySelectorAll('img[role="button"]')) {
    img.removeAttribute('role');
    if (/^Enlarge image/.test(img.getAttribute('aria-label') || '')) img.removeAttribute('aria-label');
  }
  root.querySelectorAll('.header-anchor[title]').forEach((a) => a.removeAttribute('title'));
}

// A diagram node that goes to a section (enhancements.js) is a link in an exported page too: an SVG <a>, which needs
// no script.
function mdvStaticDiagramLinks(root) {
  for (const node of root.querySelectorAll('svg [data-mdv-section]')) {
    const id = node.getAttribute('data-mdv-section');
    node.removeAttribute('data-mdv-section');
    node.removeAttribute('role');
    node.removeAttribute('aria-label');
    if (!id) continue;
    const a = document.createElementNS(MDV_SVG_NS, 'a');
    a.setAttribute('href', '#' + id);
    node.replaceWith(a);
    a.appendChild(node);
  }
}

// ---------- Links ----------
// A link written in a document points at another file relative to the document, which means nothing in a downloaded
// file or a pasted message. So each link of a copy is made to work where the copy goes:
// - a web or mail link stays as it is;
// - a link to a place in the document (#…, or the document's own path with a fragment) goes to that place: in an
//   exported page it is an in-page link; on the clipboard it becomes its words, since a paste has no such place;
// - a link to another file, when the page's address names the document (mdvDocumentAddress), is resolved against
//   the document's own address: a Markdown file opens in this viewer (?file=), any other file at its own address.
//   It then opens on this computer (`local`);
// - with no address to resolve it from (a document opened from disk, pasted text, the desktop app), an exported page
//   keeps it as written, which works next to the document (`kept`), and the clipboard keeps its words (`text`).
// Absolute file paths are never written into a copy: they would carry the reader's folders to whoever receives it.
// The counts let the confirmation say what will not open elsewhere; `resolved` holds the links resolved here.
const MDV_MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;

function mdvResolveLinks(root, { address = null, clipboard = false } = {}) {
  const counts = { local: 0, kept: 0, text: 0, resolved: [] };
  if (clipboard) root.querySelectorAll('a.footnote-backref').forEach((a) => a.remove()); // "back to the text": no place in a paste
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href) continue;
    const fragment = href.startsWith('#') ? href : mdvSameDocumentFragment(href, address);
    if (fragment !== null) {
      if (clipboard) mdvUnwrapLink(a);
      else if (fragment !== href) a.setAttribute('href', fragment);
      continue;
    }
    if (/^(?:https?:|mailto:)/i.test(href) || href.startsWith('//')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { mdvUnwrapLink(a); continue; } // a scheme with nothing to open elsewhere
    const resolved = address ? mdvAddressLink(href, address) : null;
    if (resolved) {
      a.setAttribute('href', resolved);
      counts.local++;
      counts.resolved.push(a);
    } else if (clipboard) {
      mdvUnwrapLink(a);
      counts.text++;
    } else {
      counts.kept++;
    }
  }
  return counts;
}

function mdvUnwrapLink(a) {
  a.replaceWith(...a.childNodes);
}

// "#id" when `href` is the document's own path with a fragment (doc.md#risks, or the desktop's path form); else null.
function mdvSameDocumentFragment(href, address) {
  const hash = href.indexOf('#');
  if (hash < 0) return null;
  const fragment = href.slice(hash);
  const host = window.mdvHost;
  if (host && host.kind === 'desktop' && host.currentPath && typeof host.resolvePath === 'function') {
    let path = href.slice(0, hash).replace(/\?.*$/, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-zA-Z]:[\\/]/.test(path)) return null;
    try { path = decodeURIComponent(path); } catch (e) { /* as written */ }
    const abs = path ? host.resolvePath(path) : null;
    const fold = /Mac|Win/i.test(navigator.platform || navigator.userAgent || '') ? (s) => s.toLowerCase() : (s) => s;
    return abs && fold(abs) === fold(String(host.currentPath)) ? fragment : null;
  }
  if (!address || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null;
  try {
    const url = new URL(href, address.doc);
    return url.origin === address.doc.origin && url.pathname === address.doc.pathname ? fragment : null;
  } catch (e) {
    return null;
  }
}

// A link to another file, resolved against the document's address: a Markdown file as this viewer's address for it
// (markdown-viewer.html?file=<path>#…), any other file as its own address. Null when it cannot be resolved.
function mdvAddressLink(href, address) {
  let url;
  try { url = new URL(href, address.doc); } catch (e) { return null; }
  if (url.origin !== address.page.origin) return null;
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch (e) { /* as written */ }
  if (!MDV_MARKDOWN_FILE.test(path)) return url.href;
  const view = new URL(address.page);
  const folder = view.pathname.replace(/[^/]*$/, '');
  const decodedFolder = (() => { try { return decodeURIComponent(folder); } catch (e) { return folder; } })();
  const file = path.startsWith(decodedFolder) ? path.slice(decodedFolder.length) : path;
  // ?file=notes/plan.md, as an address is typed: the slashes stay, anything else a query cannot hold is encoded.
  view.search = '?file=' + file.split('/').map(encodeURIComponent).join('/');
  view.hash = url.hash;
  return view.href;
}

// ---------- Images ----------
// A local image becomes a data: URI; a web image keeps its web address. Returns the images that could not be read,
// each replaced by a visible note. `address` (mdvDocumentAddress, taken when the copy was made) is where a path
// written in the document is read from.
async function mdvInlineImages(root, liveOf, { noteStyle = null, address = null } = {}) {
  const missing = [];
  await Promise.all(Array.from(root.querySelectorAll('img')).map(async (img) => {
    const live = liveOf.get(img) || null;
    const src = img.getAttribute('src') || '';
    if (/^data:/i.test(src)) return;
    const written = (live && live.dataset.mdvSrc) || src; // the desktop rewrites src; it keeps the path as written
    const web = mdvWebAddress(written);
    if (web) { img.setAttribute('src', web); return; }
    let data = null;
    try { data = await mdvReadImage(live, written, address); } catch (e) { data = null; }
    if (data) {
      img.setAttribute('src', data);
      img.removeAttribute('srcset');
      return;
    }
    missing.push(written);
    img.replaceWith(mdvMissingImageNote(written, img.getAttribute('alt'), noteStyle));
  }));
  return missing;
}

// An absolute address on another web site (http, https or protocol-relative), or null. An address on the page's own
// server is a local file served to it.
function mdvWebAddress(src) {
  if (!/^(https?:)?\/\//i.test(src)) return null;
  try {
    const url = new URL(src, location.href);
    if (location.protocol.startsWith('http') && url.origin === location.origin) return null;
    return url.href;
  } catch (e) { return null; }
}

function mdvMissingImageNote(path, alt, style) {
  const note = document.createElement('span');
  note.className = 'mdv-export-missing';
  note.setAttribute('role', 'note');
  const label = (alt || '').trim();
  note.textContent = `Image not included: ${label ? label + ' (' + path + ')' : path}. It could not be read when this copy was made.`;
  if (style) note.setAttribute('style', style);
  return note;
}

// The bytes of a local image, as a data: URI, or null. Only an image is ever read: a file whose type is not an
// image, or whose bytes do not decode as one, is not embedded (mdvImageBlob), however the document names it.
// - Desktop: the asset-protocol image the window shows, drawn on a canvas (the app's CSP lets the page fetch only its
//   own files, and the asset protocol answers with CORS, so the canvas stays readable). An image the window does not
//   load (outside the document's folder) is not read.
// - Browser: through the open folder when there is one (window.mdvFolder), else fetched next to the document (when
//   the page's address names it), else where the page loaded it, else drawn from the page's own image when that
//   image is readable.
async function mdvReadImage(live, written, address) {
  const host = window.mdvHost;
  const ext = (written.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  if (host && host.kind === 'desktop') {
    // Only an image the window loads: js/host.js asks for nothing outside the document's folder (on Windows a
    // network path would connect to its host), and neither does a copy.
    const url = live && live.dataset.mdvSrc ? live.currentSrc || live.getAttribute('src') : null;
    return url ? mdvImageViaCanvas(url, ext, live) : null;
  }
  const fromFolder = await mdvImageFromFolder(written, address);
  if (fromFolder) return fromFolder;
  const tried = new Set();
  const candidates = [];
  try { if (address) candidates.push(new URL(written, address.doc).href); } catch (e) { /* not a path */ }
  if (live && (live.currentSrc || live.src)) candidates.push(live.currentSrc || live.src);
  for (const url of candidates) {
    if (tried.has(url) || /^file:/i.test(url)) continue;
    tried.add(url);
    const data = await mdvFetchAsDataUrl(url);
    if (data) return data;
  }
  if (live && live.complete && live.naturalWidth) return mdvCanvasDataUrl(live, ext);
  return null;
}

async function mdvFetchAsDataUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    let path = '';
    try { path = new URL(url, location.href).pathname; } catch (e) { path = ''; }
    const image = await mdvImageBlob(await res.blob(), path);
    return image ? mdvBlobToDataUrl(image) : null;
  } catch (e) {
    return null;
  }
}

function mdvBlobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

const MDV_IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};

// The image type of a file: the type it carries when that is an image; for a file with no type, or with the
// application/octet-stream a server gives a type it does not know, the type its name's extension stands for. The
// name is a path, never a whole URL: in secret.txt#.png or secret.txt?.png the extension is .txt.
function mdvImageType(type, path) {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  if (t.startsWith('image/')) return t;
  if (t && t !== 'application/octet-stream') return null;
  const ext = (String(path || '').match(/\.([a-z0-9]+)$/i) || [])[1];
  return (ext && MDV_IMAGE_TYPES[ext.toLowerCase()]) || null;
}

// The blob when it is an image, labelled with its image type, else null: its type must say image (mdvImageType) and
// its bytes must decode as one. A document names files by path, so this is what keeps a copy to the images it shows.
async function mdvImageBlob(blob, path) {
  const type = mdvImageType(blob && blob.type, path);
  if (!type) return null;
  const image = blob.type === type ? blob : new Blob([blob], { type });
  const url = URL.createObjectURL(image);
  try {
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    return image;
  } catch (e) {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// N's folder (window.mdvFolder, wave 2): a relative image of a document in the open folder, read through its handle.
// The document's path in the folder is its ?file= path, while the page's address names it.
async function mdvImageFromFolder(written, address) {
  const folder = window.mdvFolder;
  if (!folder || folder.kind !== 'browser' || typeof folder.resolve !== 'function' || typeof folder.read !== 'function') return null;
  if (!address || !address.file) return null;
  try {
    const path = folder.resolve(address.file, written);
    if (!path) return null;
    const entry = await folder.read(path);
    const handle = entry && entry.handle;
    if (!handle || typeof handle.getFile !== 'function') return null;
    const image = await mdvImageBlob(await handle.getFile(), path);
    return image ? mdvBlobToDataUrl(image) : null;
  } catch (e) {
    return null;
  }
}

// An image drawn on a canvas, as PNG (JPEG for a JPEG, so a photo does not grow). Null when the canvas is tainted.
async function mdvImageViaCanvas(url, ext, live) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    return mdvCanvasDataUrl(img, ext, live);
  } catch (e) {
    return null;
  }
}

function mdvCanvasDataUrl(img, ext, live) {
  try {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) {
      const r = (live || img).getBoundingClientRect();
      w = Math.round(r.width) || 300;
      h = Math.round(r.height) || 150;
    }
    // A vector image has no pixels of its own: draw it at twice its size, so it stays sharp.
    const scale = /^svg$/i.test(ext) ? 2 : 1;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return /^jpe?g$/i.test(ext) ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
  } catch (e) {
    return null; // a tainted canvas (an image from another origin, or a file:// page)
  }
}
