// ============================================
// Readable text: what a reader sees, without the viewer's own additions
// ============================================
// The viewer adds controls and presentation copies inside the document: fold chevrons, the "#"
// permalink, comment chips, the code header, the diagram expand button, the section minimap, a link
// card's icon, address line and type badge, KaTeX's aria-hidden HTML copy of every formula and its TeX
// annotation. None of it is the author's words, so headings, search, the outline and read-aloud all leave
// it out. Search and read-aloud read the page after every render pass has run (they are built on first
// use), so everything a later pass adds has to be listed here.
// Checked for every element of every block on every render, so it is a tag and class lookup, not a
// selector match. Tags are compared by localName, which is lower case for HTML, SVG and MathML alike;
// tagName is upper case only for HTML, so the SVG <style> inside every Mermaid diagram slipped past an
// upper-case 'STYLE', and a diagram nested in a list or <details> was read aloud as its stylesheet.
const MDV_NOT_TEXT_TAGS = new Set(['button', 'script', 'style', 'template', 'annotation']);
const MDV_NOT_TEXT_CLASSES = ['section-toggle', 'header-anchor', 'mdv-chip', 'code-header', 'diagram-expand-btn', 'section-minimap',
  'link-chip-icon', 'link-chip-url', 'link-chip-badge'];

function mdvExcludedFromText(el) {
  if (MDV_NOT_TEXT_TAGS.has(el.localName) || el.getAttribute('aria-hidden') === 'true') return true;
  const cl = el.classList;
  if (cl.length) for (const c of MDV_NOT_TEXT_CLASSES) if (cl.contains(c)) return true;
  return false;
}

// A heading's own words. Replaces textContent.replace(/#/g, ''), which also deleted every "#" the
// author wrote ("C# tips" became "C tips") and kept a comment chip's "💬 2" in the breadcrumb.
function mdvHeadingText(h) {
  let s = '';
  (function walk(node) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && !mdvExcludedFromText(c)) walk(c);
    }
  })(h);
  return s.replace(/\s+/g, ' ').trim();
}

// ============================================
// Section toggle (collapsible headings)
// ============================================
const chevronSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

// Wraps what follows each h1-h4, up to the next heading of the same or a higher level, in a
// div.section-content. Every node moves, not only elements: an HTML comment belongs to the block after
// it (<!-- narrate: --> for read-aloud, <!-- MDV-ANCHOR --> for comment threads), and moving elements
// alone left those comments behind the wrapper, where nothing could find them (roadmap issue 12). It
// also stranded thousands of whitespace nodes side by side, which made replacing a large document
// slow. Comment and text nodes after a section's last element stay put: they belong to what follows.
//
// The heading's controls are labelled for screen readers and the keyboard here as well:
// - A heading's name is its content, so with the chevron inside it every heading was announced as
//   "Toggle section C# tips". The heading is named by its own words (aria-label), and the chevron after
//   its section ("Toggle section: C# tips") instead of one name shared by every chevron.
// - The "#" permalink is a mouse affordance that markdown-it-anchor already hides from screen readers. It is
//   invisible until hovered, so it leaves the Tab order too: tabbing on from a heading (an outline jump puts
//   the focus there) landed on nothing the reader could see.
function addSectionToggles() {
  const body = document.getElementById('mdBody');
  body.querySelectorAll('.header-anchor').forEach(a => { a.tabIndex = -1; });
  let n = 0;
  body.querySelectorAll('h1,h2,h3,h4').forEach(heading => {
    const level = parseInt(heading.tagName[1]);
    const text = mdvHeadingText(heading);
    if (text) heading.setAttribute('aria-label', text);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'section-toggle';
    btn.innerHTML = chevronSvg;
    btn.setAttribute('aria-label', text ? `Toggle section: ${text}` : 'Toggle section');
    btn.setAttribute('aria-expanded', 'true');
    btn.onclick = (e) => { e.stopPropagation(); toggleSection(heading, btn); };
    heading.prepend(btn);

    const wrapper = document.createElement('div');
    wrapper.className = 'section-content';
    wrapper.dataset.level = level;
    wrapper.id = 'mdv-section-' + (n++);

    let pending = [];
    for (let node = heading.nextSibling; node; ) {
      const next = node.nextSibling;
      if (node.nodeType === 1) {
        if (/^H[1-6]$/.test(node.tagName) && parseInt(node.tagName[1]) <= level) break;
        for (const p of pending) wrapper.appendChild(p);
        pending = [];
        wrapper.appendChild(node);
      } else {
        pending.push(node);
      }
      node = next;
    }
    if (wrapper.childElementCount > 0) {
      heading.insertAdjacentElement('afterend', wrapper);
      btn.setAttribute('aria-controls', wrapper.id);
    } else {
      btn.style.visibility = 'hidden';
    }
  });
}

