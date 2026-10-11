// ============================================
// Quick open: go to a file by typing part of its name (Cmd/Ctrl+P)
// ============================================
// A dialog over the page: type a few letters of a file's name or path ("hnd ui" finds
// handoffs/2026-10-08-ui.md), move with Up and Down, open with Enter (Cmd/Ctrl+Enter: its own window in the
// desktop app), close with Esc. It searches the open folder's files and the recent documents; with nothing
// typed it lists the recent documents first, then the folder's files, the most recently changed first.
// A listing more than a few seconds old is taken again as the dialog opens, so a file an agent has just written
// can be found at once; the list follows when the new listing arrives, keeping a row the reader moved to.
//
// The match is fuzzy: every letter typed must appear in order in the path, and a path scores higher when the
// letters start words (after / - _ . or a space, or at a capital), run together, or fall in the file's own name.
// Space-separated words must each match. Names are shown as text, with the matched letters marked.

const MDV_QO_LIMIT = 60;
const mdvQo = {
  overlay: null, input: null, list: null, status: null, items: [], focus: -1,
  // Recent documents (browser) whose folder has the open folder's name and whose path it lists, but which are a
  // different file (another folder of the same name): found out with isSameEntry, for the folder opened as openId.
  differs: new WeakSet(), differsFor: 0,
  moved: false, // the reader moved to a row with the arrows (since they last typed)
};

function mdvQoBuild() {
  const overlay = document.createElement('div');
  overlay.className = 'overlay mdv-palette-overlay';
  overlay.id = 'mdvQuickOpen';
  overlay.dataset.action = 'quick-open-backdrop';
  const box = document.createElement('div');
  box.className = 'search-box mdv-palette';
  const wrap = document.createElement('div');
  wrap.className = 'search-input-wrap';
  wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  const input = document.createElement('input');
  input.className = 'search-input';
  input.id = 'mdvQuickOpenInput';
  input.type = 'text';
  input.placeholder = 'Go to a file: type part of its name';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'mdvQuickOpenList');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-label', 'Go to a file');
  wrap.appendChild(input);
  const list = document.createElement('div');
  list.className = 'search-results mdv-palette-list';
  list.id = 'mdvQuickOpenList';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Files');
  const foot = document.createElement('div');
  foot.className = 'search-footer mdv-palette-footer';
  const keys = (k, text) => { const s = document.createElement('span'); for (const x of k) { const kbd = document.createElement('kbd'); kbd.textContent = x; s.appendChild(kbd); } s.append(' ' + text); return s; };
  foot.append(keys(['↑', '↓'], 'Move'), keys(['Enter'], 'Open'));
  if (mdvFolderIsDesktop()) foot.append(keys([MDV_IS_MAC_FOLDER ? '⌘' : 'Ctrl', 'Enter'], 'New window'));
  foot.append(keys(['Esc'], 'Close'));
  const status = document.createElement('span');
  status.className = 'mdv-palette-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  foot.appendChild(status);
  box.append(wrap, list, foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  Object.assign(mdvQo, { overlay, input, list, status });
  input.addEventListener('input', () => { mdvQo.moved = false; mdvQoRender(); });
  input.addEventListener('keydown', mdvQoKeys);
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[role="option"]');
    if (row) mdvQoChoose(Number(row.dataset.index), e);
  });
}

// ------- Matching -------
const MDV_QO_WORD_START = /[\\/\-_. ]/;

