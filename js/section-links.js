// ============================================
// Links to sections
// ============================================
// Copy link to this section: each heading's "#" (shown on hover) copies the address of its section instead of jumping
// to it, and the Export menu copies the address of the section being read.
// - In a browser the address is the page's own, with the section as its fragment.
// - In the desktop app it is the document's path with the fragment, which the app follows from a link in any
//   document (js/host.js): see mdvSectionUrl.
// An address with a fragment opens at that section: once the document has rendered, the section is unfolded,
// scrolled to the top and kept there while diagrams and images settle, until the reader scrolls
// (mdvGoToFragmentAfterRender, which a script that opens a document for a link with a fragment can call too).

// ---------- Addresses ----------
// A file: URL for a Windows path (C:\x\y.md) or a UNC one (\\host\share\y.md).
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

// The address of a section (or of the document, with no id).
// - Browser: the page's own address with the section as its fragment.
// - Desktop app: the document's absolute path with the fragment, percent-encoded (/home/a%20b/plan.md#risks): the
//   form a link in any document can take and the app follows (js/host.js), to the section when it is this document.
//   A file: URL could not be that link (markdown-it and the sanitizer drop file: links), and neither can a Windows
//   path, so a Windows document's address is its file: URL, for other programs.
function mdvSectionUrl(id) {
  const host = window.mdvHost;
  const fragment = id ? '#' + encodeURIComponent(id) : '';
  if (host && host.kind === 'desktop' && host.currentPath) {
    const path = String(host.currentPath);
    if (path.startsWith('/') && !path.startsWith('//')) return path.split('/').map(encodeURIComponent).join('/') + fragment;
    return mdvFileUrl(path) + fragment;
  }
  const url = new URL(location.href);
  url.hash = id || '';
  return url.href;
}

function mdvCopySectionLink(heading) {
  const id = heading && heading.id ? heading.id : '';
  const name = heading ? mdvHeadingText(heading) : '';
  mdvCopyText(mdvSectionUrl(id)).then(
    () => mdvToast(name ? `Link to \u201c${name}\u201d copied.` : 'Link to this document copied.'),
    () => mdvToast('The browser did not allow copying.', 'error'),
  );
}

// The section being read: the scroll spy's current heading, else the document's first.
function mdvCurrentHeading() {
  if (typeof mdvSpy === 'object' && mdvSpy && mdvSpy.active && mdvSpy.active.isConnected && mdvSpy.active.id) return mdvSpy.active;
  return document.getElementById('mdBody').querySelector('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
}

// The heading a "#" permalink belongs to, when it is that heading's own: inside it, pointing at its id.
function mdvPermalinkHeading(a) {
  const h = a && a.parentElement;
  if (!h || !/^H[1-6]$/.test(h.tagName) || !h.id) return null;
  let target = (a.getAttribute('href') || '').slice(1);
  try { target = decodeURIComponent(target); } catch (e) { /* as written */ }
  return target === h.id ? h : null;
}

// Only the permalinks markdown-it-anchor made in this render become the viewer's control (js/actions.js): each
// carries the render's key, the one render.js gives code blocks, which a document cannot know. A "#" link a document
// writes for itself stays a plain link, so a document cannot use one to write to the clipboard.
let mdvPermalinkKey = null;
try {
  md.core.ruler.push('mdv_permalink_key', (state) => {
    const key = state.env && state.env.mdvCodeKey;
    if (!key) return;
    mdvPermalinkKey = key;
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue;
      for (const child of token.children) {
        if (child.type === 'link_open' && /(^|\s)header-anchor(\s|$)/.test(child.attrGet('class') || '')) child.attrSet('data-mdv-permalink', key);
      }
    }
  });
} catch (e) {
  console.warn('section links: markdown-it is not available', e);
}

mdvOnRender((body) => {
  for (const a of body.querySelectorAll('a[data-mdv-permalink]')) {
    const own = !!mdvPermalinkKey && a.getAttribute('data-mdv-permalink') === mdvPermalinkKey && !!mdvPermalinkHeading(a);
    a.removeAttribute('data-mdv-permalink');
    if (!own) continue;
    a.dataset.action = 'copy-section-link';
    a.title = 'Copy link to this section';
    mdvMarkOwnControl(a);
  }
});

// A heading's "#" copies its section's address. In a browser the address bar shows it too (Back returns), without
// the jump: the heading is already in view, under the pointer. From the Export menu: the section being read.
function mdvSectionLinkAction(el, event) {
  const heading = el.classList.contains('header-anchor') ? mdvPermalinkHeading(el) : null;
  if (heading) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // a new tab or window, as the browser does it
    event.preventDefault();
    const host = window.mdvHost;
    if (!(host && host.kind === 'desktop') && mdvLinkTarget(location.hash) !== heading) {
      try { history.pushState(history.state, '', '#' + encodeURIComponent(heading.id)); } catch (err) { /* the address cannot change */ }
    }
    mdvCopySectionLink(heading);
    return;
  }
  closeDropdowns();
  if (mdvHasDocument()) mdvCopySectionLink(mdvCurrentHeading());
}

// ---------- Opening at a section ----------
// Unfolds and scrolls to `target`, then keeps it at the top while the layout settles (diagrams are drawn, images and
// fonts load), until the reader scrolls or presses a key, or ten seconds pass.
function mdvHoldAt(target) {
  mdvReveal(target);
  const place = () => target.scrollIntoView({ block: 'start', behavior: 'instant' });
  place();
  // Tab continues from the section, as after the browser's own jump to a fragment, without a focus ring on load.
  mdvSetTabStart(target);
  const body = document.getElementById('mdBody');
  if (typeof ResizeObserver !== 'function') return;
  const inputs = ['wheel', 'touchstart', 'keydown', 'mousedown'];
  let done = false;
  let timer = 0;
  const observer = new ResizeObserver(() => { if (!done && target.isConnected) place(); });
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    observer.disconnect();
    for (const t of inputs) window.removeEventListener(t, stop, true);
  };
  observer.observe(body);
  for (const t of inputs) window.addEventListener(t, stop, true);
  timer = setTimeout(stop, 10_000);
}

// Goes to `fragment` ("#id") once the next document has rendered: a page opened at a section, or a document opened
// for a link with a fragment. renderMarkdown scrolls to the top as it returns; this runs just after it.
let mdvPendingFragment = '';
function mdvGoToFragmentAfterRender(fragment) {
  mdvPendingFragment = fragment && fragment !== '#' ? fragment : '';
}

mdvOnRender(() => {
  if (!mdvPendingFragment) return;
  const target = mdvLinkTarget(mdvPendingFragment);
  mdvPendingFragment = '';
  if (target) mdvHoldAt(target);
});

// The page opened at a section (#demo names the demo, not a section).
if (location.hash !== '#demo') mdvGoToFragmentAfterRender(location.hash);

mdvRegisterActions({
  'copy-section-link': { click: (el, arg, event) => mdvSectionLinkAction(el, event) },
});
