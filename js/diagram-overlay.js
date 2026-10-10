// ============================================
// Diagram expanded view: pan, zoom, fit, keyboard
// ============================================
// The diagram is a clone of the page's SVG, drawn at (natural size x scale) and moved with a translate, so it
// stays vector-sharp at every zoom. Drag pans; the wheel, a trackpad pinch and a two-finger touch pinch zoom
// around the pointer; + - 0 1, the arrow keys and Esc work from the keyboard.

let diagramZoomLevel = 100; // the scale shown in #diagramZoomLabel, in percent
let diagramFitMode = true;  // true while the view is "fit to screen"; it follows window resizes

const MDV_ZOOM_MIN = 0.1;
const MDV_ZOOM_MAX = 10;
const MDV_ZOOM_STEP = 1.25;
const MDV_FIT_PADDING = 32;
const MDV_PAN_KEEP = 64; // pixels of the diagram that always stay on screen while panning

const mdvView = {
  wrapper: null, scale: 1, x: 0, y: 0, w: 0, h: 0,
  pointers: new Map(), gesture: null, tween: 0, returnFocus: null, wired: false,
};

function mdvOverlayEls() {
  return {
    overlay: document.getElementById('diagramOverlay'),
    body: document.getElementById('diagramBody'),
    container: document.getElementById('diagramZoomContainer'),
    label: document.getElementById('diagramZoomLabel'),
    title: document.getElementById('diagramTitle'),
    fitBtn: document.getElementById('diagramFitBtn'),
  };
}

function mdvOverlayIsOpen() {
  const { overlay } = mdvOverlayEls();
  return !!overlay && overlay.classList.contains('show');
}

function openDiagramOverlay(wrapper) {
  const source = wrapper && (wrapper.querySelector('.mermaid svg') || wrapper.querySelector('pre svg'));
  if (!source) return;
  const els = mdvOverlayEls();
  mdvWireOverlay();
  if (!mdvOverlayIsOpen()) mdvView.returnFocus = document.activeElement;
  mdvView.wrapper = wrapper;
  mdvPlaceClone(source);
  els.title.textContent = mdvDiagramOverlayTitle(wrapper, source);
  els.overlay.classList.add('show');
  els.overlay.setAttribute('aria-hidden', 'false');
  mdvDiagramFit(false);
  els.body.focus({ preventScroll: true });
}

function closeDiagramOverlay() {
  const { overlay, container } = mdvOverlayEls();
  if (!overlay) return;
  cancelAnimationFrame(mdvView.tween);
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  container.replaceChildren();
  mdvView.wrapper = null;
  mdvView.pointers.clear();
  mdvView.gesture = null;
  const back = mdvView.returnFocus;
  mdvView.returnFocus = null;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

// The toolbar's - and + buttons: zoom around the centre of the view.
function diagramZoom(dir) {
  const { body } = mdvOverlayEls();
  const factor = Number(dir) > 0 ? MDV_ZOOM_STEP : 1 / MDV_ZOOM_STEP;
  mdvZoomAt(factor, body.clientWidth / 2, body.clientHeight / 2, true);
}

// The Fit button: fit to the screen, or back to actual size when already fitted.
function diagramFitToggle() {
  if (diagramFitMode) mdvDiagramActualSize(true);
  else mdvDiagramFit(true);
}

function mdvDiagramFit(animate) {
  const { body } = mdvOverlayEls();
  if (!mdvView.w || !mdvView.h) return;
  const availW = Math.max(1, body.clientWidth - 2 * MDV_FIT_PADDING);
  const availH = Math.max(1, body.clientHeight - 2 * MDV_FIT_PADDING);
  const scale = mdvClampScale(Math.min(availW / mdvView.w, availH / mdvView.h));
  diagramFitMode = true;
  mdvSetView(mdvCentred(scale), animate);
}

function mdvDiagramActualSize(animate) {
  diagramFitMode = false;
  mdvSetView(mdvCentred(1), animate);
}

function mdvCentred(scale) {
  const { body } = mdvOverlayEls();
  return { scale, x: (body.clientWidth - mdvView.w * scale) / 2, y: (body.clientHeight - mdvView.h * scale) / 2 };
}

// Zoom by `factor`, keeping the diagram point under (px, py) — body coordinates — where it is.
function mdvZoomAt(factor, px, py, animate) {
  const scale = mdvClampScale(mdvView.scale * factor);
  const k = scale / mdvView.scale;
  diagramFitMode = false;
  mdvSetView({ scale, x: px - (px - mdvView.x) * k, y: py - (py - mdvView.y) * k }, animate);
}

function mdvClampScale(s) {
  return Math.min(MDV_ZOOM_MAX, Math.max(MDV_ZOOM_MIN, s));
}

function mdvSetView(target, animate) {
  cancelAnimationFrame(mdvView.tween);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!animate || reduce) {
    Object.assign(mdvView, target);
    mdvApplyView();
    return;
  }
  const from = { scale: mdvView.scale, x: mdvView.x, y: mdvView.y };
  const start = performance.now();
  const duration = 180;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - t, 3);
    mdvView.scale = from.scale + (target.scale - from.scale) * e;
    mdvView.x = from.x + (target.x - from.x) * e;
    mdvView.y = from.y + (target.y - from.y) * e;
    mdvApplyView();
    if (t < 1) mdvView.tween = requestAnimationFrame(step);
  };
  mdvView.tween = requestAnimationFrame(step);
}

