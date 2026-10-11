// ============================================
// TTS (Text-to-Speech) Engine
// ============================================
let ttsSections = [];
let ttsCurrentIdx = 0;
let ttsIsPlaying = false;
let ttsUtterance = null;
const ttsRates = [0.75, 1, 1.25, 1.5, 1.75, 2];
let ttsRateIdx = ttsRates.indexOf(mdvStoredRate());
if (ttsRateIdx < 0) ttsRateIdx = 1;
let ttsRate = ttsRates[ttsRateIdx];
let ttsKeepAliveTimer = null;
const isAndroid = /android/i.test(navigator.userAgent);
const ttsSupported = !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function';

// Chrome workaround: speechSynthesis stops after ~15s with Google voices.
// Two strategies: (1) chunk text into short sentences, (2) pause/resume keepalive.
let ttsChunks = [];
let ttsChunkIdx = 0;
let ttsChunksFor = -1;     // the section ttsChunks belong to
// Every cancel bumps the generation. A cancelled utterance still reports 'end' or 'interrupted' later;
// its callbacks carry their own generation and are ignored when it is stale, so a Next, Previous, seek
// or speed change can no longer skip a chunk of the section it just started.
let ttsGen = 0;
let ttsPausedGen = -1;     // the generation paused mid-utterance (desktop), the only one resume() may continue
let ttsFinished = false;   // the last section has been read; Play starts again from the top
let ttsErrors = 0;         // consecutive utterance errors; the browser refusing speech must not race to the end
let ttsReturnFocus = null; // where the focus goes back to when the player closes

// The reading speed is remembered (localStorage mdv-tts-rate); blocked storage means 1x.
function mdvStoredRate() {
  try { return parseFloat(localStorage.getItem('mdv-tts-rate')) || 1; } catch (_) { return 1; }
}

// ============================================
// What is read: sections of speakable text
// ============================================
// Block-level elements end a spoken phrase; table cells are separated by commas.
const TTS_PHRASE_END = new Set(['P', 'LI', 'TR', 'DT', 'DD', 'DIV', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'SUMMARY',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'DL', 'TABLE', 'SECTION', 'DETAILS']);
const TTS_TABLE_LIMIT = 300;

// The words a listener should hear for a block: its text without the viewer's controls and copies
// (see mdvExcludedFromText), a pause between list items, rows and paragraphs, images by their alt
// text, and each formula once. A diagram, table or code block inside it (in a list item, a quote, a
// callout, <details>) is read as it is at the top level (ttsSpecialBlock).
function mdvSpeakableText(el) {
  const parts = [];
  (function walk(node) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { parts.push(c.nodeValue.replace(/\s+/g, ' ')); continue; } // source line breaks are spaces
      if (c.nodeType !== 1 || mdvExcludedFromText(c)) continue;
      const special = ttsSpecialBlock(c);
      if (special) { if (special.text) parts.push(`\n${special.text}\n`); continue; }
      if (c.tagName === 'IMG') { if (c.alt) parts.push(`\nImage: ${c.alt}.\n`); continue; }
      if (c.getAttribute('role') === 'img') { const l = c.getAttribute('aria-label'); if (l) parts.push(`\nImage: ${l}.\n`); continue; }
      if (c.tagName === 'BR') { parts.push('\n'); continue; }
      walk(c);
      if (c.tagName === 'TD' || c.tagName === 'TH') parts.push(', ');
      else if (TTS_PHRASE_END.has(c.tagName)) parts.push('\n');
    }
  })(el);
  return parts.join('')
    .replace(/[^\S\n]+/g, ' ')      // one space; newlines are the phrase ends pushed above
    .replace(/ *, *(?=\n|$)/g, '')   // no comma before a phrase end (the last cell of a row)
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// The blocks that are not read as their text, wherever they sit: at the top level, in a section, or
// nested in a list item, a quote, a callout or <details>. A diagram is read as its narration or skipped
// (its SVG holds a stylesheet and node labels, not prose); a table as its narration or by rows; a code
// block as "Code block in python." Returns null for every other element.
function ttsSpecialBlock(el) {
  if (el.classList.contains('mermaid-wrapper')) {
    const narr = findNarrationFor(el);
    return narr ? { type: 'narration', text: narr } : { type: 'skip', text: '' };
  }
  if (el.tagName === 'TABLE') {
    const narr = findNarrationFor(el);
    return narr ? { type: 'narration', text: narr } : { type: 'table', text: ttsTableText(el) };
  }
  if (el.tagName === 'PRE') {
    const lang = (el.querySelector('.code-header span') || {}).textContent;
    return { type: 'code', text: lang && lang !== 'text' ? `Code block in ${lang}.` : 'Code block.' };
  }
  return null;
}

