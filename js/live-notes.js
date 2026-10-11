// ============================================
// What live reload tells the reader
// ============================================
// js/live-reload.js follows the file; this is what the reader sees of it:
//   - the note at the top right after a new version is shown, saying where it changed ("Updated: Status", "Updated:
//     Status and 2 more"), and the changed blocks marked for a moment (mdvLiveAnnounce);
//   - the question at the bottom, "Changed on disk: reload?", when the document has unsaved comment changes;
//   - the mark at the top right while something is true: a newer version waits (after "Not now", or while a comment
//     box is open), the file is not on disk, or the page shows a copy that cannot follow its file (mdvLiveUpdateChip);
//   - Alt+R, which answers the question or asks it again from the mark.
// Every piece is built with createElement and textContent, and acts through data-action (js/actions.js).

// Marking the blocks that changed compares every block's words; past this many blocks only the note is shown, and a
// version that changed more blocks than the second number is not marked block by block
const MDV_LIVE_DIFF_LIMIT = 6000;
const MDV_LIVE_MARK_LIMIT = 60;

// ------- What changed -------
// The words of every block of the page, counted, or null for a page too large to compare
function mdvLiveBlockWords() {
  const body = document.getElementById('mdBody');
  if (!body || !body.firstElementChild) return null;
  const blocks = body.querySelectorAll(MDV_PLACE_BLOCKS);
  if (blocks.length > MDV_LIVE_DIFF_LIMIT) return null;
  const words = new Map();
  for (const el of blocks) {
    const w = mdvPlaceWords(el);
    if (w) words.set(w, (words.get(w) || 0) + 1);
  }
  return words;
}

// After a new version is shown: its blocks whose words the old version did not have are marked for a moment, and the
// note names the section of the first ("Updated: Status") and how many other sections changed
function mdvLiveAnnounce(before) {
  const body = document.getElementById('mdBody');
  const changed = [];
  if (before && body) {
    const left = new Map(before);
    for (const el of body.querySelectorAll(MDV_PLACE_BLOCKS)) {
      const w = mdvPlaceWords(el);
      if (!w) continue;
      const n = left.get(w) || 0;
      if (n > 0) left.set(w, n - 1);
      else changed.push(el);
    }
  }
  const sections = [];
  const marks = changed.length <= MDV_LIVE_MARK_LIMIT ? changed : [];
  const owners = new Map();
  for (const el of changed) {
    const name = mdvLiveSectionName(el, owners);
    if (!sections.includes(name)) sections.push(name);
  }
  for (const el of marks) {
    el.classList.remove('mdv-live-changed');
    void el.offsetWidth; // restart the mark on a block that changed again
    el.classList.add('mdv-live-changed');
    el.addEventListener('animationend', () => el.classList.remove('mdv-live-changed'), { once: true });
  }
  const named = sections.filter(Boolean);
  let text = 'Updated';
  if (named.length) text += ': ' + named[0] + (sections.length > 1 ? ` and ${sections.length - 1} more` : '');
  mdvLiveToast(text);
  return changed.length;
}

// The heading of the section a block is in (the block itself, for a heading), or '' above the first heading
function mdvLiveSectionName(el, owners) {
  if (/^h[1-6]$/.test(el.localName)) return mdvPlaceWords(el);
  const section = mdvSectionAround(el);
  return section ? mdvSectionOwner(section, owners) : '';
}

// ------- The note, the question and the mark -------
const MDV_LIVE_ICON = 'M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5';
const MDV_LIVE_GONE_ICON = 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z';

function mdvLiveIcon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d || MDV_LIVE_ICON);
  svg.appendChild(path);
  return svg;
}