// Draw the current view: the SVG at its scaled size (vectors stay sharp), the container translated.
function mdvApplyView() {
  const { body, container, label, fitBtn } = mdvOverlayEls();
  const svg = container.querySelector('svg');
  if (!svg) return;
  const bw = body.clientWidth, bh = body.clientHeight;
  const sw = mdvView.w * mdvView.scale, sh = mdvView.h * mdvView.scale;
  // Keep part of the drawing on screen however far it is dragged.
  mdvView.x = Math.min(bw - MDV_PAN_KEEP, Math.max(MDV_PAN_KEEP - sw, mdvView.x));
  mdvView.y = Math.min(bh - MDV_PAN_KEEP, Math.max(MDV_PAN_KEEP - sh, mdvView.y));
  svg.style.width = sw + 'px';
  svg.style.height = sh + 'px';
  container.style.transform = `translate(${mdvView.x}px, ${mdvView.y}px)`;
  diagramZoomLevel = Math.round(mdvView.scale * 100);
  if (label) label.textContent = diagramZoomLevel + '%';
  body.classList.toggle('fit', diagramFitMode);
  if (fitBtn) {
    fitBtn.classList.toggle('active', diagramFitMode);
    fitBtn.setAttribute('aria-pressed', String(diagramFitMode));
  }
}

// Clone the page's SVG into the overlay with its own ids, so its arrowheads and styles never resolve to the copy
// on the page (which a theme change replaces).
function mdvPlaceClone(source) {
  const { container } = mdvOverlayEls();
  const vb = source.viewBox && source.viewBox.baseVal;
  const box = source.getBoundingClientRect();
  const w = (vb && vb.width) || box.width || 800;
  const h = (vb && vb.height) || box.height || 600;
  const clone = source.cloneNode(true);
  clone.removeAttribute('style');
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  if (!(vb && vb.width && vb.height)) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  clone.classList.add('mdv-diagram');
  mdvIsolateSvgIds(clone, 'ov-');
  container.replaceChildren(clone);
  mdvView.w = w;
  mdvView.h = h;
}