// The best way `term` (lower case) matches `text` as a subsequence, or null. Tries each place the first
// letter occurs and keeps the best scoring alignment.
function mdvFuzzy(term, text) {
  const lower = text.toLowerCase();
  if (!term) return { score: 0, positions: [] };
  if (lower.length !== text.length) return lower.includes(term) ? { score: term.length, positions: [] } : null;
  let best = null;
  for (let start = lower.indexOf(term[0]); start >= 0; start = lower.indexOf(term[0], start + 1)) {
    const positions = [];
    let score = 0, prev = -2, ti = 0;
    for (let i = start; i < lower.length && ti < term.length; i++) {
      if (lower[i] !== term[ti]) continue;
      let s = 1;
      if (i === prev + 1) s += 6;
      const before = text[i - 1];
      if (i === 0 || MDV_QO_WORD_START.test(before)) s += 8;
      else if (/[a-z0-9]/.test(before) && /[A-Z]/.test(text[i])) s += 6;
      score += s;
      positions.push(i);
      prev = i;
      ti++;
    }
    if (ti < term.length) break; // a later start cannot find what an earlier one could not
    score -= (positions[positions.length - 1] - positions[0]) * 0.05; // a tighter match is better
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

// A candidate's score for every typed word, preferring words that fall in the file's own name.
function mdvQoScore(terms, rel, name) {
  let total = 0;
  const positions = new Set();
  const offset = rel.length - name.length;
  for (const t of terms) {
    const inName = mdvFuzzy(t, name);
    const inPath = mdvFuzzy(t, rel);
    if (!inName && !inPath) return null;
    if (inName && (!inPath || inName.score * 1.5 + 4 >= inPath.score)) {
      total += inName.score * 1.5 + 4;
      for (const p of inName.positions) positions.add(p + offset);
    } else {
      total += inPath.score;
      for (const p of inPath.positions) positions.add(p);
    }
  }
  return { score: total, positions };
}

// A browser recent document is the open folder's file at its path when its folder has the open folder's name and
// it is the same file (isSameEntry, checked as the dialog opens; until then the name and path decide).
function mdvQoRecentInFolder(r) {
  const s = mdvFolderState;
  if (s.kind === 'desktop') return r.kind === 'path' && mdvFolderInside(r.path, s.root) ? r.path : null;
  if (s.kind !== 'browser' || r.kind !== 'handle' || !r.path || !s.byPath.has(r.path) || r.folder !== s.rootName) return null;
  return mdvQo.differsFor === s.openId && mdvQo.differs.has(r) ? null : r.path;
}

async function mdvQoCheckRecents() {
  const s = mdvFolderState;
  if (s.kind !== 'browser') return;
  if (mdvQo.differsFor !== s.openId) { mdvQo.differs = new WeakSet(); mdvQo.differsFor = s.openId; }
  const openId = s.openId;
  let changed = false;
  for (const r of mdvRecent.items || []) {
    const path = mdvQoRecentInFolder(r);
    const entry = path && s.byPath.get(path);
    if (!entry || !entry.handle || !r.handle || typeof entry.handle.isSameEntry !== 'function') continue;
    let same = false;
    try { same = await entry.handle.isSameEntry(r.handle); } catch (e) { same = false; }
    if (s.openId !== openId) return;
    if (!same) { mdvQo.differs.add(r); changed = true; }
  }
  if (changed && mdvQoIsOpen()) mdvQoRender({ keepFocus: true });
}

function mdvQoCandidates() {
  const out = [];
  const seen = new Set();
  const s = mdvFolderState;
  const recents = (mdvRecent.items || []);
  recents.forEach((r, i) => {
    const path = mdvQoRecentInFolder(r);
    const entry = path ? s.byPath.get(path) || s.entries.find((e) => mdvFolderSamePath(e.path, path)) : null;
    if (entry) {
      seen.add(entry.path);
      out.push({ kind: 'file', entry, rel: entry.rel, name: entry.name, recent: i });
    } else {
      out.push({ kind: 'recent', recentEntry: r, rel: r.kind === 'path' ? r.path : mdvRecentsWhere(r) + '/' + r.name, name: r.name, recent: i });
    }
  });
  for (const e of s.entries) if (!seen.has(e.path)) out.push({ kind: 'file', entry: e, rel: e.rel, name: e.name, recent: -1 });
  return out;
}

// With nothing typed: the recent documents in the order they were read, then the folder's files, the most recently
// changed first (a file whose time is not known yet keeps its place in the tree's order, after them).
function mdvQoNewestFirst(all) {
  const recent = all.filter((c) => c.recent >= 0);
  const files = all.filter((c) => c.recent < 0).map((c, i) => ({ c, i }));
  files.sort((a, b) => {
    const ta = a.c.entry.mtimeMs, tb = b.c.entry.mtimeMs;
    if (ta != null && tb != null && ta !== tb) return tb - ta;
    if ((ta != null) !== (tb != null)) return ta != null ? -1 : 1;
    return a.i - b.i;
  });
  return recent.concat(files.map((f) => f.c));
}

// The identity of a row, to keep the reader on it when the list is drawn again.
function mdvQoKey(c) { return c ? (c.kind === 'file' ? 'f:' + c.entry.path : c.recentEntry) : null; }

// ------- Drawing -------
function mdvQoMarked(text, positions, offset) {
  const frag = document.createDocumentFragment();
  let run = '', marked = false;
  const flush = () => {
    if (!run) return;
    if (marked) { const m = document.createElement('span'); m.className = 'search-match'; m.textContent = run; frag.appendChild(m); }
    else frag.append(run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const on = positions.has(i + offset);
    if (on !== marked) { flush(); marked = on; }
    run += text[i];
  }
  flush();
  return frag;
}

// keepFocus: the list is drawn again because the folder or the files' times changed, not because the reader typed;
// a row the reader moved to with the arrows stays the focused one (otherwise the first row is, as after typing).
function mdvQoRender({ keepFocus = false } = {}) {
  const was = keepFocus && mdvQo.moved ? mdvQoKey(mdvQo.items[mdvQo.focus]) : null;
  const q = mdvQo.input.value.trim();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = mdvQoCandidates();
  let ranked;
  if (!terms.length) ranked = mdvQoNewestFirst(all).map((c) => ({ c, positions: new Set(), score: 0 }));
  else {
    ranked = [];
    for (const c of all) {
      const m = mdvQoScore(terms, c.rel, c.name);
      if (m) ranked.push({ c, positions: m.positions, score: m.score + (c.recent >= 0 ? 3 - c.recent * 0.1 : 0) });
    }
    ranked.sort((a, b) => b.score - a.score || a.c.rel.length - b.c.rel.length || mdvFolderCollator.compare(a.c.rel, b.c.rel));
  }
  const shown = ranked.slice(0, MDV_QO_LIMIT);
  mdvQo.items = shown.map((r) => r.c);
  const frag = document.createDocumentFragment();
  shown.forEach((r, i) => {
    const { c } = r;
    const row = document.createElement('div');
    row.className = 'search-result-item mdv-palette-item';
    row.id = 'mdv-qo-' + i;
    row.dataset.index = String(i);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    const nameOffset = c.rel.length - c.name.length;
    const name = document.createElement('span');
    name.className = 'mdv-palette-name';
    name.appendChild(mdvQoMarked(c.name, r.positions, nameOffset));
    const where = document.createElement('span');
    where.className = 'mdv-palette-where';
    const dir = c.rel.slice(0, Math.max(0, nameOffset - 1));
    where.appendChild(mdvQoMarked(dir, r.positions, 0));
    row.append(name, where);
    if (c.recent >= 0) {
      const tag = document.createElement('span');
      tag.className = 'mdv-palette-tag';
      tag.textContent = 'recent';
      row.appendChild(tag);
    }
    if (c.kind === 'file' && mdvFolderState.current && mdvFolderSamePath(c.entry.path, mdvFolderState.current)) row.classList.add('is-current');
    frag.appendChild(row);
  });
  mdvQo.list.replaceChildren(frag);
  mdvQo.input.setAttribute('aria-expanded', String(shown.length > 0));
  const keep = was == null ? -1 : mdvQo.items.findIndex((c) => mdvQoKey(c) === was);
  mdvQoSetFocus(keep >= 0 ? keep : shown.length ? 0 : -1);
  mdvQoRenderStatus(ranked.length, shown.length, terms.length > 0);
}

function mdvQoRenderStatus(total, shown, typed) {
  const s = mdvFolderState;
  let text;
  // The folder searched is named: in the desktop app it is the document's own folder unless the reader chose another.
  if (s.loading && !s.entries.length) text = 'Listing the folder…';
  else if (!total) text = typed ? (s.kind ? `No file in “${s.rootName}” matches` : 'No file matches') : (s.kind ? 'This folder has no Markdown files' : 'Open a folder to go to its files');
  else text = total > shown ? `${shown} of ${total.toLocaleString()} files` : `${total.toLocaleString()} file${total === 1 ? '' : 's'}`;
  mdvQo.status.textContent = text;
  let open = mdvQo.list.parentElement.querySelector('.mdv-palette-open-folder');
  const want = !s.kind && !s.loading;
  if (want && !open && (mdvFolderIsDesktop() || 'showDirectoryPicker' in window)) {
    open = document.createElement('button');
    open.type = 'button';
    open.className = 'mdv-palette-open-folder';
    open.dataset.action = 'quick-open-folder';
    open.textContent = 'Open a folder…';
    mdvQo.list.after(open);
  } else if (!want && open) open.remove();
}

function mdvQoSetFocus(i) {
  mdvQo.focus = i;
  const rows = mdvQo.list.querySelectorAll('[role="option"]');
  rows.forEach((el, k) => { el.classList.toggle('focused', k === i); el.setAttribute('aria-selected', String(k === i)); });
  if (rows[i]) { mdvQo.input.setAttribute('aria-activedescendant', rows[i].id); rows[i].scrollIntoView({ block: 'nearest' }); }
  else mdvQo.input.removeAttribute('aria-activedescendant');
}

function mdvQoKeys(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const n = mdvQo.items.length;
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); mdvQo.moved = true; mdvQoSetFocus((mdvQo.focus + 1) % n); }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); mdvQo.moved = true; mdvQoSetFocus(mdvQo.focus <= 0 ? n - 1 : mdvQo.focus - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (n) mdvQoChoose(Math.max(0, mdvQo.focus), e); }
}

