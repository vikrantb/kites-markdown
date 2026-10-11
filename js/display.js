// ============================================
// Theme
// ============================================
function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('mdv-theme', theme);
  document.getElementById('hljs-light').disabled = (theme === 'dark');
  document.getElementById('hljs-dark').disabled = (theme !== 'dark');
  document.querySelectorAll('.dropdown-item[data-theme]').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === theme);
  });
  closeDropdowns();
  if (rawMarkdown) setTimeout(renderMermaidDiagrams, 100);
}

// ============================================
// Toolbar menus (Theme, Export)
// ============================================
// A button with data-action="toggle-dropdown" opens the .dropdown its data-arg names, and works as a menu button
// does from the keyboard:
// - its aria-expanded says whether the menu is open;
// - Escape closes the menu and gives the focus back to the button, and so does choosing an item;
// - ArrowDown and ArrowUp (Home, End) move between the items; on the closed button, they open the menu there;
// - the menu closes when the focus leaves it and its button (Tab past it), as it does on a click elsewhere.
function mdvMenuButton(dd) {
  return dd && dd.id ? document.querySelector(`[data-action="toggle-dropdown"][data-arg="${CSS.escape(dd.id)}"]`) : null;
}

function toggleDropdown(id) {
  const dd = document.getElementById(id);
  const isOpen = dd.classList.contains('show');
  closeDropdowns();
  if (isOpen) return;
  dd.classList.add('show');
  const button = mdvMenuButton(dd);
  if (button) button.setAttribute('aria-expanded', 'true');
}
function closeDropdowns() {
  document.querySelectorAll('.dropdown').forEach(d => {
    const button = mdvMenuButton(d);
    if (button) button.setAttribute('aria-expanded', 'false');
    if (!d.classList.contains('show')) return;
    // The focus was on an item: it goes back to the button, not to a hidden item (and from there to the page's top).
    const focusInside = d.contains(document.activeElement);
    d.classList.remove('show');
    if (focusInside && button) button.focus();
  });
}
document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown-wrap')) closeDropdowns(); });
document.querySelectorAll('[data-action="toggle-dropdown"]').forEach(b => b.setAttribute('aria-expanded', 'false'));

function mdvMenuItems(dd) {
  return [...dd.querySelectorAll('.dropdown-item')].filter(i => !i.disabled && i.getClientRects().length > 0);
}

document.addEventListener('keydown', (e) => {
  const open = document.querySelector('.dropdown.show');
  if (e.key === 'Escape' && open) {
    e.preventDefault();
    closeDropdowns();
    const button = mdvMenuButton(open);
    if (button) button.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
  const wrap = e.target && e.target.closest ? e.target.closest('.dropdown-wrap') : null;
  const dd = wrap && wrap.querySelector('.dropdown');
  if (!dd) return;
  if (!dd.classList.contains('show')) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    toggleDropdown(dd.id);
  }
  const items = mdvMenuItems(dd);
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement);
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
  else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  items[next].focus();
});
document.addEventListener('focusin', (e) => {
  const open = document.querySelector('.dropdown.show');
  if (open && !open.closest('.dropdown-wrap').contains(e.target)) closeDropdowns();
});

// ============================================
// Font Size
// ============================================
function changeFontSize(dir) {
  fontStep = Math.max(-2, Math.min(2, fontStep + dir));
  applyFontSize();
  localStorage.setItem('mdv-fontsize', fontStep);
}
function applyFontSize() {
  const fs = fontSizes[2 + fontStep];
  document.documentElement.style.setProperty('--reading-size', fs.size);
  document.documentElement.style.setProperty('--reading-lh', fs.lh);
  document.getElementById('fontLbl').textContent = fs.label;
}

// ============================================
// Width toggle
// ============================================
function toggleWidth() {
  isExpanded = !isExpanded;
  document.getElementById('contentWrapper').classList.toggle('expanded', isExpanded);
  document.getElementById('widthBtn').classList.toggle('active', isExpanded);
}

// ============================================
// Focus mode
// ============================================
function toggleFocus() {
  isFocusMode = !isFocusMode;
  document.body.classList.toggle('focus-mode', isFocusMode);
  document.getElementById('focusBtn').classList.toggle('active', isFocusMode);
}

// ============================================
// Settings
// ============================================
function toggleSettings() {
  const p = document.getElementById('settingsPanel');
  p.classList.toggle('show');
  if (p.classList.contains('show')) {
    document.getElementById('basePathInput').value = localStorage.getItem('mdv-basepath') || '';
  }
}
function saveBasePath() {
  let val = document.getElementById('basePathInput').value.trim();
  if (val && !val.endsWith('/')) val += '/';
  localStorage.setItem('mdv-basepath', val);
  toggleSettings();
}

