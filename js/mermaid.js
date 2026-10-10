// ============================================
// Mermaid: diagrams drawn in the page's own palette
// ============================================
// Every diagram keeps its source in data-mdv-source, so a theme change redraws it in the new palette
// (known issue 9). The colours come from the --diagram-* custom properties in css/viewer.css, read for the
// current theme and resolved to hex, because Mermaid's colour maths only understands hex.

const MDV_DIAGRAM_FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// The diagram type that mermaid.render() reports, as a title for the expanded view (known issue 16).
const MDV_DIAGRAM_TITLES = {
  'flowchart-v2': 'Flowchart', flowchart: 'Flowchart', 'flowchart-elk': 'Flowchart',
  sequence: 'Sequence diagram', class: 'Class diagram', classDiagram: 'Class diagram',
  state: 'State diagram', stateDiagram: 'State diagram', er: 'Entity relationship diagram',
  gantt: 'Gantt chart', pie: 'Pie chart', journey: 'User journey', mindmap: 'Mind map',
  timeline: 'Timeline', gitGraph: 'Git graph', quadrantChart: 'Quadrant chart', xychart: 'XY chart',
  requirement: 'Requirement diagram', sankey: 'Sankey diagram', block: 'Block diagram',
  packet: 'Packet diagram', architecture: 'Architecture diagram', kanban: 'Kanban board',
  c4: 'C4 diagram', info: 'Mermaid info',
};

function mdvDiagramTypeTitle(type) {
  return MDV_DIAGRAM_TITLES[type] || 'Diagram';
}

const MDV_EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

let mdvMermaidQueue = Promise.resolve(); // render passes run one after another
let mdvMermaidGeneration = 0;            // the newest requested pass; an older pass stops at its next diagram
let mdvMermaidSeq = 0;                   // render ids are never reused: mermaid.render removes any element that has the id

// By default Mermaid draws every .mermaid element itself on window load, in its own theme. This file draws them,
// so switch that off before the load event can fire.
if (typeof mermaid !== 'undefined') mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

// Called by renderMarkdown after every render and by setTheme after a theme change. Renders every diagram that
// has not been drawn in the current palette yet. Returns a promise that settles when this pass is done.
function renderMermaidDiagrams() {
  if (typeof mermaid === 'undefined') return Promise.resolve();
  // Keep each new diagram's source now, synchronously: once it is drawn the element holds an SVG instead.
  for (const el of document.querySelectorAll('.mermaid')) {
    if (el.dataset.mdvSource === undefined && !el.closest('#diagramOverlay')) el.dataset.mdvSource = el.textContent;
  }
  const generation = ++mdvMermaidGeneration;
  mdvMermaidQueue = mdvMermaidQueue
    .then(() => mdvRenderMermaidPass(generation))
    .catch((err) => console.warn('mermaid:', err));
  return mdvMermaidQueue;
}

async function mdvRenderMermaidPass(generation) {
  const els = [...document.querySelectorAll('.mermaid')].filter((el) => !el.closest('#diagramOverlay'));
  if (!els.length) return;
  const palette = mdvDiagramPalette();
  const todo = els.filter((el) => el.dataset.mdvPalette !== palette.key);
  if (!todo.length) return;
  await mdvDiagramFontsReady();
  if (generation !== mdvMermaidGeneration) return;
  mermaid.initialize(mdvMermaidConfig(palette, mdvDiagramContentWidth()));
  for (const el of todo) {
    if (generation !== mdvMermaidGeneration) return; // a newer pass (a theme change or a new document) takes over
    if (!el.isConnected) continue;
    await mdvRenderDiagram(el, palette);
  }
}

async function mdvRenderDiagram(el, palette) {
  if (el.dataset.mdvSource === undefined) el.dataset.mdvSource = el.textContent; // added after the pass began
  const source = el.dataset.mdvSource;
  const wrapper = el.closest('.mermaid-wrapper');
  const id = 'mdv-mermaid-' + (++mdvMermaidSeq);
  try {
    const { svg, diagramType } = await mermaid.render(id, source);
    if (!el.isConnected) return;
    el.innerHTML = svg;
    const svgEl = el.querySelector('svg');
    if (svgEl) svgEl.classList.add('mdv-diagram');
    el.classList.add('rendered');
    el.classList.remove('mermaid-error');
    el.dataset.mdvPalette = palette.key;
    if (wrapper) {
      wrapper.dataset.diagramType = diagramType || '';
      wrapper.dataset.diagramLabel = mdvDiagramTypeTitle(diagramType);
      mdvMakeDiagramExpandable(wrapper);
      if (typeof mdvLinkDiagramNodes === 'function') mdvLinkDiagramNodes(wrapper);
      if (typeof mdvRefreshDiagramOverlay === 'function') mdvRefreshDiagramOverlay(wrapper);
    }
  } catch (err) {
    if (!el.isConnected) return;
    el.dataset.mdvPalette = palette.key; // the same source fails the same way; retry only in another palette
    mdvShowDiagramError(el, err, source);
  }
}