// A table is read as its rows, cells separated by commas, up to about 300 characters, then how many
// rows were left out.
function ttsTableText(table) {
  const rows = [...table.rows];
  let out = '';
  let read = 0;
  for (const row of rows) {
    const line = mdvSpeakableText(row).replace(/\n/g, ' ');
    if (!line) continue;
    if (out && out.length + line.length > TTS_TABLE_LIMIT) break;
    out += line + '.\n';
    read++;
  }
  const left = rows.length - read;
  return out + (left > 0 ? `And ${left} more row${left === 1 ? '' : 's'}.` : '');
}

// The frontmatter dashboard is a row of badges with no spaces between them; read each badge as its
// own phrase ("Draft. 2026-10-04. 42 Requests."), without the status dot.
function ttsDashboardText(el) {
  const phrases = [...el.querySelectorAll('.fm-status-badge, .fm-date, .fm-metric, .fm-repo-badge')]
    .map(b => [...(b.childElementCount ? b.children : [b])].map(c => c.textContent.replace(/[●○★]/g, '').trim()).filter(Boolean).join(' '))
    .filter(Boolean);
  return phrases.length ? phrases.join('.\n') + '.' : '';
}

// renderMarkdown calls this on every render. The sections are built now only while the player is in
// use (open, reading or paused), so a re-render keeps the listener's place; otherwise they are built
// when the player opens. Most renders are never read aloud, and building them for a large document
// takes tens of milliseconds.
let ttsStale = true;
function buildTtsSections() {
  const inUse = document.getElementById('ttsPlayer').classList.contains('show') || ttsIsPlaying || ttsPausedGen === ttsGen;
  if (inUse) { ttsBuildSections(); return; }
  ttsSections = [];
  ttsCurrentIdx = 0;
  ttsStale = true;
}

function ttsEnsureSections() {
  if (ttsStale) ttsBuildSections();
}

function ttsBuildSections() {
  const before = ttsSections[ttsCurrentIdx];
  ttsSections = [];
  ttsStale = false;

  // Walk top-level children and section-content children
  function extractText(container) {
    const items = [];
    for (const child of container.children) {
      if (mdvExcludedFromText(child)) continue; // the minimap, chips, buttons: not the author's words
      if (child.classList.contains('fm-dashboard')) {
        const t = ttsDashboardText(child);
        if (t) items.push({ type: 'text', text: t, element: child });
      } else if (/^H[1-6]$/.test(child.tagName)) {
        items.push({ type: 'heading', text: mdvHeadingText(child), element: child });
      } else if (child.classList.contains('section-content')) {
        items.push(...extractText(child));
      } else {
        const special = ttsSpecialBlock(child); // a diagram, table or code block
        if (special) { items.push({ ...special, element: child }); continue; }
        const t = mdvSpeakableText(child);
        if (t.length > 0) items.push({ type: 'text', text: t, element: child });
      }
    }
    return items;
  }

  const raw = extractText(document.getElementById('mdBody'));

  // Group into sections (heading + following content)
  let current = { heading: 'Introduction', items: [], elements: [] };
  for (const item of raw) {
    if (item.type === 'heading') {
      if (current.items.length > 0) ttsSections.push(current);
      current = { heading: item.text, items: [], elements: [] };
      current.items.push(item.text + '.');
      current.elements.push(item.element);
    } else if (item.type === 'skip') {
      // skip diagrams without narration
    } else {
      current.items.push(item.text);
      current.elements.push(item.element);
    }
  }
  if (current.items.length > 0) ttsSections.push(current);
  ttsReconcile(before);
}

// After a re-render (a comment added, another document opened), keep the listener's place when the
// section still exists, and stop when it does not. Before, reading carried on at the old index in
// whatever the new section list was.
function ttsReconcile(before) {
  const active = ttsIsPlaying || ttsPausedGen === ttsGen;
  ttsChunksFor = -1;
  let idx = -1;
  if (before) {
    idx = ttsSections[ttsCurrentIdx] && ttsSections[ttsCurrentIdx].heading === before.heading
      ? ttsCurrentIdx : ttsSections.findIndex(s => s.heading === before.heading);
  }
  if (idx < 0) {
    if (active) ttsHalt();
    ttsCurrentIdx = 0;
    ttsFinished = false;
  } else {
    ttsCurrentIdx = idx;
    if (active) {
      // Reading carries on through the rest of this section's chunks, then on through the new list.
      ttsChunksFor = idx;
      clearTtsHighlights();
      ttsSections[idx].elements.forEach(el => el && el.classList.add('tts-active'));
    }
  }
  updateTtsUI();
}

