// ============================================
// Diagram expanded view
// ============================================
let diagramZoomLevel = 100;
let diagramFitMode = true;

function openDiagramOverlay(wrapper) {
  // Find the mermaid SVG, not the expand button's icon SVG
  const svgEl = wrapper.querySelector('.mermaid svg') || wrapper.querySelector('pre svg');
  if (!svgEl) return;

  const overlay = document.getElementById('diagramOverlay');
  const container = document.getElementById('diagramZoomContainer');
  const body = document.getElementById('diagramBody');

  // Clone the SVG into the overlay. Its natural size comes from the diagram's own viewBox; fit mode
  // fills the overlay body (CSS), and 100% shows the natural size (see mdvSizeOverlayDiagram).
  container.innerHTML = '';
  const clone = svgEl.cloneNode(true);
  clone.removeAttribute('style');
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
  const box = svgEl.getBoundingClientRect();
  if (!(vb && vb.width && vb.height) && box.width && box.height) {
    clone.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  }
  clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  clone.dataset.naturalWidth = String((vb && vb.width) || box.width || 800);
  clone.dataset.naturalHeight = String((vb && vb.height) || box.height || 600);
  container.appendChild(clone);

  // Reset zoom
  diagramZoomLevel = 100;
  diagramFitMode = true;
  body.classList.add('fit');
  container.style.transform = '';
  mdvSizeOverlayDiagram();
  document.getElementById('diagramZoomLabel').textContent = 'Fit';

  // Detect diagram type for title
  const mermaidEl = wrapper.querySelector('.mermaid');
  let type = 'Diagram';
  if (mermaidEl) {
    const raw = mermaidEl.textContent || '';
    if (/sequenceDiagram/i.test(raw)) type = 'Sequence Diagram';
    else if (/graph\s+(TD|TB|LR|RL|BT)/i.test(raw)) type = 'Flowchart';
    else if (/classDiagram/i.test(raw)) type = 'Class Diagram';
    else if (/gantt/i.test(raw)) type = 'Gantt Chart';
    else if (/pie/i.test(raw)) type = 'Pie Chart';
    else if (/erDiagram/i.test(raw)) type = 'ER Diagram';
    else if (/stateDiagram/i.test(raw)) type = 'State Diagram';
  }
  document.getElementById('diagramTitle').textContent = type;

  overlay.classList.add('show');
}

// Fit mode: the CSS sizes the SVG to the overlay body. Zoom mode: the SVG takes its natural size
// in pixels and the container's transform scales it.
function mdvSizeOverlayDiagram() {
  const svg = document.querySelector('#diagramZoomContainer svg');
  if (!svg) return;
  if (diagramFitMode) {
    svg.style.width = '';
    svg.style.height = '';
  } else {
    svg.style.width = svg.dataset.naturalWidth + 'px';
    svg.style.height = svg.dataset.naturalHeight + 'px';
  }
}

function closeDiagramOverlay() {
  document.getElementById('diagramOverlay').classList.remove('show');
}

function diagramZoom(dir) {
  diagramFitMode = false;
  document.getElementById('diagramBody').classList.remove('fit');
  mdvSizeOverlayDiagram();
  diagramZoomLevel = Math.max(25, Math.min(400, diagramZoomLevel + dir * 25));
  document.getElementById('diagramZoomContainer').style.transform = `scale(${diagramZoomLevel / 100})`;
  document.getElementById('diagramZoomLabel').textContent = diagramZoomLevel + '%';
}

function diagramFitToggle() {
  diagramFitMode = !diagramFitMode;
  const body = document.getElementById('diagramBody');
  const container = document.getElementById('diagramZoomContainer');
  if (diagramFitMode) {
    body.classList.add('fit');
    container.style.transform = '';
    diagramZoomLevel = 100;
    document.getElementById('diagramZoomLabel').textContent = 'Fit';
  } else {
    body.classList.remove('fit');
    container.style.transform = 'scale(1)';
    diagramZoomLevel = 100;
    document.getElementById('diagramZoomLabel').textContent = '100%';
  }
  mdvSizeOverlayDiagram();
}

// Keyboard: Esc closes diagram overlay
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('diagramOverlay').classList.contains('show')) {
    closeDiagramOverlay();
    e.stopPropagation();
  }
});

// Mouse wheel zoom in diagram overlay
document.getElementById('diagramBody').addEventListener('wheel', (e) => {
  if (!document.getElementById('diagramOverlay').classList.contains('show')) return;
  e.preventDefault();
  diagramZoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