// A failed diagram shows the reason and keeps its source readable.
function mdvShowDiagramError(el, err, source) {
  el.classList.remove('rendered');
  el.classList.add('mermaid-error');
  const box = document.createElement('div');
  box.className = 'mdv-diagram-error';
  const title = document.createElement('div');
  title.className = 'mdv-diagram-error-title';
  title.textContent = 'This diagram could not be drawn';
  const reason = document.createElement('div');
  reason.className = 'mdv-diagram-error-reason';
  reason.textContent = String((err && err.message) || err || 'Unknown error').trim();
  const code = document.createElement('code');
  code.className = 'mdv-diagram-error-source';
  code.textContent = source;
  box.append(title, reason, code);
  el.replaceChildren(box);
}

// The expand button and a click anywhere on the diagram open the expanded view. A click on a node that links to
// a section is left to that link (enhancements.js).
function mdvMakeDiagramExpandable(wrapper) {
  if (wrapper.dataset.mdvExpandable) return;
  wrapper.dataset.mdvExpandable = '1';
  wrapper.classList.add('is-expandable');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'diagram-expand-btn';
  btn.title = 'Expand diagram';
  btn.setAttribute('aria-label', 'Expand diagram');
  btn.innerHTML = MDV_EXPAND_ICON;
  btn.addEventListener('click', (e) => { e.stopPropagation(); openDiagramOverlay(wrapper); });
  wrapper.prepend(btn);
  wrapper.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-mdv-section], .mermaid-error')) return;
    const selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed && wrapper.contains(selection.anchorNode)) return; // selecting label text
    openDiagramOverlay(wrapper);
  });
}

// The width a diagram has on the page. Mermaid sizes a Gantt chart to its own hidden render container (the whole
// window) unless told otherwise, and the result is then shrunk to the column with unreadably small text.
function mdvDiagramContentWidth() {
  const hosts = [...document.querySelectorAll('#mdBody .mermaid-wrapper'), document.getElementById('mdBody')];
  for (const host of hosts) {
    if (!host) continue;
    const cs = getComputedStyle(host);
    const width = host.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    if (width > 240) return Math.round(width);
  }
  return undefined;
}

// Inter is a web font: measuring labels before it loads would size every box for the fallback font.
async function mdvDiagramFontsReady() {
  if (!document.fonts || !document.fonts.load) return;
  const loads = Promise.all([document.fonts.load('400 14px Inter'), document.fonts.load('600 14px Inter')]).catch(() => {});
  let timer = 0;
  const giveUp = new Promise((resolve) => { timer = setTimeout(resolve, 1500); }); // offline: draw with the fallback font
  await Promise.race([loads, giveUp]);
  clearTimeout(timer);
}

// ---------- Palette: the current theme's --diagram-* tokens, as hex ----------

const MDV_DIAGRAM_TOKENS = {
  bg: '--diagram-bg', text: '--diagram-text', muted: '--diagram-text-muted', line: '--diagram-line',
  node: '--diagram-node', nodeBorder: '--diagram-node-border',
  alt: '--diagram-alt', altBorder: '--diagram-alt-border', third: '--diagram-third', thirdBorder: '--diagram-third-border',
  cluster: '--diagram-cluster', clusterBorder: '--diagram-cluster-border', labelBg: '--diagram-label-bg',
  note: '--diagram-note', noteBorder: '--diagram-note-border', noteText: '--diagram-note-text',
  accent: '--diagram-accent', onAccent: '--diagram-on-accent', grid: '--diagram-grid',
  danger: '--diagram-danger', dangerSoft: '--diagram-danger-soft', seriesText: '--diagram-series-text',
};
const MDV_DIAGRAM_SERIES = 8;