// The section a heading folds. Found through the toggle's aria-controls, not nextElementSibling: the
// section minimap is inserted between the first h1 and its section, which made that h1 unfoldable.
function mdvSectionOf(btn) {
  const id = btn && btn.getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
}

function mdvSetCollapsed(btn, content, collapsed) {
  content.classList.toggle('collapsed', collapsed);
  btn.classList.toggle('collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  mdvScrollSpyInvalidate();
}

function toggleSection(heading, btn) {
  btn = btn || heading.querySelector('.section-toggle');
  const content = mdvSectionOf(btn);
  if (!content) return;
  mdvSetCollapsed(btn, content, !content.classList.contains('collapsed'));
}

function toggleAllSections() {
  allCollapsed = !allCollapsed;
  document.getElementById('mdBody').querySelectorAll('.section-toggle[aria-controls]').forEach(btn => {
    const content = mdvSectionOf(btn);
    if (content) mdvSetCollapsed(btn, content, allCollapsed);
  });
}

// Unfolds every folded section around an element. Read-aloud unfolds each block it reads this way.
function mdvUnfold(el) {
  for (let c = el.parentElement && el.parentElement.closest('.section-content.collapsed'); c;
       c = c.parentElement && c.parentElement.closest('.section-content.collapsed')) {
    const btn = document.querySelector(`.section-toggle[aria-controls="${c.id}"]`);
    if (btn) mdvSetCollapsed(btn, c, false); else c.classList.remove('collapsed');
  }
}

// Unfolds every folded section and opens every closed <details> around an element, so a jump to it
// (outline, search) lands on something visible.
function mdvReveal(el) {
  mdvUnfold(el);
  for (let d = el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) d.open = true;
}

// Moves the keyboard focus to a document element without scrolling, so Tab continues from there.
// An element that is not focusable gets tabindex=-1 for as long as it holds the focus.
function mdvFocusInDocument(el) {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
  }
  el.focus({ preventScroll: true });
}

// Reveals, scrolls to and focuses an element; `flash` briefly highlights it.
function mdvGoTo(el, { flash = false } = {}) {
  if (!el) return;
  mdvReveal(el);
  el.scrollIntoView({ behavior: 'smooth', block: flash ? 'center' : 'start' });
  mdvFocusInDocument(el);
  if (flash) mdvFlash(el);
}

// Highlights an element's background for two seconds, then gives back the author's own inline background
// colour (raw HTML can set one, as in <td style="background: …">); clearing it erased the author's colour.
function mdvFlash(el) {
  if (!el._mdvFlash) {
    el._mdvFlash = { had: el.hasAttribute('style'), color: el.style.getPropertyValue('background-color'),
                     priority: el.style.getPropertyPriority('background-color'), timer: 0 };
  }
  const f = el._mdvFlash;
  clearTimeout(f.timer);
  el.style.setProperty('background-color', 'var(--bg-tts-highlight)');
  f.timer = setTimeout(() => {
    el._mdvFlash = null;
    if (f.color) el.style.setProperty('background-color', f.color, f.priority);
    else el.style.removeProperty('background-color');
    if (!f.had && !el.getAttribute('style')) el.removeAttribute('style');
  }, 2000);
}