function findNarrationFor(element) {
  // The narration is an HTML comment right before the block: <!-- narrate: ... -->. markdown-it keeps
  // it as a DOM comment node, and section folding keeps it next to its block. Text and other comments
  // in between (for example a comment-thread anchor) are stepped over; any element ends the search.
  for (let node = element.previousSibling; node && node.nodeType !== 1; node = node.previousSibling) {
    if (node.nodeType === 8) {
      const text = node.textContent.trim();
      if (text.toLowerCase().startsWith('narrate:')) return text.slice(8).trim();
    }
  }
  return null;
}

// ============================================
// The player
// ============================================
function ttsToggle() {
  const player = document.getElementById('ttsPlayer');
  if (player.classList.contains('show')) {
    ttsStop();
    return;
  }
  ttsEnsureSections();
  player.classList.add('show');
  document.documentElement.style.setProperty('--tts-height', '64px');
  ttsSetToggleExpanded(true);
  updateTtsUI();
  // Opened from the keyboard or the Listen button: the focus moves to Play, so Space starts reading.
  ttsReturnFocus = player.contains(document.activeElement) ? null : document.activeElement;
  const play = document.getElementById('ttsPlayBtn');
  if (!play.disabled) play.focus({ preventScroll: true });
}

function ttsPlayPause() {
  ttsEnsureSections();
  if (!ttsSections.length) return;
  if (ttsIsPlaying) {
    ttsPause();
  } else {
    ttsPlay();
  }
}

function ttsPlay() {
  ttsEnsureSections();
  if (!ttsSupported || !ttsSections.length) return;
  ttsErrors = 0;
  ttsIsPlaying = true;
  updateTtsPlayIcon();
  if (ttsPausedGen === ttsGen && speechSynthesis.paused && speechSynthesis.speaking) {
    ttsPausedGen = -1;
    speechSynthesis.resume();
    ttsStartKeepAlive();
    return;
  }
  ttsPausedGen = -1;
  // Starting afresh: drop anything queued, and clear a paused flag the browser can keep after a
  // cancel, or nothing would ever play (pause, then Next, then Play used to stay silent).
  ttsCancel();
  if (speechSynthesis.paused) speechSynthesis.resume();
  if (ttsFinished) { ttsFinished = false; ttsCurrentIdx = 0; ttsChunksFor = -1; }
  if (ttsChunksFor === ttsCurrentIdx && ttsChunkIdx < ttsChunks.length) speakNextChunk(); // continue the section
  else speakSection(ttsCurrentIdx);
}

