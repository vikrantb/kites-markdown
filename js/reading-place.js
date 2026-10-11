// ============================================
// The reader's place in a document
// ============================================
// When a document is shown again (a live reload, Back or Forward to it, the desktop app's own reload), the reader
// comes back to the words they were reading, at the same height on screen, with the sections they folded still
// folded and the <details> they opened still open.
//
// The place is the block at the top of the window: the paragraph, list item, table row, code block or heading just
// under the toolbar, found again by its words. The same words can name several blocks ("TBD." under every day of a
// log), so the sections around a block tell them apart (their headings' words, outermost first), then its rank among
// the blocks with the same words in its section. When that block itself changed, the heading above it is found the
// same way; with neither, the window keeps the same proportion of the page.
//
// Ids never name a place: markdown-it-anchor numbers the headings that share a name (notes, notes-1, notes-2…), so a
// heading added above the reader renumbers every later one, and an old id then names a different section.
//
//   mdvReadingPosition()              the reader's place now; take it while the document is still on screen
//   mdvRestoreReadingPosition(place)  puts the reader back, and keeps them there while diagrams and images settle;
//                                     returns the element they are back at (or null)
//   mdvOpenAtFragment(fragment)       opens a document at a link's #fragment instead

// The blocks a place can be: what the reader reads, the smallest that holds the words (a list item, not its list).
// A diagram's <pre> holds its source and then its drawing, so it is never a place.
const MDV_PLACE_BLOCKS = 'p, li, tr, dt, dd, pre:not(.mermaid), h1, h2, h3, h4, h5, h6, summary, figcaption';
const MDV_PLACE_HEADINGS = 'h1, h2, h3, h4, h5, h6';

// A block's own words: not the viewer's additions (fold chevrons, the "#" permalink, comment chips, a code block's
// header: mdvExcludedFromText), not a drawing, and not the blocks inside it, which are places of their own
function mdvPlaceWords(el) {
  let s = '';
  (function walk(node) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && !mdvNotPlaceText(c)) walk(c);
    }
  })(el);
  return s.replace(/\s+/g, ' ').trim();
}

function mdvNotPlaceText(el) {
  if (typeof mdvExcludedFromText === 'function' && mdvExcludedFromText(el)) return true;
  return el.localName === 'svg' || el.classList.contains('mermaid-wrapper') || el.matches(MDV_PLACE_BLOCKS);
}

function mdvPlaceSelector(tag) { return tag === 'pre' ? 'pre:not(.mermaid)' : tag; }

// The words of the heading that folds each section of the page (js/navigation.js wraps what follows a heading in a
// .section-content), built once per page
function mdvSectionOwners(body) {
  const owners = new Map();
  for (const btn of body.querySelectorAll('.section-toggle[aria-controls]')) {
    const h = btn.closest(MDV_PLACE_HEADINGS);
    if (h) owners.set(btn.getAttribute('aria-controls'), mdvPlaceWords(h));
  }
  return owners;
}

// The sections around an element, outermost first, by their headings' words ("Log › 2026-10-08 › Notes")
function mdvSectionPath(el, owners) {
  const names = [];
  for (let c = mdvSectionAround(el); c; c = mdvSectionAround(c)) names.push(owners.get(c.id) || '');
  return names.reverse().join(' › ');
}
function mdvSectionAround(el) { return el.parentElement ? el.parentElement.closest('.section-content') : null; }

// What names a block again in another version of the page: its tag, its words, its section, and its rank among the
// blocks of its section that have the same words
function mdvPlaceKey(el, owners) {
  const words = mdvPlaceWords(el);
  const section = mdvSectionAround(el);
  let nth = 0;
  for (const other of (section || document.getElementById('mdBody')).querySelectorAll(mdvPlaceSelector(el.localName))) {
    if (other === el) break;
    if (mdvSectionAround(other) === section && mdvPlaceWords(other) === words) nth++;
  }
  return { tag: el.localName, words, path: mdvSectionPath(el, owners), nth };
}