// ============================================
// TOC
// ============================================
function buildToc() {
  const body = document.getElementById('mdBody');
  const headings = body.querySelectorAll('h1,h2,h3,h4,h5,h6');
  const tocList = document.getElementById('tocList');
  const sidebar = document.getElementById('tocSidebar');
  const wrapper = document.getElementById('contentWrapper');
  tocList.replaceChildren();

  if (headings.length === 0) {
    sidebar.classList.add('hidden');
    wrapper.classList.add('full-width');
    mdvSyncTocInert();
    return;
  }
  // A heading-less document hides the outline without changing the reader's choice; the next document
  // with headings shows it again as the reader left it.
  sidebar.classList.toggle('hidden', !tocVisible);
  wrapper.classList.toggle('full-width', !tocVisible);
  mdvSyncTocInert();

  const frag = document.createDocumentFragment();
  headings.forEach((h, i) => {
    if (!h.id) h.id = `heading-${i}`;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'toc-link';
    a.href = `#${h.id}`;
    a.textContent = mdvHeadingText(h);
    a.dataset.level = h.tagName[1];
    a.dataset.target = h.id;
    li.appendChild(a);
    frag.appendChild(li);
  });
  tocList.appendChild(frag);
}

// One delegated listener for the outline's links, attached once (not one closure per link per render).
document.getElementById('tocList').addEventListener('click', (e) => {
  const a = e.target.closest('a.toc-link');
  if (!a) return;
  e.preventDefault();
  mdvGoTo(document.getElementById(a.dataset.target));
  mdvHideMobileToc();
});
document.getElementById('tocSidebar').setAttribute('aria-label', 'Table of contents');

// At 900 px or less (the stylesheet's breakpoint) the outline is off-canvas and slides in over the page.
const mdvNarrow = window.matchMedia('(max-width: 900px)');

function toggleToc() {
  const sb = document.getElementById('tocSidebar');
  const wr = document.getElementById('contentWrapper');
  if (mdvNarrow.matches) {
    sb.classList.toggle('mobile-show');
  } else {
    tocVisible = !tocVisible;
    sb.classList.toggle('hidden', !tocVisible);
    wr.classList.toggle('full-width', !tocVisible);
  }
  mdvSyncTocInert();
}

function mdvHideMobileToc() {
  document.getElementById('tocSidebar').classList.remove('mobile-show');
  mdvSyncTocInert();
}

// An outline that cannot be seen is inert: out of the Tab order and away from screen readers. It is hidden
// by its toggle (or for a heading-less document) when wide, and off-canvas unless slid in when narrow.
// Before, its links stayed tab stops while hidden, where the focus could not be seen: one per heading.
function mdvSyncTocInert() {
  const sb = document.getElementById('tocSidebar');
  const shown = mdvNarrow.matches ? sb.classList.contains('mobile-show') : !sb.classList.contains('hidden');
  if (sb.inert !== !shown) sb.inert = !shown;
}
mdvNarrow.addEventListener('change', mdvSyncTocInert);

// ============================================
// Scroll spy + breadcrumb
// ============================================
// Where the reader is: the last visible heading above the reading line. One passive scroll listener for
// the page's lifetime does the work, at most once per animation frame, with a binary search over the
// headings' live positions. Nothing is created per render, so nothing can pile up (each render used to
// add an IntersectionObserver that was never disconnected), the cost per frame does not grow with the
// document, and it is right in both directions: a band observer only noticed headings entering the band,
// so scrolling back up into a long section kept the section below highlighted.
const mdvSpy = { headings: [], visible: null, links: new Map(), segments: new Map(), minimap: null,
                 active: null, home: '', frame: 0 };

