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

function toggleDropdown(id) {
  const dd = document.getElementById(id);
  const isOpen = dd.classList.contains('show');
  closeDropdowns();
  if (!isOpen) dd.classList.add('show');
}
function closeDropdowns() { document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('show')); }
document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown-wrap')) closeDropdowns(); });

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