// The block a key names in the page now, or null. `visible`: only one the reader can see (not folded away).
function mdvFindPlace(key, body, owners, visible) {
  const words = key && key.words;
  if (!words) return null;
  // A cheap first test: the longest of its first words appears in the block's text
  const probe = words.split(' ').slice(0, 6).reduce((a, w) => (w.length > a.length ? w : a), '');
  let found = [];
  for (const el of body.querySelectorAll(mdvPlaceSelector(key.tag))) {
    if (probe && !el.textContent.includes(probe)) continue;
    if (mdvPlaceWords(el) === words) found.push(el);
  }
  if (visible) found = found.filter(mdvCanSee);
  if (found.length <= 1) return found[0] || null;
  const here = found.filter((el) => mdvSectionPath(el, owners) === key.path);
  const pool = here.length ? here : found;
  return pool[Math.min(key.nth || 0, pool.length - 1)];
}

function mdvCanSee(el) { return typeof mdvHeadingVisible === 'function' ? mdvHeadingVisible(el) : el.getClientRects().length > 0; }
function mdvToolbarHeight() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-height')) || 48; }

// The text block at the reading line (just under the toolbar), or the first one below it within a few lines
function mdvBlockAtLine(body, line) {
  const box = body.getBoundingClientRect();
  if (box.width <= 0 || box.bottom <= line) return null;
  const x = Math.round(Math.min(window.innerWidth - 2, Math.max(1, box.left + Math.min(48, box.width / 3))));
  const end = Math.min(window.innerHeight - 1, box.bottom, line + 320);
  for (let y = Math.max(line, Math.ceil(box.top)); y < end; y += 8) {
    for (const hit of document.elementsFromPoint(x, y)) {
      if (hit === body || !body.contains(hit)) continue; // the toolbar, a note, a tooltip above the page
      const el = hit.closest(MDV_PLACE_BLOCKS);
      if (el && body.contains(el) && mdvPlaceWords(el)) return el;
      break; // no words at this height (a diagram, an image, the gap between blocks): look a little lower
    }
  }
  return null;
}