function setupScrollSpy() {
  const body = document.getElementById('mdBody');
  mdvSpy.headings = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  mdvSpy.links = new Map([...document.querySelectorAll('#tocList .toc-link')].map(a => [a.dataset.target, a]));
  // The minimap (built in enhancements.js) is driven from here too: segments are found by data-target-id.
  mdvSpy.minimap = body.querySelector('.section-minimap');
  mdvSpy.segments = new Map(mdvSpy.minimap
    ? [...mdvSpy.minimap.querySelectorAll('[data-target-id]')].map(s => [s.dataset.targetId, s]) : []);
  mdvSpy.home = document.getElementById('breadcrumb').textContent;
  mdvSpy.visible = null;
  mdvSpy.active = null;
  mdvScrollSpySchedule();
}

function mdvScrollSpySchedule() {
  if (!mdvSpy.frame) mdvSpy.frame = requestAnimationFrame(mdvScrollSpyUpdate);
}

// Folding or unfolding changes which headings can be seen.
function mdvScrollSpyInvalidate() {
  mdvSpy.visible = null;
  mdvScrollSpySchedule();
}

// A heading the reader can see: not in a folded section (display: none) and not in a closed <details>.
// Chrome hides a closed <details> with content-visibility, and getClientRects() still reports a box for a
// heading in there; checkVisibility() does not.
function mdvHeadingVisible(h) {
  return h.checkVisibility ? h.checkVisibility() : h.getClientRects().length > 0;
}

function mdvScrollSpyUpdate() {
  mdvSpy.frame = 0;
  if (!mdvSpy.headings.length || !mdvSpy.headings[0].isConnected) return;
  if (!mdvSpy.visible) mdvSpy.visible = mdvSpy.headings.filter(mdvHeadingVisible);
  const list = mdvSpy.visible;
  const line = Math.max(80, window.innerHeight * 0.3);
  let lo = 0, hi = list.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].getBoundingClientRect().top <= line) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // At the very bottom, short last sections can never reach the line: take the last heading on screen.
  // Only on a page that scrolls: one too short to scroll is at its top as much as at its bottom, and the
  // reader starts at the top.
  const page = document.documentElement;
  if (page.scrollHeight > window.innerHeight + 2 && window.innerHeight + window.scrollY >= page.scrollHeight - 2) {
    for (let i = list.length - 1; i > found; i--) {
      if (list[i].getBoundingClientRect().top < window.innerHeight) { found = i; break; }
    }
  }
  mdvSetActiveHeading(found >= 0 ? list[found] : null, found);
}

function mdvSetActiveHeading(h, index) {
  if (h === mdvSpy.active) return;
  const prev = mdvSpy.active;
  mdvSpy.active = h;
  mdvMark(prev && mdvSpy.links.get(prev.id), false);
  const link = h && mdvSpy.links.get(h.id);
  mdvMark(link, true);
  mdvKeepInView(link, document.getElementById('tocSidebar'));
  document.getElementById('breadcrumb').textContent = h ? mdvHeadingText(h) : mdvSpy.home;

  // The minimap shows h2 sections: the h2 at or above the current heading.
  let h2 = null;
  for (let i = index; h && i >= 0; i--) {
    const t = mdvSpy.visible[i].tagName;
    if (t === 'H2') { h2 = mdvSpy.visible[i]; break; }
    if (t === 'H1') break;
  }
  for (const [id, seg] of mdvSpy.segments) mdvMark(seg, !!h2 && id === h2.id);
  mdvKeepInView(h2 && mdvSpy.segments.get(h2.id), mdvSpy.minimap);
}

function mdvMark(el, on) {
  if (!el) return;
  el.classList.toggle('active', on);
  if (on) el.setAttribute('aria-current', 'location'); else el.removeAttribute('aria-current');
}

