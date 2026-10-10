// ============================================
// TTS (Text-to-Speech) Engine
// ============================================
let ttsSections = [];
let ttsCurrentIdx = 0;
let ttsIsPlaying = false;
let ttsRate = 1.0;
let ttsUtterance = null;
const ttsRates = [0.75, 1, 1.25, 1.5, 1.75, 2];
let ttsRateIdx = 1;
let ttsKeepAliveTimer = null;
const isAndroid = /android/i.test(navigator.userAgent);

// Chrome workaround: speechSynthesis stops after ~15s with Google voices.
// Two strategies: (1) chunk text into short sentences, (2) pause/resume keepalive.
let ttsChunks = [];
let ttsChunkIdx = 0;

function buildTtsSections() {
  ttsSections = [];
  const body = document.getElementById('mdBody');
  const narrations = window._narrations || [];

  // Walk top-level children and section-content children
  function extractText(container) {
    const items = [];
    for (const child of container.children) {
      if (/^H[1-6]$/.test(child.tagName)) {
        items.push({ type: 'heading', text: child.textContent.replace(/#/g, '').trim(), element: child });
      } else if (child.classList.contains('section-content')) {
        items.push(...extractText(child));
      } else if (child.classList.contains('mermaid-wrapper')) {
        // Check for narration
        const narr = findNarrationFor(child);
        if (narr) items.push({ type: 'narration', text: narr, element: child });
        else items.push({ type: 'skip', text: '[diagram]', element: child });
      } else if (child.tagName === 'PRE') {
        items.push({ type: 'code', text: 'Code block: ' + (child.querySelector('.code-header span')?.textContent || ''), element: child });
      } else if (child.tagName === 'TABLE') {
        const narr = findNarrationFor(child);
        if (narr) items.push({ type: 'narration', text: narr, element: child });
        else items.push({ type: 'table', text: child.textContent.trim().slice(0, 300), element: child });
      } else {
        const t = child.textContent.trim();
        if (t.length > 0) items.push({ type: 'text', text: t, element: child });
      }
    }
    return items;
  }

  const raw = extractText(body);

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
}

function findNarrationFor(element) {
  // Walk backward through raw markdown narrations
  // Check HTML comment nodes before this element
  const narrations = window._narrations || [];
  if (!narrations.length) return null;

  // Simple heuristic: check if the element's previous sibling is a comment node
  // or look in raw markdown for <!-- narrate: --> before mermaid blocks
  // Since HTML comments become DOM comment nodes:
  let node = element.previousSibling;
  while (node) {
    if (node.nodeType === 8) { // Comment node
      const text = node.textContent.trim();
      if (text.toLowerCase().startsWith('narrate:')) {
        return text.slice(8).trim();
      }
    }
    if (node.nodeType === 1) break; // Stop at previous element
    node = node.previousSibling;
  }

  // Also check parent's previous sibling for section-wrapped content
  if (element.parentElement?.classList.contains('section-content')) {
    node = element.parentElement.previousSibling;
    while (node) {
      if (node.nodeType === 8) {
        const text = node.textContent.trim();
        if (text.toLowerCase().startsWith('narrate:')) return text.slice(8).trim();
      }
      if (node.nodeType === 1) break;
      node = node.previousSibling;
    }
  }

  return null;
}

function ttsToggle() {
  const player = document.getElementById('ttsPlayer');
  if (player.classList.contains('show')) {
    ttsStop();
  } else {
    player.classList.add('show');
    document.documentElement.style.setProperty('--tts-height', '64px');
    updateTtsUI();
  }
}

function ttsPlayPause() {
  if (!ttsSections.length) return;
  if (ttsIsPlaying) {
    ttsPause();
  } else {
    ttsPlay();
  }
}

function ttsPlay() {
  if (!ttsSections.length) return;
  if (speechSynthesis.paused) {
    speechSynthesis.resume();
    ttsIsPlaying = true;
    updateTtsPlayIcon();
    return;
  }

  ttsIsPlaying = true;
  updateTtsPlayIcon();
  speakSection(ttsCurrentIdx);
}

function speakSection(idx) {
  if (idx >= ttsSections.length) {
    ttsIsPlaying = false;
    updateTtsPlayIcon();
    return;
  }
  ttsCurrentIdx = idx;
  const section = ttsSections[idx];

  // Highlight elements
  clearTtsHighlights();
  section.elements.forEach(el => el?.classList.add('tts-active'));

  // Scroll to first element
  if (section.elements[0]) {
    section.elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Chunk text into sentences for Chrome workaround
  const fullText = section.items.join(' ');
  ttsChunks = chunkText(fullText, 180); // ~180 chars per chunk
  ttsChunkIdx = 0;

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

function speakNextChunk() {
  if (!ttsIsPlaying) return;
  if (ttsChunkIdx >= ttsChunks.length) {
    ttsStopKeepAlive();
    clearTtsHighlights();
    speakSection(ttsCurrentIdx + 1);
    return;
  }

  speechSynthesis.cancel(); // Clear any pending
  ttsUtterance = new SpeechSynthesisUtterance(ttsChunks[ttsChunkIdx]);
  ttsUtterance.rate = ttsRate;
  ttsUtterance.onend = () => {
    ttsChunkIdx++;
    if (ttsSections.length > 0) {
      const sectionProgress = ttsChunks.length > 1 ? ttsChunkIdx / ttsChunks.length : 1;
      const overall = (ttsCurrentIdx + sectionProgress) / ttsSections.length;
      document.getElementById('ttsProgressFill').style.width = (overall * 100) + '%';
    }
    speakNextChunk();
  };
  ttsUtterance.onerror = (e) => {
    if (e.error !== 'canceled') { ttsChunkIdx++; speakNextChunk(); }
  };
  speechSynthesis.speak(ttsUtterance);
  ttsStartKeepAlive();
}

function ttsPause() {
  ttsStopKeepAlive();
  if (isAndroid) {
    // Android: pause = cancel, so we just track position
    speechSynthesis.cancel();
  } else {
    speechSynthesis.pause();
  }
  ttsIsPlaying = false;
  updateTtsPlayIcon();
}

function ttsStop() {
  ttsStopKeepAlive();
  speechSynthesis.cancel();
  ttsIsPlaying = false;
  ttsCurrentIdx = 0;
  clearTtsHighlights();
  document.getElementById('ttsPlayer').classList.remove('show');
  document.documentElement.style.setProperty('--tts-height', '0px');
  updateTtsPlayIcon();
}

// Clean up on page unload to avoid orphaned speech
window.addEventListener('beforeunload', () => { ttsStopKeepAlive(); speechSynthesis.cancel(); });

function ttsNext() {
  ttsStopKeepAlive(); speechSynthesis.cancel(); clearTtsHighlights();
  if (ttsCurrentIdx < ttsSections.length - 1) speakSection(ttsCurrentIdx + 1);
}

function ttsPrev() {
  ttsStopKeepAlive(); speechSynthesis.cancel(); clearTtsHighlights();
  speakSection(ttsCurrentIdx > 0 ? ttsCurrentIdx - 1 : 0);
}

function ttsCycleSpeed() {
  ttsRateIdx = (ttsRateIdx + 1) % ttsRates.length;
  ttsRate = ttsRates[ttsRateIdx];
  document.getElementById('ttsSpeedBtn').textContent = ttsRate + 'x';
  if (ttsIsPlaying) { ttsStopKeepAlive(); speechSynthesis.cancel(); speakNextChunk(); }
}

function ttsSeekClick(e) {
  const bar = document.getElementById('ttsProgressBar');
  const pct = e.offsetX / bar.clientWidth;
  const idx = Math.floor(pct * ttsSections.length);
  if (idx >= 0 && idx < ttsSections.length) {
    speechSynthesis.cancel();
    clearTtsHighlights();
    ttsIsPlaying = true;
    updateTtsPlayIcon();
    speakSection(idx);
  }
}

function updateTtsUI() {
  const section = ttsSections[ttsCurrentIdx];
  document.getElementById('ttsSectionLabel').textContent = section
    ? `${ttsCurrentIdx + 1}/${ttsSections.length}: ${section.heading}`
    : 'Ready';
  const pct = ttsSections.length ? (ttsCurrentIdx / ttsSections.length * 100) : 0;
  document.getElementById('ttsProgressFill').style.width = pct + '%';
}

function updateTtsPlayIcon() {
  document.getElementById('ttsPlayIcon').style.display = ttsIsPlaying ? 'none' : '';
  document.getElementById('ttsPauseIcon').style.display = ttsIsPlaying ? '' : 'none';
}

function clearTtsHighlights() {
  document.querySelectorAll('.tts-active').forEach(el => el.classList.remove('tts-active'));
}