function mdvQoChoose(i, event) {
  const c = mdvQo.items[i];
  if (!c) return;
  const newWindow = !!(event && (event.metaKey || event.ctrlKey));
  mdvQoClose({ restoreFocus: false });
  if (c.kind === 'file') mdvFolderOpenFile(c.entry.path, { newWindow });
  else mdvRecentsOpen(c.recentEntry, { newWindow });
}

// ------- Opening and closing -------
function mdvQoIsOpen() { return !!(mdvModal && mdvQo.overlay && mdvModal.el === mdvQo.overlay); }

function mdvQoOpen() {
  if (!mdvQo.overlay) mdvQoBuild();
  const s = mdvFolderState;
  // The desktop app knows the document's folder: with no folder open yet, it is the one to search.
  if (!s.kind && mdvFolderIsDesktop() && mdvFolderDesktopDefault()) mdvFolderOpen();
  // Agents write files while the reader works: a listing more than a few seconds old is taken again.
  else if (s.kind && !s.loading && Date.now() - s.listedAt > MDV_FOLDER_STALE_MS) mdvFolderRefresh();
  mdvRecentsLoad().then(() => { if (mdvQoIsOpen()) { mdvQoRender({ keepFocus: true }); mdvQoCheckRecents(); } });
  mdvQo.input.value = '';
  mdvQo.moved = false;
  mdvQoRender();
  mdvOpenModal(mdvQo.overlay, { label: 'Go to a file', focus: mdvQo.input });
  mdvFolderLearnTimes();
}

