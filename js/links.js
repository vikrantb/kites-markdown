// ============================================
// Link enhancement
// ============================================
const LINK_TYPES = {
  github:  { label: 'GitHub', icon: '&#9733;', color: 'var(--text-primary)' },
  npm:     { label: 'npm', icon: '&#9634;', color: '#cb3837' },
  docs:    { label: 'Docs', icon: '&#128214;', color: 'var(--accent-secondary)' },
  email:   { label: 'Email', icon: '&#9993;', color: 'var(--accent-warn)' },
  anchor:  { label: 'Section', icon: '&#167;', color: 'var(--accent)' },
  file:    { label: 'File', icon: '&#128196;', color: 'var(--text-secondary)' },
  external:{ label: 'External', icon: '&#8599;', color: 'var(--text-link)' },
};

function detectLinkType(href) {
  if (!href) return 'external';
  if (href.startsWith('#')) return 'anchor';
  if (href.startsWith('mailto:')) return 'email';
  if (/\.(md|txt|pdf|doc|csv|json|yaml|yml)$/i.test(href)) return 'file';
  if (/github\.com|gitlab\.com/i.test(href)) return 'github';
  if (/npmjs\.com|npm\.im/i.test(href)) return 'npm';
  if (/docs\.|documentation|readme|wiki|\.dev|\.io\/docs/i.test(href)) return 'docs';
  return 'external';
}

function enhanceLinks() {
  const body = document.getElementById('mdBody');
  const allLinks = [];

  body.querySelectorAll('a:not(.header-anchor)').forEach(a => {
    const href = a.getAttribute('href') || '';
    const type = detectLinkType(href);

    // Set data attribute — CSS handles the icon via ::after (no DOM injection)
    a.dataset.linkType = type;

    // External links: open in new tab
    if (type !== 'anchor' && type !== 'file' && href.startsWith('http')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }

    // Collect for links panel
    allLinks.push({ href, text: a.textContent.trim(), type, element: a });

    // Tooltip on hover
    a.addEventListener('mouseenter', (e) => showLinkTooltip(e, a, href, type));
    a.addEventListener('mouseleave', hideLinkTooltip);
  });

  // Convert standalone links (sole child of a <p>) into link chips
  body.querySelectorAll('p').forEach(p => {
    const children = Array.from(p.childNodes).filter(n =>
      n.nodeType !== 3 || n.textContent.trim().length > 0
    );
    if (children.length === 1 && children[0].tagName === 'A') {
      const a = children[0];
      const href = a.getAttribute('href') || '';
      const type = detectLinkType(href);
      if (type === 'anchor') return; // Don't chip internal anchors

      const info = LINK_TYPES[type];
      const chip = document.createElement('a');
      chip.className = 'link-chip';
      chip.href = href;
      if (href.startsWith('http')) {
        chip.target = '_blank';
        chip.rel = 'noopener noreferrer';
      }

      const chipIcon = document.createElement('div');
      chipIcon.className = 'link-chip-icon';
      chipIcon.innerHTML = info.icon;

      const chipBody = document.createElement('div');
      chipBody.className = 'link-chip-body';

      const chipTitle = document.createElement('span');
      chipTitle.className = 'link-chip-title';
      chipTitle.textContent = a.textContent.trim() || href;

      const chipUrl = document.createElement('span');
      chipUrl.className = 'link-chip-url';
      try {
        const u = new URL(href, window.location.href);
        chipUrl.textContent = u.host + u.pathname;
      } catch { chipUrl.textContent = href; }

      const chipBadge = document.createElement('span');
      chipBadge.className = 'link-chip-badge';
      chipBadge.textContent = info.label;

      chipBody.appendChild(chipTitle);
      chipBody.appendChild(chipUrl);
      chip.appendChild(chipIcon);
      chip.appendChild(chipBody);
      chip.appendChild(chipBadge);
      p.replaceWith(chip);
    }
  });

  // Build links panel content
  buildLinksPanel(allLinks);
}

// Link tooltip
let tooltipHideTimer = null;

function showLinkTooltip(e, anchor, href, type) {
  clearTimeout(tooltipHideTimer);
  const tt = document.getElementById('linkTooltip');
  const info = LINK_TYPES[type];

  document.getElementById('linkTooltipIcon').innerHTML = info.icon;
  document.getElementById('linkTooltipBadge').textContent = info.label;

  // Format URL nicely
  let display = href;
  try {
    if (href.startsWith('http')) {
      const u = new URL(href);
      display = u.host + (u.pathname.length > 1 ? u.pathname : '');
      if (display.length > 55) display = display.slice(0, 52) + '...';
    } else if (href.startsWith('mailto:')) {
      display = href.replace('mailto:', '');
    } else if (href.startsWith('#')) {
      display = 'Jump to: ' + href.slice(1).replace(/-/g, ' ');
    }
  } catch {}
  document.getElementById('linkTooltipText').textContent = display;

  // Store href for copy
  tt.dataset.href = href;

  // Position
  const rect = anchor.getBoundingClientRect();
  tt.style.left = Math.min(rect.left, window.innerWidth - 420) + 'px';
  tt.style.top = (rect.bottom + 6) + 'px';
  tt.classList.add('visible');
}