// Scrolls only `scroller` (the outline, the minimap) so `el` is visible in it. Never the window, and
// never smoothly: a smooth scrollIntoView here could cut short the page's own smooth scroll to a heading.
function mdvKeepInView(el, scroller) {
  if (!el || !scroller) return;
  const e = el.getBoundingClientRect(), s = scroller.getBoundingClientRect();
  if (scroller.scrollHeight > scroller.clientHeight) {
    if (e.top < s.top) scroller.scrollTop += e.top - s.top - 8;
    else if (e.bottom > s.bottom) scroller.scrollTop += e.bottom - s.bottom + 8;
  }
  if (scroller.scrollWidth > scroller.clientWidth) {
    if (e.left < s.left) scroller.scrollLeft += e.left - s.left - 8;
    else if (e.right > s.right) scroller.scrollLeft += e.right - s.right + 8;
  }
}

window.addEventListener('scroll', mdvScrollSpySchedule, { passive: true });
window.addEventListener('resize', mdvScrollSpySchedule, { passive: true });
// <details> open and close change which headings can be seen ('toggle' does not bubble; capture does).
document.getElementById('mdBody').addEventListener('toggle', mdvScrollSpyInvalidate, true);

// ============================================
// Modal overlays: search, keyboard shortcuts, image lightbox
// ============================================
// One open at a time. Opening one takes the rest of the page away from the reader (no focus, no clicks,
// hidden from screen readers), keeps Tab inside it and moves the focus in; closing it gives the focus back
// to whatever had it before. Esc closes it (the key handler is in app.js).
//
// How the rest of the page is taken away: the small parts (toolbar, panels, player) are made inert. The
// document area (.layout: the outline and the document) is not, because making it inert restyles every
// node in it: over 100 ms each way on a 3,000-section document in Chrome. It is hidden from screen readers
// with aria-hidden instead, which restyles nothing; the dialog's backdrop takes the pointer, and the Tab
// trap and the focus guard below keep the keyboard focus in the dialog.
let mdvModal = null; // { el, returnTo, tabStart, inerted, hidden }

function mdvOpenModal(el, { label, labelledBy, focus } = {}) {
  if (mdvModal && mdvModal.el === el) return;
  if (mdvModal) mdvCloseModal(mdvModal.el, { restoreFocus: false });
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (labelledBy) el.setAttribute('aria-labelledby', labelledBy);
  else if (label) el.setAttribute('aria-label', label);
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
  const returnTo = document.activeElement;
  // Nothing had the focus: remember where the reader last clicked, which is where Tab would continue from.
  const tabStart = !returnTo || returnTo === document.body ? mdvSelectionElement() : null;
  const inerted = [], hidden = [];
  for (const c of document.body.children) {
    if (c.contains(el) || c.tagName === 'SCRIPT') continue;
    if (c.classList.contains('layout')) {
      if (c.getAttribute('aria-hidden') !== 'true') { c.setAttribute('aria-hidden', 'true'); hidden.push(c); }
    } else if (!c.inert) {
      c.inert = true;
      inerted.push(c);
    }
  }
  mdvModal = { el, returnTo, tabStart, inerted, hidden };
  el.classList.add('show');
  (focus || mdvFocusables(el)[0] || el).focus({ preventScroll: true });
}

function mdvCloseModal(el, { restoreFocus = true } = {}) {
  el.classList.remove('show');
  if (!mdvModal || mdvModal.el !== el) return;
  const { returnTo, tabStart, inerted, hidden } = mdvModal;
  mdvModal = null;
  inerted.forEach(c => { c.inert = false; });
  hidden.forEach(c => c.removeAttribute('aria-hidden'));
  // Never leave the focus on a control that just disappeared: keys would keep going to it.
  if (el.contains(document.activeElement)) document.activeElement.blur();
  if (!restoreFocus) return;
  if (returnTo && returnTo !== document.body && returnTo.isConnected && typeof returnTo.focus === 'function') {
    returnTo.focus({ preventScroll: true });
  } else {
    // Nothing had the focus: Tab continues from where the reader last clicked, or from the top of the page.
    // Left alone, it continued from the dialog's own markup: an invisible tooltip button at the top.
    mdvSetTabStart(tabStart && tabStart.isConnected ? tabStart : document.body.firstElementChild);
  }
}