let mdvLiveToastTimer = 0;
function mdvLiveToast(text) {
  let el = document.getElementById('mdvLiveToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mdvLiveToast';
    el.className = 'mdv-live-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  const words = document.createElement('span');
  words.className = 'mdv-live-toast-text';
  words.textContent = text;
  el.replaceChildren(mdvLiveIcon(), words);
  el.title = text;
  el.classList.add('show');
  clearTimeout(mdvLiveToastTimer);
  mdvLiveToastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function mdvLiveShowPrompt() {
  let el = document.getElementById('mdvLivePrompt');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mdvLivePrompt';
    el.className = 'mdv-live-prompt';
    el.setAttribute('role', 'alert');
    const text = document.createElement('div');
    text.className = 'mdv-live-prompt-text';
    const title = document.createElement('strong');
    title.className = 'mdv-live-prompt-title';
    title.textContent = 'Changed on disk: reload?';
    const detail = document.createElement('span');
    detail.className = 'mdv-live-prompt-detail';
    text.append(title, detail);
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'mdv-live-btn mdv-live-btn-primary';
    reload.dataset.action = 'live-reload';
    reload.textContent = 'Reload';
    reload.setAttribute('aria-keyshortcuts', 'Alt+R');
    reload.title = `Show the newer version (${mdvLiveKeyName()})`;
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'mdv-live-btn';
    later.dataset.action = 'live-dismiss';
    later.textContent = 'Not now';
    el.append(mdvLiveIcon(), text, reload, later);
    document.body.appendChild(el);
  }
  const shown = mdvShownDocument();
  const name = shown ? shown.name : 'The document';
  el.querySelector('.mdv-live-prompt-detail').textContent =
    `${name} has a newer version. Your comment changes that are not saved yet stay in the comments panel.`;
  el.hidden = false;
  mdvLive.prompt = el;
  mdvLive.deferred = null;
  requestAnimationFrame(() => el.classList.add('show'));
}

function mdvLiveHidePrompt() {
  const el = mdvLive.prompt || document.getElementById('mdvLivePrompt');
  mdvLive.prompt = null;
  if (!el) return;
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.classList.remove('show');
  el.hidden = true;
}

// The mark at the top right: a newer version waits ('stale': the reader said Not now; 'waiting': a comment box is
// open), the file is not on disk ('gone'), or the page shows a copy that cannot follow its file ('copy': a file chosen
// with the Open button, which the browser hands over as a snapshot)
function mdvLiveUpdateChip() {
  const shown = mdvShownDocument();
  const copy = !!shown && shown.kind === 'file' && !shown.handle && !mdvInDesktopApp();
  const state = mdvLive.gone ? 'gone'
    : mdvLive.pending && !mdvLive.prompt ? (mdvLive.deferred === 'typing' ? 'waiting' : 'stale')
    : copy ? 'copy'
    : null;
  let el = document.getElementById('mdvLiveChip');
  document.body.classList.toggle('mdv-live-chip-shown', !!state);
  if (!state) {
    if (el) { el.hidden = true; el.dataset.state = ''; }
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'mdvLiveChip';
    el.className = 'mdv-live-chip';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  // A few words show, beside the section rail; the whole sentence is the tooltip and what a screen reader says
  const name = (shown && shown.name) || 'The document';
  const canFollow = state === 'copy' && typeof mdvCanOpenWithHandle === 'function' && mdvCanOpenWithHandle();
  const words = {
    stale: ['Newer version', `${name} has a newer version on disk.`],
    waiting: ['Newer version waits', `${name} has a newer version on disk: shown when you close the comment box.`],
    gone: ['Not on disk', `${name} is not on disk (moved, renamed or deleted): the last version stays here, and the file shows again soon after it comes back.`],
    copy: ['A copy', canFollow
      ? `A copy: changes to ${name} do not show here. Follow… opens the file itself, and then the page follows it.`
      : `A copy: changes to ${name} do not show here. This browser gives the page a copy of a file it opens, not the file.`],
  }[state];
  const short = document.createElement('span');
  short.className = 'mdv-live-chip-text';
  short.setAttribute('aria-hidden', 'true');
  short.textContent = words[0];
  const full = document.createElement('span');
  full.className = 'mdv-live-sr';
  full.textContent = words[1];
  // With a button, the button is the cue: no icon, so the mark fits beside the section rail
  const parts = state === 'stale' || canFollow ? [short, full] : [mdvLiveIcon(state === 'gone' ? MDV_LIVE_GONE_ICON : MDV_LIVE_ICON), short, full];
  const button = (action, label, title) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mdv-live-chip-btn';
    btn.dataset.action = action;
    btn.textContent = label;
    if (title) btn.title = title;
    return btn;
  };
  if (state === 'stale') {
    const btn = button('live-review', 'Reload…', `Show the newer version (${mdvLiveKeyName()})`);
    btn.setAttribute('aria-keyshortcuts', 'Alt+R');
    parts.push(btn);
  }
  if (canFollow) parts.push(button('live-follow', 'Follow…', 'Open the file itself, so the page follows it'));
  el.title = words[1];
  el.replaceChildren(...parts);
  el.dataset.state = state;
  el.hidden = false;
}

// The chip's Reload…, or Alt+R: the question again, or the new version at once when nothing is unsaved any more
function mdvLiveReview() {
  const pending = mdvLive.pending;
  if (!pending) return false;
  const unsaved = mdvLiveUnsavedWork();
  if (unsaved === 'typing') { mdvLiveWaitForBox(); return true; }
  if (unsaved === 'comments') {
    mdvLiveShowPrompt();
    mdvLiveUpdateChip();
    const reload = mdvLive.prompt && mdvLive.prompt.querySelector('.mdv-live-btn-primary');
    if (reload) reload.focus({ preventScroll: true });
    return true;
  }
  mdvLiveApply(pending.target, pending.change);
  return true;
}

function mdvLiveKeyName() { return (typeof MDV_IS_MAC !== 'undefined' && MDV_IS_MAC) ? '⌥R' : 'Alt+R'; }

mdvRegisterActions({
  'live-reload': {
    click: () => {
      const pending = mdvLive.pending;
      if (pending) mdvLiveApply(pending.target, pending.change);
      else mdvLiveHidePrompt();
    },
  },
  // The reader keeps reading this version; the mark at the top right keeps the newer one at hand
  'live-dismiss': {
    click: () => {
      mdvLiveHidePrompt();
      if (mdvLive.pending) mdvLive.deferred = 'dismissed';
      mdvLiveUpdateChip();
    },
  },
  'live-review': { click: () => mdvLiveReview() },
  // A copy: the reader picks the file itself, which is then shown in its place and followed
  'live-follow': { click: () => mdvPickToFollow({ push: false, position: mdvReadingPosition() }) },
});

// app.js, which keeps the shortcut table, loads after this file
document.addEventListener('DOMContentLoaded', () => {
  if (typeof mdvRegisterShortcut !== 'function') return;
  mdvRegisterShortcut('Alt+R', () => {
    if (mdvLive.prompt && mdvLive.pending) { mdvLiveApply(mdvLive.pending.target, mdvLive.pending.change); return true; }
    return mdvLiveReview();
  }, 'Show the newer version of the document');
});