function hideLinkTooltip() {
  tooltipHideTimer = setTimeout(() => {
    document.getElementById('linkTooltip').classList.remove('visible');
  }, 150);
}

// Keep tooltip visible when hovering over it
document.getElementById('linkTooltip').addEventListener('mouseenter', () => clearTimeout(tooltipHideTimer));
document.getElementById('linkTooltip').addEventListener('mouseleave', hideLinkTooltip);

function copyLinkUrl(e) {
  e.stopPropagation();
  const href = document.getElementById('linkTooltip').dataset.href;
  const btn = document.getElementById('linkTooltipCopy');
  navigator.clipboard.writeText(href).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
}

// Links panel
function toggleLinksPanel() {
  document.getElementById('linksPanel').classList.toggle('show');
}

function buildLinksPanel(links) {
  const container = document.getElementById('linksPanelContent');
  container.innerHTML = '';
  if (!links.length) { container.innerHTML = '<p style="font-size:0.8rem;color:var(--text-tertiary)">No links found.</p>'; return; }

  // Group by type
  const groups = {};
  for (const link of links) {
    if (!groups[link.type]) groups[link.type] = [];
    groups[link.type].push(link);
  }

  const order = ['external', 'github', 'docs', 'npm', 'file', 'anchor', 'email'];
  for (const type of order) {
    const items = groups[type];
    if (!items || !items.length) continue;
    const info = LINK_TYPES[type];

    const group = document.createElement('div');
    group.className = 'links-panel-group';

    const title = document.createElement('div');
    title.className = 'links-panel-group-title';
    title.innerHTML = `${info.icon} ${info.label} <span class="links-panel-group-count">${items.length}</span>`;
    group.appendChild(title);

    // Deduplicate by href
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);

      const a = document.createElement('a');
      a.className = 'links-panel-item';
      a.href = item.href;
      if (item.href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }

      const label = document.createElement('span');
      label.textContent = item.text || item.href;

      const url = document.createElement('span');
      url.className = 'links-panel-item-url';
      try {
        const u = new URL(item.href, window.location.href);
        url.textContent = u.host + u.pathname;
      } catch { url.textContent = item.href; }

      a.appendChild(label);
      if (type !== 'anchor') a.appendChild(url);

      // Click anchor links: scroll to target
      if (type === 'anchor') {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const target = document.getElementById(item.href.slice(1));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          toggleLinksPanel();
        });
      }

      group.appendChild(a);
    }
    container.appendChild(group);
  }
}

// ============================================
// Copy code
// ============================================
// Copies only the code (known issue 13). markdown-it wraps the highlight callback's output in its own
// <pre><code>, so the block holds the header (language label and this button) and then the inner code element:
// copy that inner element, never the outer one. Takes the button itself (onclick="copyCode(this)") or finds it in
// whatever a delegated listener passes (an element or an event, in any argument position).
function copyCode(...args) {
  let btn = null;
  for (const a of args) {
    if (a && a.nodeType === 1) { btn = a.closest('.copy-btn') || a; break; }
    if (a && a.target && a.target.closest) { btn = a.target.closest('.copy-btn'); break; }
  }
  if (!btn || !btn.closest) return;
  const block = btn.closest('pre') || btn.closest('.code-block');
  if (!block) return;
  const codes = [...block.querySelectorAll('code')].filter((c) => !c.contains(btn));
  const code = block.querySelector('code.hljs') || codes[codes.length - 1];
  if (!code) return;
  const text = code.textContent.replace(/\n$/, ''); // the fence's closing newline is not part of the code
  mdvCopyText(text).then(
    () => mdvFlashCopyButton(btn, 'Copied', 'copied'),
    () => mdvFlashCopyButton(btn, 'Copy failed', 'copy-failed'),
  );
}

const mdvCopyResetTimers = new WeakMap();
function mdvFlashCopyButton(btn, text, cls) {
  clearTimeout(mdvCopyResetTimers.get(btn));
  btn.textContent = text;
  btn.classList.remove('copied', 'copy-failed');
  btn.classList.add(cls);
  mdvCopyResetTimers.set(btn, setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('copied', 'copy-failed');
  }, 1600));
}

// The async clipboard needs a secure context (http://localhost and file:// count); otherwise fall back to a
// hidden textarea and the legacy copy command.
function mdvCopyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    if (ok) resolve(); else reject(new Error('copy refused'));
  });
}

// ============================================
// ============================================
// GitHub-style Callout Blocks
// Transforms > [!NOTE], > [!WARNING], etc.