// The element holding the reader's last click: a click in the page leaves a collapsed selection there.
function mdvSelectionElement() {
  const sel = window.getSelection ? window.getSelection() : null;
  const node = sel && sel.rangeCount ? sel.anchorNode : null;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el && el.isConnected ? el : null;
}

// Makes the next Tab continue after `el`, without a focus ring: focusing an element and blurring it at
// once leaves the browser's Tab starting point there.
function mdvSetTabStart(el) {
  if (!el) return;
  const temporary = !el.hasAttribute('tabindex');
  if (temporary) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  el.blur();
  if (temporary) el.removeAttribute('tabindex');
}

function mdvFocusables(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.getClientRects().length > 0);
}

// Tab and Shift+Tab cycle inside the open modal.
document.addEventListener('keydown', (e) => {
  if (!mdvModal || e.key !== 'Tab') return;
  const items = mdvFocusables(mdvModal.el);
  const first = items[0], last = items[items.length - 1];
  const at = document.activeElement;
  if (!items.length) { e.preventDefault(); if (!mdvModal.el.contains(at)) mdvModal.el.focus(); return; }
  if (e.shiftKey && (at === first || at === mdvModal.el || !mdvModal.el.contains(at))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (at === last || !mdvModal.el.contains(at))) { e.preventDefault(); first.focus(); }
}, true);

// The focus guard: focus that reaches the page behind the open dialog anyway (Shift+Tab in from the
// browser's own toolbar, a script) goes back into the dialog.
document.addEventListener('focusin', (e) => {
  if (!mdvModal || mdvModal.el.contains(e.target)) return;
  (mdvFocusables(mdvModal.el)[0] || mdvModal.el).focus({ preventScroll: true });
});

// ============================================
// Search
// ============================================
// Indexed: every heading, and the readable text of each block (paragraphs, list items, table cells,
// definitions, quotes, code, link cards). A block's entry holds only its own words; blocks nested in it
// (a nested list, a paragraph in a quote) have their own entries, so one sentence is never listed twice.
// Diagram source (Mermaid syntax) is left out: it is markup, not prose. A link card (links.js turns a
// paragraph holding only a link into one, after this index's paragraph is gone) is indexed by its title.
const MDV_SEARCH_BLOCKS = new Set(['P', 'LI', 'TD', 'TH', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'SUMMARY']);
const MDV_SEARCH_LIMIT = 20;

function mdvOwnText(el) {
  let s = '';
  (function walk(node) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && !mdvExcludedFromText(c) && !MDV_SEARCH_BLOCKS.has(c.tagName) && !/^H[1-6]$/.test(c.tagName)) walk(c);
    }
  })(el);
  return s.replace(/\s+/g, ' ').trim();
}

// renderMarkdown calls this on every render. The index itself is built on the first search after a
// render (mdvSearchIndex): most renders are never searched, and indexing a large document takes
// tens of milliseconds.
let mdvSearchStale = true;
function buildSearchIndex() {
  searchIndex = [];
  mdvSearchStale = true;
  // The result list points at the previous document's elements, and kept that whole document alive after
  // a re-render. Drop it; if search is open, run the query again on the new document.
  const res = document.getElementById('searchResults');
  if (mdvModal && mdvModal.el.id === 'searchOverlay') handleSearch(document.getElementById('searchInput').value);
  else if (res._matches && res._matches.length) { res.replaceChildren(); res._matches = []; }
}

function mdvSearchIndex() {
  if (mdvSearchStale) { mdvIndexDocument(); mdvSearchStale = false; }
  return searchIndex;
}