function speakSection(idx) {
  if (idx >= ttsSections.length) {
    ttsIsPlaying = false;
    ttsFinished = true;
    updateTtsPlayIcon();
    updateTtsUI();
    return;
  }
  ttsCurrentIdx = idx;
  const section = ttsSections[idx];

  // Highlight elements
  clearTtsHighlights();
  section.elements.forEach(el => el?.classList.add('tts-active'));

  // Scroll to first element, unfolding its section first
  if (section.elements[0]) {
    mdvReveal(section.elements[0]);
    section.elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Chunk text into sentences for Chrome workaround
  const fullText = section.items.join('\n');
  ttsChunks = chunkText(fullText, 180); // ~180 chars per chunk
  ttsChunkIdx = 0;
  ttsChunksFor = idx;

  updateTtsUI();
  speakNextChunk();
}

function chunkText(text, maxLen) {
  const chunks = [];
  // Split by sentence boundaries
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [''];
}

function ttsStartKeepAlive() {
  ttsStopKeepAlive();
  if (isAndroid) return; // Android treats pause() as cancel
  ttsKeepAliveTimer = setInterval(() => {
    if (!speechSynthesis.speaking) { ttsStopKeepAlive(); return; }
    speechSynthesis.pause();
    speechSynthesis.resume();
  }, 12000); // Must be under 15s (Chrome bug)
}

function ttsStopKeepAlive() {
  if (ttsKeepAliveTimer) { clearInterval(ttsKeepAliveTimer); ttsKeepAliveTimer = null; }
}

// Stops the current utterance and everything queued, and makes their late events stale.
function ttsCancel() {
  ttsGen++;
  ttsStopKeepAlive();
  if (ttsSupported) speechSynthesis.cancel();
}

// Stops reading but keeps the player and the position.
function ttsHalt() {
  ttsCancel();
  ttsIsPlaying = false;
  ttsPausedGen = -1;
  clearTtsHighlights();
  updateTtsPlayIcon();
}

function speakNextChunk() {
  if (!ttsIsPlaying) return;
  if (ttsChunkIdx >= ttsChunks.length) {
    ttsStopKeepAlive();
    clearTtsHighlights();
    speakSection(ttsCurrentIdx + 1);
    return;
  }

  ttsCancel(); // Clear any pending
  const gen = ttsGen;
  ttsUtterance = new SpeechSynthesisUtterance(ttsChunks[ttsChunkIdx]);
  ttsUtterance.rate = ttsRate;
  ttsUtterance.onend = () => {
    if (gen !== ttsGen) return;
    ttsErrors = 0;
    ttsChunkIdx++;
    if (ttsSections.length > 0) {
      const sectionProgress = ttsChunks.length > 1 ? ttsChunkIdx / ttsChunks.length : 1;
      const overall = (ttsCurrentIdx + sectionProgress) / ttsSections.length;
      document.getElementById('ttsProgressFill').style.width = (overall * 100) + '%';
    }
    speakNextChunk();
  };
  ttsUtterance.onerror = (e) => {
    if (gen !== ttsGen) return;
    // A cancel this code did not make (another script on the page): stop, so the player does not show
    // Pause while nothing plays.
    if (e.error === 'canceled' || e.error === 'interrupted') { ttsHalt(); return; }
    // The browser refused to speak (no user gesture yet, no voice): stop and say so, rather than
    // skipping through every chunk of the document in a few milliseconds.
    if (e.error === 'not-allowed' || ++ttsErrors >= 3) {
      ttsHalt();
      ttsSetStatus(e.error === 'not-allowed' ? 'The browser blocked speech. Press Play to try again.' : 'Speech failed. Press Play to try again.');
      return;
    }
    ttsChunkIdx++;
    speakNextChunk();
  };
  speechSynthesis.speak(ttsUtterance);
  ttsStartKeepAlive();
}

function ttsPause() {
  ttsStopKeepAlive();
  if (isAndroid) {
    // Android: pause = cancel. Play speaks the interrupted chunk again.
    ttsCancel();
    ttsPausedGen = -1;
  } else {
    speechSynthesis.pause();
    ttsPausedGen = ttsGen;
  }
  ttsIsPlaying = false;
  updateTtsPlayIcon();
}

function ttsStop() {
  ttsCancel();
  ttsIsPlaying = false;
  ttsPausedGen = -1;
  ttsFinished = false;
  ttsCurrentIdx = 0;
  ttsChunksFor = -1;
  clearTtsHighlights();
  const player = document.getElementById('ttsPlayer');
  const hadFocus = player.contains(document.activeElement);
  player.classList.remove('show');
  document.documentElement.style.setProperty('--tts-height', '0px');
  ttsSetToggleExpanded(false);
  updateTtsPlayIcon();
  updateTtsUI();
  if (hadFocus) {
    const back = ttsReturnFocus && ttsReturnFocus.isConnected && ttsReturnFocus !== document.body
      ? ttsReturnFocus : document.getElementById('ttsToggleBtn');
    if (back && back.getClientRects().length) back.focus({ preventScroll: true });
  }
  ttsReturnFocus = null;
}

// Clean up on page unload to avoid orphaned speech
window.addEventListener('beforeunload', () => { ttsStopKeepAlive(); if (ttsSupported) speechSynthesis.cancel(); });

// Moves to a section. Playing: reads it from its start. Paused or stopped: moves the cursor there
// (highlight, scroll, label) and Play starts from it.
function ttsGoTo(idx) {
  ttsEnsureSections();
  if (!ttsSections.length) return;
  idx = Math.max(0, Math.min(ttsSections.length - 1, idx));
  ttsCancel();
  ttsPausedGen = -1;
  ttsFinished = false;
  clearTtsHighlights();
  speakSection(idx);
}

function ttsNext() {
  // On the last section there is nothing to skip to; it keeps reading instead of falling silent.
  if (ttsCurrentIdx < ttsSections.length - 1) ttsGoTo(ttsCurrentIdx + 1);
}

function ttsPrev() {
  ttsGoTo(ttsCurrentIdx > 0 ? ttsCurrentIdx - 1 : 0);
}

function ttsCycleSpeed() {
  ttsRateIdx = (ttsRateIdx + 1) % ttsRates.length;
  ttsRate = ttsRates[ttsRateIdx];
  try { localStorage.setItem('mdv-tts-rate', String(ttsRate)); } catch (_) { /* storage blocked: not remembered */ }
  updateTtsSpeedLabel();
  if (ttsIsPlaying) speakNextChunk(); // the current chunk again, at the new rate
}

function ttsSeekClick(e) {
  const bar = document.getElementById('ttsProgressBar');
  const r = bar.getBoundingClientRect();
  const idx = Math.floor(((e.clientX - r.left) / r.width) * ttsSections.length);
  if (idx >= 0 && idx < ttsSections.length) {
    ttsIsPlaying = ttsSupported;
    updateTtsPlayIcon();
    ttsGoTo(idx);
  }
}

// The progress bar is a slider over sections: arrow keys step one section, Page Up/Down a tenth of the
// document, Home/End the first and last. Like Previous and Next, it keeps playing if it was playing.
function ttsSliderKeys(e) {
  const n = ttsSections.length;
  if (!n) return;
  const step = Math.max(1, Math.round(n / 10));
  const to = { ArrowRight: ttsCurrentIdx + 1, ArrowUp: ttsCurrentIdx + 1, ArrowLeft: ttsCurrentIdx - 1,
               ArrowDown: ttsCurrentIdx - 1, PageUp: ttsCurrentIdx + step, PageDown: ttsCurrentIdx - step,
               Home: 0, End: n - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  ttsGoTo(to);
}

function updateTtsUI() {
  const section = ttsSections[ttsCurrentIdx];
  const n = ttsSections.length;
  ttsSetStatus(!ttsSupported ? 'Read aloud needs speech support, which this browser does not have.'
    : section ? `${ttsCurrentIdx + 1}/${n}: ${section.heading}` : 'Ready');
  const pct = n ? ((ttsFinished ? n : ttsCurrentIdx) / n * 100) : 0;
  document.getElementById('ttsProgressFill').style.width = pct + '%';
  const bar = document.getElementById('ttsProgressBar');
  bar.setAttribute('aria-valuemax', String(Math.max(1, n)));
  bar.setAttribute('aria-valuenow', String(n ? ttsCurrentIdx + 1 : 1));
  bar.setAttribute('aria-valuetext', section ? `Section ${ttsCurrentIdx + 1} of ${n}: ${section.heading}` : 'No sections');
  const next = document.getElementById('ttsNextBtn');
  if (next) next.setAttribute('aria-disabled', String(!n || ttsCurrentIdx >= n - 1));
}

function ttsSetStatus(text) {
  document.getElementById('ttsSectionLabel').textContent = text;
}

function updateTtsPlayIcon() {
  document.getElementById('ttsPlayIcon').style.display = ttsIsPlaying ? 'none' : '';
  document.getElementById('ttsPauseIcon').style.display = ttsIsPlaying ? '' : 'none';
  document.getElementById('ttsPlayBtn').setAttribute('aria-label', ttsIsPlaying ? 'Pause' : 'Play');
}

function updateTtsSpeedLabel() {
  const btn = document.getElementById('ttsSpeedBtn');
  btn.textContent = ttsRate + 'x';
  btn.setAttribute('aria-label', `Speed ${ttsRate}x`);
}

function ttsSetToggleExpanded(open) {
  const btn = document.getElementById('ttsToggleBtn');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

function clearTtsHighlights() {
  document.querySelectorAll('.tts-active').forEach(el => el.classList.remove('tts-active'));
}

// Names, roles and keyboard access for the player's controls, set once.
(function wireTtsPlayer() {
  const player = document.getElementById('ttsPlayer');
  player.setAttribute('role', 'region');
  player.setAttribute('aria-label', 'Read aloud');
  const [prev, play, next] = player.querySelectorAll('.tts-btn');
  if (prev) { prev.id = prev.id || 'ttsPrevBtn'; prev.setAttribute('aria-label', 'Previous section'); }
  if (next) { next.id = next.id || 'ttsNextBtn'; next.setAttribute('aria-label', 'Next section'); }
  const close = player.querySelector('.tts-close');
  if (close) close.setAttribute('aria-label', 'Close the player');
  const bar = document.getElementById('ttsProgressBar');
  bar.setAttribute('role', 'slider');
  bar.tabIndex = 0;
  bar.setAttribute('aria-label', 'Section');
  bar.setAttribute('aria-valuemin', '1');
  bar.addEventListener('keydown', ttsSliderKeys);
  const toggle = document.getElementById('ttsToggleBtn');
  if (toggle) { toggle.setAttribute('aria-controls', 'ttsPlayer'); toggle.setAttribute('aria-expanded', 'false'); }
  if (!ttsSupported) {
    [prev, play, next, document.getElementById('ttsSpeedBtn')].forEach(b => { if (b) b.disabled = true; });
    bar.setAttribute('aria-disabled', 'true');
  }
  updateTtsSpeedLabel();
  updateTtsPlayIcon();
  updateTtsUI();
})();