function mdvQoClose(opts) { if (mdvQo.overlay) mdvCloseModal(mdvQo.overlay, opts); }
function mdvQoToggle() { if (mdvQoIsOpen()) mdvQoClose(); else mdvQoOpen(); }

mdvFolderOn('change', () => {
  if (!mdvQoIsOpen()) return;
  mdvQoRender({ keepFocus: true });
  if (!mdvFolderState.loading) mdvFolderLearnTimes();
});
// The files' times arrived: only the order with nothing typed depends on them.
mdvFolderOn('times', () => { if (mdvQoIsOpen() && !mdvQo.input.value.trim()) mdvQoRender({ keepFocus: true }); });

mdvRegisterActions({
  'folder-quick-open':   { click: () => mdvQoOpen() },
  'quick-open-backdrop': { click: (el, arg, event) => { if (event.target === el) mdvQoClose(); } },
  'quick-open-folder':   { click: () => { mdvQoClose({ restoreFocus: false }); mdvTreeShow(true); mdvFolderOpen().then((ok) => { if (ok) mdvQoOpen(); }); } },
});

document.addEventListener('DOMContentLoaded', () => {
  mdvFolderAddShortcut({ mod: true, key: 'p', label: 'Go to a file (quick open)', modal: 'mdvQuickOpen', run: () => mdvQoToggle() });
});