function mdvIndexDocument() {
  const body = document.getElementById('mdBody');
  const headings = [], blocks = [];
  let current = null;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: el => mdvExcludedFromText(el) || el.classList.contains('mermaid-wrapper') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (/^H[1-6]$/.test(el.tagName)) {
      current = { id: el.id, text: mdvHeadingText(el) };
      headings.push({ type: 'heading', text: current.text, lower: current.text.toLowerCase(), id: el.id, level: parseInt(el.tagName[1]), element: el });
    } else if (MDV_SEARCH_BLOCKS.has(el.tagName) || el.classList.contains('link-chip')) {
      const text = mdvOwnText(el);
      if (text.length >= 2) blocks.push({ type: 'content', text, lower: text.toLowerCase(), headingId: current && current.id, headingText: current ? current.text : '', element: el });
    }
  }
  searchIndex = headings.concat(blocks); // heading matches first, then blocks in reading order
}

function openSearch() {
  const inp = document.getElementById('searchInput');
  inp.value = '';
  handleSearch('');
  mdvOpenModal(document.getElementById('searchOverlay'), { label: 'Search this document', focus: inp });
}
function closeSearch(opts) { mdvCloseModal(document.getElementById('searchOverlay'), opts); }

function handleSearch(q) {
  const res = document.getElementById('searchResults');
  const inp = document.getElementById('searchInput');
  const status = mdvSearchStatus();
  searchFocusIdx = -1;
  inp.removeAttribute('aria-activedescendant');
  res.replaceChildren();
  res._matches = [];
  if (!q || q.length < 2) { status.textContent = ''; inp.setAttribute('aria-expanded', 'false'); return; }
  const ql = q.toLowerCase();
  const all = mdvSearchIndex().filter(i => i.lower.includes(ql));
  const matches = all.slice(0, MDV_SEARCH_LIMIT);
  matches.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.id = `mdv-search-result-${i}`;
    item.dataset.idx = i;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    const head = document.createElement('span');
    head.className = 'search-result-heading';
    if (m.type === 'heading') {
      head.append('#'.repeat(m.level) + ' ', mdvHighlight(m.text, q));
      item.appendChild(head);
    } else {
      head.textContent = m.headingText || '';
      const ctx = document.createElement('span');
      ctx.className = 'search-result-ctx';
      ctx.appendChild(mdvHighlight(mdvSnippet(m.text, ql), q));
      item.append(head, ctx);
    }
    res.appendChild(item);
  });
  res._matches = matches;
  inp.setAttribute('aria-expanded', String(matches.length > 0));
  status.textContent = !all.length ? 'No matches'
    : all.length > matches.length ? `First ${matches.length} of ${all.length} matches`
    : `${all.length} match${all.length === 1 ? '' : 'es'}`;
}

// About 160 characters around the first match, so a match deep in a long paragraph is visible.
function mdvSnippet(text, ql) {
  const at = text.toLowerCase().indexOf(ql);
  const start = Math.max(0, at - 50);
  return (start > 0 ? '…' : '') + text.slice(start, start + 160) + (start + 160 < text.length ? '…' : '');
}

// The text as nodes, each case-insensitive occurrence of q wrapped in span.search-match. Built from text
// nodes, so nothing in the document is ever parsed as HTML here.
function mdvHighlight(text, q) {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase(), ql = q.toLowerCase();
  // A few characters change length when lower-cased (the Turkish dotted I); then positions in `lower`
  // are not positions in `text`, so show the text without highlights rather than highlight the wrong part.
  if (lower.length !== text.length) { frag.append(text); return frag; }
  let i = 0;
  for (let at = lower.indexOf(ql); ql && at >= 0; at = lower.indexOf(ql, at + ql.length)) {
    if (at > i) frag.append(text.slice(i, at));
    const mark = document.createElement('span');
    mark.className = 'search-match';
    mark.textContent = text.slice(at, at + ql.length);
    frag.appendChild(mark);
    i = at + ql.length;
  }
  if (i < text.length) frag.append(text.slice(i));
  return frag;
}

