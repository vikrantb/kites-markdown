// ============================================
const CALLOUT_TYPES = {
  NOTE:      { icon: 'ℹ',  label: 'Note' },
  TIP:       { icon: '💡', label: 'Tip' },
  IMPORTANT: { icon: '❗', label: 'Important' },
  WARNING:   { icon: '⚠',  label: 'Warning' },
  CAUTION:   { icon: '🔴', label: 'Caution' },
  TLDR:      { icon: '📌', label: 'TL;DR' },
  DECISION:  { icon: '🏛',  label: 'Decision' },
  COST:      { icon: '💰', label: 'Cost' },
};

function transformCalloutBlocks() {
  const body = document.getElementById('mdBody');
  body.querySelectorAll('blockquote').forEach(bq => {
    const firstP = bq.querySelector('p');
    if (!firstP) return;
    const text = firstP.innerHTML;
    const match = text.match(/^\[!(\w+)\]\s*/);
    if (!match) return;
    const type = match[1].toUpperCase();
    const info = CALLOUT_TYPES[type];
    if (!info) return;

    // Remove the [!TYPE] marker from text
    firstP.innerHTML = text.replace(/^\[!\w+\]\s*/, '');

    // Convert blockquote to callout
    bq.className = `callout callout-${type.toLowerCase()}`;
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.innerHTML = `${info.icon} ${info.label}`;
    bq.insertBefore(title, bq.firstChild);
  });
}

// ============================================
// Section Minimap
// ============================================
function buildSectionMinimap() {
  const body = document.getElementById('mdBody');
  const h2s = body.querySelectorAll('h2');
  if (h2s.length < 3) return; // Only show for docs with 3+ sections

  const minimap = document.createElement('div');
  minimap.className = 'section-minimap';

  h2s.forEach(h => {
    const btn = document.createElement('button');
    btn.className = 'minimap-segment';
    btn.textContent = h.textContent.replace(/#/g, '').trim();
    btn.dataset.targetId = h.id;
    btn.onclick = () => h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    minimap.appendChild(btn);
  });

  // Insert after first h1 or at top
  const h1 = body.querySelector('h1');
  const dashboard = body.querySelector('.fm-dashboard');
  const insertAfter = dashboard || h1;
  if (insertAfter && insertAfter.nextSibling) {
    insertAfter.parentNode.insertBefore(minimap, insertAfter.nextSibling);
  } else {
    body.insertBefore(minimap, body.firstChild);
  }

  // Update minimap on scroll
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        minimap.querySelectorAll('.minimap-segment').forEach(seg => {
          seg.classList.toggle('active', seg.dataset.targetId === entry.target.id);
        });
      }
    });
  }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });

  h2s.forEach(h => observer.observe(h));
}

// ============================================
// Abbreviation Tooltips from frontmatter
// ============================================
function applyAbbreviationTooltips(meta) {
  if (!meta || !meta.abbreviations) return;
  const abbrs = meta.abbreviations;
  if (typeof abbrs !== 'object' || Array.isArray(abbrs)) return;

  const body = document.getElementById('mdBody');
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      // Skip code, pre, script elements
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (['CODE', 'PRE', 'SCRIPT', 'STYLE'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.classList.contains('callout-title')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  // Sort abbreviation keys by length (longest first) to avoid partial matches
  const keys = Object.keys(abbrs).sort((a, b) => b.length - a.length);
  const pattern = new RegExp('\\b(' + keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'g');

  for (const node of textNodes) {
    const text = node.textContent;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      const abbr = document.createElement('abbr');
      abbr.className = 'abbr-tooltip';
      abbr.title = abbrs[m[1]];
      abbr.textContent = m[1];
      frag.appendChild(abbr);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    if (lastIdx > 0) node.parentNode.replaceChild(frag, node);
  }
}

// ============================================
// Mermaid Click-to-Section
// ============================================
function setupMermaidClickToSection() {
  const body = document.getElementById('mdBody');
  const headings = body.querySelectorAll('h1,h2,h3,h4,h5,h6');
  const slugMap = {};
  headings.forEach(h => {
    const slug = h.textContent.replace(/#/g, '').trim().toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    slugMap[slug] = h;
    // Also map simple words
    const words = h.textContent.replace(/#/g, '').trim().toLowerCase().split(/\s+/);
    words.forEach(w => { if (w.length > 3 && !slugMap[w]) slugMap[w] = h; });
  });

  body.querySelectorAll('.mermaid-wrapper svg .node, .mermaid-wrapper svg .nodeLabel, .mermaid-wrapper svg g[id]').forEach(node => {
    const text = (node.textContent || '').trim().toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    const target = slugMap[text];
    if (target) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Flash highlight
        target.style.background = 'var(--bg-tts-highlight)';
        setTimeout(() => { target.style.background = ''; }, 2000);
      });
    }
  });
}