function mdvDiagramPalette() {
  const cs = getComputedStyle(document.documentElement);
  const p = { dark: (typeof currentTheme !== 'undefined' && currentTheme === 'dark'), series: [], seriesSoft: [] };
  for (const [key, prop] of Object.entries(MDV_DIAGRAM_TOKENS)) p[key] = mdvColorHex(cs.getPropertyValue(prop)) || '#888888';
  for (let i = 1; i <= MDV_DIAGRAM_SERIES; i++) {
    p.series.push(mdvColorHex(cs.getPropertyValue('--diagram-series-' + i)) || p.accent);
    p.seriesSoft.push(mdvColorHex(cs.getPropertyValue('--diagram-series-soft-' + i)) || p.node);
  }
  const { series, seriesSoft, dark, ...rest } = p;
  p.key = [dark ? 'dark' : 'light', ...Object.values(rest), ...series, ...seriesSoft].join('|');
  return p;
}

let mdvColorTools = null;
// Any CSS colour (hex, rgb(), color-mix(), a named colour) → "#rrggbb". Hex passes straight through; anything
// else is resolved by the browser on a probe element and read back from a one-pixel canvas.
function mdvColorHex(value) {
  value = String(value || '').trim();
  if (!value) return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return ('#' + value.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  try {
    if (!mdvColorTools) {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.documentElement.appendChild(probe);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      mdvColorTools = { probe, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
    }
    const { probe, ctx } = mdvColorTools;
    probe.style.color = '';
    probe.style.color = value;
    if (!probe.style.color) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(probe).color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return null;
  }
}

// ---------- Mermaid configuration from the palette ----------

function mdvMermaidConfig(p, contentWidth) {
  const s = p.series, soft = p.seriesSoft;
  const themeVariables = {
    darkMode: p.dark,
    background: p.bg,
    fontFamily: MDV_DIAGRAM_FONT,
    fontSize: '14px',
    textColor: p.text,
    lineColor: p.line,
    primaryColor: p.node, primaryBorderColor: p.nodeBorder, primaryTextColor: p.text,
    secondaryColor: p.alt, secondaryBorderColor: p.altBorder, secondaryTextColor: p.text,
    tertiaryColor: p.third, tertiaryBorderColor: p.thirdBorder, tertiaryTextColor: p.text,
    mainBkg: p.node, nodeBorder: p.nodeBorder, nodeTextColor: p.text,
    clusterBkg: p.cluster, clusterBorder: p.clusterBorder, titleColor: p.text,
    edgeLabelBackground: p.labelBg, defaultLinkColor: p.line, arrowheadColor: p.line,
    noteBkgColor: p.note, noteBorderColor: p.noteBorder, noteTextColor: p.noteText,
    errorBkgColor: p.dangerSoft, errorTextColor: p.danger,
    // Sequence
    actorBkg: p.node, actorBorder: p.nodeBorder, actorTextColor: p.text, actorLineColor: p.clusterBorder,
    signalColor: p.line, signalTextColor: p.text, labelBoxBkgColor: p.cluster, labelBoxBorderColor: p.clusterBorder,
    labelTextColor: p.text, loopTextColor: p.muted, activationBkgColor: p.alt, activationBorderColor: p.altBorder,
    sequenceNumberColor: p.onAccent,
    // State
    stateBkg: p.node, stateLabelColor: p.text, labelBackgroundColor: p.labelBg, compositeBackground: p.cluster,
    compositeTitleBackground: p.node, compositeBorder: p.clusterBorder, altBackground: p.cluster,
    transitionColor: p.line, transitionLabelColor: p.muted, specialStateColor: p.line, innerEndBackground: p.line,
    // Class and ER
    classText: p.text, attributeBackgroundColorOdd: p.bg, attributeBackgroundColorEven: p.cluster,
    // Gantt
    sectionBkgColor: soft[0], altSectionBkgColor: p.bg, sectionBkgColor2: soft[1], excludeBkgColor: p.cluster,
    taskBkgColor: s[0], taskBorderColor: s[0], taskTextColor: p.seriesText, taskTextLightColor: p.seriesText,
    taskTextDarkColor: p.text, taskTextOutsideColor: p.text, taskTextClickableColor: p.accent,
    activeTaskBkgColor: soft[1], activeTaskBorderColor: s[1], doneTaskBkgColor: p.cluster, doneTaskBorderColor: p.line,
    critBkgColor: p.danger, critBorderColor: p.danger, gridColor: p.grid, todayLineColor: p.danger,
    // Pie
    pieTitleTextSize: '16px', pieTitleTextColor: p.text, pieSectionTextSize: '13px', pieSectionTextColor: p.seriesText,
    pieLegendTextSize: '13px', pieLegendTextColor: p.text, pieStrokeColor: p.bg, pieStrokeWidth: '2px',
    pieOuterStrokeWidth: '0px', pieOuterStrokeColor: p.bg, pieOpacity: '1',
    // User journey
    fillType0: soft[0], fillType1: soft[1], fillType2: soft[2], fillType3: soft[3],
    fillType4: soft[4], fillType5: soft[5], fillType6: soft[6], fillType7: soft[7],
    // Quadrant chart
    quadrant1Fill: soft[0], quadrant2Fill: soft[1], quadrant3Fill: soft[2], quadrant4Fill: soft[3],
    quadrant1TextFill: p.text, quadrant2TextFill: p.text, quadrant3TextFill: p.text, quadrant4TextFill: p.text,
    quadrantPointFill: p.accent, quadrantPointTextFill: p.text, quadrantXAxisTextFill: p.muted,
    quadrantYAxisTextFill: p.muted, quadrantInternalBorderStrokeFill: p.clusterBorder,
    quadrantExternalBorderStrokeFill: p.clusterBorder, quadrantTitleFill: p.text,
    // XY chart
    xyChart: {
      backgroundColor: p.bg, titleColor: p.text, xAxisLabelColor: p.muted, xAxisTitleColor: p.text,
      xAxisTickColor: p.line, xAxisLineColor: p.line, yAxisLabelColor: p.muted, yAxisTitleColor: p.text,
      yAxisTickColor: p.line, yAxisLineColor: p.line, plotColorPalette: s.join(','),
    },
  };
  for (let i = 0; i < 12; i++) {
    const k = i % MDV_DIAGRAM_SERIES;
    themeVariables['pie' + (i + 1)] = s[k];
    themeVariables['cScale' + i] = soft[k];
    themeVariables['cScaleLabel' + i] = p.text;
    themeVariables['cScalePeer' + i] = s[k];
  }
  for (let i = 0; i < 8; i++) {
    themeVariables['git' + i] = s[i];
    themeVariables['gitBranchLabel' + i] = p.seriesText;
    themeVariables['gitInv' + i] = p.bg;
  }
  themeVariables.commitLabelColor = p.text;
  themeVariables.commitLabelBackground = p.cluster;
  themeVariables.tagLabelColor = p.text;
  themeVariables.tagLabelBackground = p.node;
  themeVariables.tagLabelBorder = p.nodeBorder;

  return {
    startOnLoad: false,
    // Diagram text is document content: Mermaid sanitises labels and ignores click callbacks in strict mode.
    securityLevel: 'strict',
    // On a syntax error Mermaid would otherwise leave its own error graphic at the end of <body>.
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: MDV_DIAGRAM_FONT,
    themeVariables,
    themeCSS: mdvMermaidThemeCss(p),
    flowchart: { curve: 'basis', padding: 18, nodeSpacing: 44, rankSpacing: 56, diagramPadding: 12, htmlLabels: true, useMaxWidth: true },
    sequence: {
      wrap: true, // notes and long messages wrap inside their boxes (known issue 10)
      useMaxWidth: true, mirrorActors: false, width: 150, height: 52, actorMargin: 64, boxMargin: 12,
      boxTextMargin: 8, noteMargin: 14, messageMargin: 40, wrapPadding: 14,
      actorFontFamily: MDV_DIAGRAM_FONT, actorFontSize: 14, actorFontWeight: 600,
      noteFontFamily: MDV_DIAGRAM_FONT, noteFontSize: 13, noteFontWeight: 400,
      messageFontFamily: MDV_DIAGRAM_FONT, messageFontSize: 14, messageFontWeight: 400,
    },
    state: { useMaxWidth: true, padding: 10 },
    class: { useMaxWidth: true },
    er: { useMaxWidth: true, fontSize: 13, entityPadding: 16, minEntityWidth: 110 },
    gantt: {
      useMaxWidth: true, useWidth: contentWidth, barHeight: 24, barGap: 6, topPadding: 56, leftPadding: 90,
      rightPadding: 40, gridLineStartPadding: 40, fontSize: 12, sectionFontSize: 13, numberSectionStyles: 2,
    },
    pie: { useMaxWidth: true, textPosition: 0.68 },
    journey: {
      useMaxWidth: true, leftMargin: 120, width: 140, taskMargin: 36, diagramMarginX: 24,
      taskFontFamily: MDV_DIAGRAM_FONT, taskFontSize: 13, actorColours: s.slice(0, 6), sectionFills: soft, sectionColours: [p.text],
    },
    mindmap: { useMaxWidth: true, padding: 14 },
    timeline: { useMaxWidth: true, padding: 8 },
    gitGraph: { useMaxWidth: true, rotateCommitLabel: false },
    quadrantChart: { useMaxWidth: true },
    xyChart: { useMaxWidth: true },
  };
}

// CSS that Mermaid embeds in each SVG, scoped to that SVG. Anything that changes the size of text belongs here, not
// in viewer.css: Mermaid measures labels before the SVG reaches the page, with only these styles applied.
function mdvMermaidThemeCss(p) {
  const s = p.series, soft = p.seriesSoft;
  let css = `
    text, .label, .nodeLabel, .edgeLabel, .cluster-label, .messageText, .noteText, .actor, .loopText, .labelText,
    .taskText, .sectionTitle, .titleText, .legend, .pieTitleText, .slice { font-family: ${MDV_DIAGRAM_FONT}; }
    .node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1.25px; }
    .node rect.basic, .node rect.label-container, rect.actor, .note, .labelBox { rx: 8px; ry: 8px; }
    .cluster rect { rx: 12px; ry: 12px; stroke-width: 1px; }
    .cluster-label .nodeLabel, .cluster span { font-weight: 600; color: ${p.muted}; }
    .flowchart-link, .edgePath .path, .transition, .relation, .messageLine0, .messageLine1, .actor-line {
      stroke-linecap: round; stroke-linejoin: round; }
    .flowchart-link, .edgePath .path { stroke-width: 1.5px; }
    .edgeLabel, .edgeLabel p, .edgeLabel span { color: ${p.muted}; }
    .edgeLabel rect { opacity: 1; }
    .labelBkg, .edgeLabel .label span { background-color: ${p.labelBg}; background: ${p.labelBg}; }
    text[font-size="4ex"] { font-size: 20px; font-weight: 650; fill: ${p.text}; }
    .actor-line { stroke-dasharray: 3 4; stroke-width: 1px; }
    text.actor > tspan { font-weight: 600; }
    #sequencenumber { fill: ${p.accent}; }
    .sequenceNumber { font-weight: 600; font-size: 11px; }
    .loopLine { stroke-dasharray: 4 3; stroke-width: 1.25px; }
    .stateGroup rect, .statediagram-state rect.basic { rx: 10px; ry: 10px; }
    .stateLabel .box, .edgeLabel .label rect { fill: ${p.labelBg}; }
    .classGroup rect, .er.entityBox, g.classGroup rect { rx: 6px; ry: 6px; }
    .er.relationshipLabelBox { fill: ${p.labelBg}; opacity: 1; }
    marker circle[fill="white"] { fill: ${p.bg}; }
    .pieCircle { stroke: ${p.bg}; stroke-width: 2px; opacity: 1; }
    .pieOuterCircle { stroke: none; }
    .pieTitleText { font-weight: 600; }
    .slice { font-weight: 600; }
    .legend text { fill: ${p.text}; }
    .grid .tick line { stroke: ${p.grid}; }
    .grid .tick text { fill: ${p.muted}; }
    .taskText, .taskTextOutsideRight, .taskTextOutsideLeft { font-weight: 500; }
    .sectionTitle { fill: ${p.text}; font-weight: 600; }
    .task { rx: 5px; ry: 5px; }
    .edge-depth-0 { stroke-width: 7px; } .edge-depth-1 { stroke-width: 4.5px; } .edge-depth-2 { stroke-width: 3px; }
    .edge-depth-3, .edge-depth-4, .edge-depth-5 { stroke-width: 2px; }
  `;
  // Mind maps and timelines colour their branches by section (the first one is section -1); Mermaid's own maths
  // would darken our palette, so each section gets a soft fill and a full-strength edge from the series.
  for (let i = -1; i < 12; i++) {
    const k = (i + 1) % MDV_DIAGRAM_SERIES;
    css += `
    .section-${i} rect, .section-${i} path, .section-${i} circle, .section-${i} polygon { fill: ${soft[k]}; stroke: ${s[k]}; }
    .section-${i} text, .section-${i} span, .section-${i} .nodeLabel { fill: ${p.text}; color: ${p.text}; }
    .section-edge-${i} { stroke: ${s[k]}; }
    .section-${i} line { stroke: ${s[k]}; }
    .node-icon-${i} { color: ${s[k]}; }`;
  }
  // A mind map's root is the accent; it comes last so it wins over its section colour.
  css += `
    .section-root rect, .section-root path, .section-root circle, .section-root polygon { fill: ${p.accent}; stroke: ${p.accent}; }
    .section-root text, .section-root span, .section-root .nodeLabel { fill: ${p.onAccent}; color: ${p.onAccent}; font-weight: 600; }`;
  return css;
}