// "3 matches" / "No matches", shown in the search footer and announced to screen readers.
function mdvSearchStatus() {
  let s = document.getElementById('mdvSearchStatus');
  if (!s) {
    s = document.createElement('span');
    s.id = 'mdvSearchStatus';
    s.setAttribute('role', 'status');
    s.setAttribute('aria-live', 'polite');
    document.querySelector('#searchOverlay .search-footer').appendChild(s);
  }
  return s;
}

function goSearch(idx) {
  const m = document.getElementById('searchResults')._matches?.[idx];
  if (!m) return;
  // The reader asked to go somewhere: the focus follows them there instead of returning to the toolbar.
  closeSearch({ restoreFocus: false });
  const el = (m.element && m.element.isConnected && m.element) || document.getElementById(m.type === 'heading' ? m.id : m.headingId);
  mdvGoTo(el, { flash: m.type === 'content' && el === m.element });
}

function mdvSetSearchFocus(idx) {
  const items = document.getElementById('searchResults').querySelectorAll('.search-result-item');
  searchFocusIdx = idx;
  items.forEach((el, i) => { el.classList.toggle('focused', i === idx); el.setAttribute('aria-selected', String(i === idx)); });
  const inp = document.getElementById('searchInput');
  if (items[idx]) { inp.setAttribute('aria-activedescendant', items[idx].id); items[idx].scrollIntoView({ block: 'nearest' }); }
  else inp.removeAttribute('aria-activedescendant');
}

function handleSearchKeys(e) {
  if (e.isComposing || e.keyCode === 229) return; // Enter that confirms an input method's text is not a jump
  const n = document.getElementById('searchResults').querySelectorAll('.search-result-item').length;
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
  if (!n) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mdvSetSearchFocus((searchFocusIdx + 1) % n); }
  if (e.key === 'ArrowUp') { e.preventDefault(); mdvSetSearchFocus(searchFocusIdx <= 0 ? n - 1 : searchFocusIdx - 1); }
  // Enter takes the highlighted result, or the first one when none is highlighted yet.
  if (e.key === 'Enter') { e.preventDefault(); goSearch(Math.max(0, searchFocusIdx)); }
}

(function wireSearch() {
  const inp = document.getElementById('searchInput');
  const res = document.getElementById('searchResults');
  inp.setAttribute('role', 'combobox');
  inp.setAttribute('aria-autocomplete', 'list');
  inp.setAttribute('aria-controls', 'searchResults');
  inp.setAttribute('aria-expanded', 'false');
  inp.setAttribute('aria-label', 'Search this document');
  res.setAttribute('role', 'listbox');
  res.setAttribute('aria-label', 'Search results');
  res.addEventListener('click', (e) => {
    const item = e.target.closest('.search-result-item');
    if (item) goSearch(parseInt(item.dataset.idx));
  });
})();

// ============================================
// Image lightbox
// ============================================
// Every image that is not a link opens the lightbox, by click or from the keyboard (Tab to it, then
// Enter or Space). An image inside a link follows the link.
function setupImageLightbox() {
  document.getElementById('mdBody').querySelectorAll('img').forEach(img => {
    if (img.closest('a')) return;
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', img.alt ? `Enlarge image: ${img.alt}` : 'Enlarge image');
  });
}

// The focus goes to the enlarged image, so the focus ring frames the picture (not the whole window)
// and a screen reader lands on it.
function openLightbox(img) {
  const big = document.getElementById('lightboxImg');
  big.src = img.currentSrc || img.src;
  big.alt = img.alt || '';
  big.tabIndex = -1;
  mdvOpenModal(document.getElementById('lightbox'), { label: img.alt ? `Image: ${img.alt}` : 'Image', focus: big });
}
function closeLightbox() { mdvCloseModal(document.getElementById('lightbox')); }

(function wireLightbox() {
  const body = document.getElementById('mdBody');
  body.addEventListener('click', (e) => {
    const img = e.target.closest('img[role="button"]');
    if (img) openLightbox(img);
  });
  body.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('img[role="button"]')) {
      e.preventDefault();
      openLightbox(e.target);
    }
  });
})();