// The last heading the reader can see at or above the reading line
function mdvHeadingAbove(body, line) {
  // The scroll spy keeps the headings that can be seen (js/navigation.js); its list is rebuilt after a fold
  let list = typeof mdvSpy !== 'undefined' && mdvSpy.visible && mdvSpy.headings.length && body.contains(mdvSpy.headings[0])
    ? mdvSpy.visible : null;
  if (!list) list = [...body.querySelectorAll(MDV_PLACE_HEADINGS)].filter(mdvCanSee);
  let lo = 0, hi = list.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].getBoundingClientRect().top <= line) { found = list[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// The sections the reader folded and the <details> elements, open or closed, as they are now
function mdvFoldState(body, owners) {
  const folded = [];
  for (const section of body.querySelectorAll('.section-content.collapsed')) {
    const btn = body.querySelector(`.section-toggle[aria-controls="${CSS.escape(section.id)}"]`);
    const h = btn && btn.closest(MDV_PLACE_HEADINGS);
    if (h) folded.push(mdvPlaceKey(h, owners));
  }
  const details = [];
  for (const d of body.querySelectorAll('details')) {
    const summary = d.querySelector(':scope > summary');
    if (summary && mdvPlaceWords(summary)) details.push(Object.assign(mdvPlaceKey(summary, owners), { open: d.open }));
  }
  return { folded, details, all: typeof allCollapsed !== 'undefined' && !!allCollapsed };
}

function mdvApplyFolds(folds, body, owners) {
  for (const d of folds.details || []) {
    const summary = mdvFindPlace(d, body, owners, false);
    const el = summary && summary.parentElement;
    if (el && el.localName === 'details' && el.open !== d.open) el.open = d.open;
  }
  for (const key of folds.folded || []) {
    const h = mdvFindPlace(key, body, owners, false);
    const btn = h && h.querySelector('.section-toggle[aria-controls]');
    const section = btn && typeof mdvSectionOf === 'function' ? mdvSectionOf(btn) : null;
    if (section && !section.classList.contains('collapsed')) mdvSetCollapsed(btn, section, true);
  }
  if (typeof allCollapsed !== 'undefined') allCollapsed = !!folds.all;
}

// ------- Taking the place, and putting the reader back -------
function mdvReadingPosition() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const position = { atTop: window.scrollY < 4, ratio: max > 0 ? Math.min(1, window.scrollY / max) : 0, block: null, heading: null, folds: null };
  const body = document.getElementById('mdBody');
  if (!body || !body.firstElementChild || body.style.display === 'none') return position;
  const owners = mdvSectionOwners(body);
  position.folds = mdvFoldState(body, owners);
  if (position.atTop) return position;
  const line = mdvToolbarHeight() + 8;
  const block = mdvBlockAtLine(body, line);
  if (block) position.block = Object.assign(mdvPlaceKey(block, owners), { offset: block.getBoundingClientRect().top });
  const heading = mdvHeadingAbove(body, line);
  if (heading && heading !== block) position.heading = Object.assign(mdvPlaceKey(heading, owners), { offset: heading.getBoundingClientRect().top });
  return position;
}

let mdvStopHoldingPlace = () => {};

// Puts the reader back at `position` and keeps them there while diagrams and images change the layout after the first
// paint, until the layout settles (2.5 s) or the reader scrolls, clicks or types. `position` is one mdvReadingPosition
// took, or {el, offset}: an element to hold at that height.
function mdvRestoreReadingPosition(position) {
  mdvStopHoldingPlace();
  if (!position) return null;
  const body = document.getElementById('mdBody');
  let target = null;
  if (position.el) target = { el: position.el, offset: position.offset };
  else if (body) {
    const owners = mdvSectionOwners(body);
    if (position.folds) mdvApplyFolds(position.folds, body, owners);
    if (!position.atTop) {
      for (const key of [position.block, position.heading]) {
        const el = key && mdvFindPlace(key, body, owners, true);
        if (el) { target = { el, offset: key.offset }; break; }
      }
    }
  }
  const place = () => {
    if (position.atTop) { window.scrollTo({ top: 0, behavior: 'instant' }); return; }
    if (target && target.el.isConnected) {
      window.scrollTo({ top: window.scrollY + target.el.getBoundingClientRect().top - target.offset, behavior: 'instant' });
    } else {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, (position.ratio || 0) * max), behavior: 'instant' });
    }
  };
  place();
  if (!body || typeof ResizeObserver === 'undefined') return target ? target.el : null;
  const inputs = ['wheel', 'touchstart', 'keydown', 'mousedown'];
  let done = false;
  const observer = new ResizeObserver(() => { if (!done) place(); });
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    observer.disconnect();
    for (const t of inputs) window.removeEventListener(t, stop, true);
  };
  const timer = setTimeout(stop, 2500);
  observer.observe(body);
  for (const t of inputs) window.addEventListener(t, stop, true);
  mdvStopHoldingPlace = stop;
  return target ? target.el : null;
}

// Opens at a link's #fragment: unfolded, at the top of the window, with the focus there (as an in-document link goes,
// js/links.js), and held there while the layout settles
function mdvOpenAtFragment(fragment) {
  const target = typeof mdvLinkTarget === 'function' ? mdvLinkTarget('#' + fragment) : null;
  if (!target) return false;
  if (typeof mdvReveal === 'function') mdvReveal(target);
  target.scrollIntoView({ block: 'start', behavior: 'instant' });
  if (typeof mdvFocusInDocument === 'function') mdvFocusInDocument(target);
  mdvRestoreReadingPosition({ el: target, offset: target.getBoundingClientRect().top });
  return true;
}