function mdvIsolateSvgIds(svg, prefix) {
  const ids = new Map();
  for (const el of [svg, ...svg.querySelectorAll('[id]')]) {
    if (!el.id) continue;
    ids.set(el.id, prefix + el.id);
    el.id = prefix + el.id;
  }
  if (!ids.size) return;
  const swapRef = (_, id) => (ids.has(id) ? `url(#${ids.get(id)})` : `url(#${id})`);
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (attr.value.includes('url(#')) el.setAttribute(attr.name, attr.value.replace(/url\(#([^)]+)\)/g, swapRef));
      else if ((attr.name === 'href' || attr.name === 'xlink:href') && attr.value[0] === '#' && ids.has(attr.value.slice(1))) {
        el.setAttribute(attr.name, '#' + ids.get(attr.value.slice(1)));
      }
    }
  }
  for (const style of svg.querySelectorAll('style')) {
    style.textContent = style.textContent.replace(/#([A-Za-z][\w-]*)/g, (m, id) => (ids.has(id) ? '#' + ids.get(id) : m));
  }
}

// "Pie chart · Estimated effort by area": the type Mermaid reported, plus the diagram's own title if it has one.
function mdvDiagramOverlayTitle(wrapper, svg) {
  const type = (typeof mdvDiagramTypeTitle === 'function') ? mdvDiagramTypeTitle(wrapper.dataset.diagramType) : 'Diagram';
  const own = svg.querySelector('.pieTitleText, .titleText, text.title, .chart-title text');
  const accTitle = svg.querySelector(':scope > title');
  const name = ((own && own.textContent) || (accTitle && accTitle.textContent) || '').trim();
  return name ? `${type} · ${name}` : type;
}

// mermaid.js calls this after redrawing a diagram (for example on a theme change): an open view of that diagram
// swaps in the new drawing and keeps its zoom and position.
function mdvRefreshDiagramOverlay(wrapper) {
  if (!mdvOverlayIsOpen() || mdvView.wrapper !== wrapper) return;
  const source = wrapper.querySelector('.mermaid svg');
  if (!source) return;
  const { scale, x, y } = mdvView;
  mdvPlaceClone(source);
  if (diagramFitMode) mdvDiagramFit(false);
  else mdvSetView({ scale, x, y }, false);
}

// ---------- One-time wiring: controls, pointer, wheel, keyboard ----------

function mdvWireOverlay() {
  if (mdvView.wired) return;
  const els = mdvOverlayEls();
  if (!els.overlay) return;
  mdvView.wired = true;
  els.overlay.setAttribute('role', 'dialog');
  els.overlay.setAttribute('aria-modal', 'true');
  els.overlay.setAttribute('aria-labelledby', 'diagramTitle');
  els.body.setAttribute('tabindex', '-1');
  els.body.setAttribute('aria-label', 'Diagram. Drag to pan; use the plus and minus keys to zoom.');
  if (els.fitBtn) els.fitBtn.title = 'Fit to screen (0)';

  // "1:1" (actual size) sits next to Fit. Wired here with addEventListener: no inline handler.
  if (els.fitBtn && !document.getElementById('diagramActualBtn')) {
    const actual = document.createElement('button');
    actual.type = 'button';
    actual.id = 'diagramActualBtn';
    actual.textContent = '1:1';
    actual.title = 'Actual size (1)';
    actual.addEventListener('click', () => mdvDiagramActualSize(true));
    els.fitBtn.after(actual);
  }
  const controls = els.overlay.querySelector('.diagram-overlay-controls');
  if (controls && !els.overlay.querySelector('.diagram-overlay-hint')) {
    // Fixed text (no document content). It sits in the header, so it never covers the diagram.
    const hint = document.createElement('div');
    hint.className = 'diagram-overlay-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.innerHTML = '<span>Drag to pan</span><span>Scroll or pinch to zoom</span>' +
      '<span><kbd>0</kbd> fit</span><span><kbd>1</kbd> actual size</span><span><kbd>Esc</kbd> close</span>';
    controls.before(hint);
  }

  els.body.addEventListener('wheel', mdvOnWheel, { passive: false });
  els.body.addEventListener('pointerdown', mdvOnPointerDown);
  els.body.addEventListener('pointermove', mdvOnPointerMove);
  els.body.addEventListener('pointerup', mdvOnPointerUp);
  els.body.addEventListener('pointercancel', mdvOnPointerUp);
  els.body.addEventListener('lostpointercapture', (e) => { mdvView.pointers.delete(e.pointerId); });
  window.addEventListener('resize', () => {
    if (!mdvOverlayIsOpen()) return;
    if (diagramFitMode) mdvDiagramFit(false);
    else mdvApplyView();
  });
}

function mdvBodyPoint(e) {
  const r = mdvOverlayEls().body.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function mdvOnWheel(e) {
  if (!mdvOverlayIsOpen()) return;
  e.preventDefault();
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= mdvOverlayEls().body.clientHeight;
  // A trackpad pinch arrives as a ctrl+wheel with small deltas; a mouse wheel notch is about 100.
  const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
  const p = mdvBodyPoint(e);
  mdvZoomAt(factor, p.x, p.y, false);
}

function mdvOnPointerDown(e) {
  if (!mdvOverlayIsOpen()) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const body = mdvOverlayEls().body;
  try { body.setPointerCapture(e.pointerId); } catch (_) { /* the pointer is already gone */ }
  cancelAnimationFrame(mdvView.tween);
  mdvView.pointers.set(e.pointerId, mdvBodyPoint(e));
  mdvStartGesture(e.target);
}

function mdvStartGesture(target) {
  const pts = [...mdvView.pointers.values()];
  if (pts.length >= 2) {
    const [a, b] = pts;
    mdvView.gesture = {
      kind: 'pinch', moved: true, scale0: mdvView.scale, x0: mdvView.x, y0: mdvView.y,
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  } else if (pts.length === 1) {
    mdvView.gesture = { kind: 'drag', moved: false, start: pts[0], x0: mdvView.x, y0: mdvView.y, target };
  }
  mdvOverlayEls().body.classList.add('is-grabbing');
}

function mdvOnPointerMove(e) {
  if (!mdvView.pointers.has(e.pointerId) || !mdvView.gesture) return;
  mdvView.pointers.set(e.pointerId, mdvBodyPoint(e));
  const g = mdvView.gesture;
  const pts = [...mdvView.pointers.values()];
  if (g.kind === 'pinch' && pts.length >= 2) {
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = mdvClampScale(g.scale0 * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist));
    const k = scale / g.scale0;
    diagramFitMode = false;
    mdvView.scale = scale;
    mdvView.x = mid.x - (g.mid.x - g.x0) * k;
    mdvView.y = mid.y - (g.mid.y - g.y0) * k;
    mdvApplyView();
  } else if (g.kind === 'drag') {
    const dx = pts[0].x - g.start.x, dy = pts[0].y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag (yet)
    g.moved = true;
    diagramFitMode = false;
    mdvView.x = g.x0 + dx;
    mdvView.y = g.y0 + dy;
    mdvApplyView();
  }
}

function mdvOnPointerUp(e) {
  if (!mdvView.pointers.has(e.pointerId)) return;
  mdvView.pointers.delete(e.pointerId);
  const g = mdvView.gesture;
  // A click (no drag) on a node that links to a section closes the view and goes there.
  if (e.type === 'pointerup' && g && g.kind === 'drag' && !g.moved && g.target && g.target.closest) {
    const link = g.target.closest('[data-mdv-section]');
    if (link && typeof mdvJumpToSection === 'function') {
      const id = link.getAttribute('data-mdv-section');
      closeDiagramOverlay();
      mdvJumpToSection(id);
      return;
    }
  }
  if (mdvView.pointers.size) mdvStartGesture(null);
  else {
    mdvView.gesture = null;
    mdvOverlayEls().body.classList.remove('is-grabbing');
  }
}

// Keyboard, in the capture phase so these keys do not also reach the page's own shortcuts while the view is open.
document.addEventListener('keydown', (e) => {
  if (!mdvOverlayIsOpen()) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const { body, overlay } = mdvOverlayEls();
  const pan = e.shiftKey ? 240 : 80;
  switch (e.key) {
    case 'Escape': closeDiagramOverlay(); break;
    case '+': case '=': diagramZoom(1); break;
    case '-': case '_': diagramZoom(-1); break;
    case '0': mdvDiagramFit(true); break;
    case '1': mdvDiagramActualSize(true); break;
    case 'ArrowLeft': diagramFitMode = false; mdvSetView({ scale: mdvView.scale, x: mdvView.x + pan, y: mdvView.y }, true); break;
    case 'ArrowRight': diagramFitMode = false; mdvSetView({ scale: mdvView.scale, x: mdvView.x - pan, y: mdvView.y }, true); break;
    case 'ArrowUp': diagramFitMode = false; mdvSetView({ scale: mdvView.scale, x: mdvView.x, y: mdvView.y + pan }, true); break;
    case 'ArrowDown': diagramFitMode = false; mdvSetView({ scale: mdvView.scale, x: mdvView.x, y: mdvView.y - pan }, true); break;
    case 'Tab': {
      // Keep focus inside the dialog.
      const items = [...overlay.querySelectorAll('button:not([disabled])')].filter((b) => b.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !overlay.contains(active) || active === body;
      if (e.shiftKey && (outside || active === first)) { last.focus(); break; }
      if (!e.shiftKey && (outside || active === last)) { first.focus(); break; }
      return;
    }
    default: return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
