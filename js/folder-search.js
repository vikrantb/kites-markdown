// ============================================
// Search in files: full text across the folder's Markdown (Cmd/Ctrl+Shift+F)
// ============================================
// A dialog like the document search (Cmd/Ctrl+K), over every file in the open folder: each file that holds
// the words, its matching lines (one row per line, every match on it marked) and how many matches it has. Enter
// or a click opens the file and goes to the match: the rendered block that holds it is scrolled into view, flashed,
// and the words themselves are highlighted for a moment. Enter pressed before the results for what was typed are
// there (the first search of a large folder reads it first) goes to the first match once they are.
//
// The files are read the first time the dialog opens (the index), not before: a folder that is never searched
// costs nothing. Reading and matching run in slices of about 12 ms with the page free in between, so typing,
// scrolling and the rest of the viewer never wait for it; a newer query stops an older one. Each later opening
// reads again only the files whose size or time changed, so documents that agents rewrite while the reader works
// are searched as they are now. A file over 1 MB, and anything past 64 MB in all, is not read (the dialog says
// how many). The comment block at the end of a file (MDV-COMMENTS) is not searched: its JSON is not the text.
//
// Cmd/Ctrl+Shift+F also folds every section (app.js): it searches whenever a folder is open, whether or not its
// sidebar is shown (a narrow window hides it), and folds only when no folder is open. The toolbar's fold button
// always folds.

const MDV_XS_MAX_FILE_BYTES = 1024 * 1024;
const MDV_XS_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MDV_XS_SLICE_MS = 12;
const MDV_XS_MAX_FILES = 200;   // files listed
const MDV_XS_PER_FILE = 5;      // matching lines shown per file
const MDV_XS_PARALLEL = 8;      // files read at once

const mdvXs = {
  overlay: null, input: null, list: null, status: null,
  index: new Map(),      // path → {text, mtimeMs, size} | {skipped: 'large' | 'total', mtimeMs, size}
  indexFor: null,        // the folder the index belongs to
  indexing: null,        // the running refresh (a promise)
  progress: null,        // {done, total} while indexing
  bytes: 0,
  query: '', gen: 0, timer: 0,
  lastResult: null,      // {q, files, matches, more} of the last finished search
  shownFor: null,        // what was typed (as typed) for the results on screen
  goWhenShown: null,     // {value, newWindow}: Enter came before the results for `value`; go once they are drawn
  options: [],           // the rows the keyboard moves through: {el, path, at}
  focus: -1,
  highlightTimer: 0,
};

function mdvXsBuild() {
  const overlay = document.createElement('div');
  overlay.className = 'overlay mdv-palette-overlay';
  overlay.id = 'mdvFolderSearch';
  overlay.dataset.action = 'folder-search-backdrop';
  const box = document.createElement('div');
  box.className = 'search-box mdv-palette mdv-xs';
  const wrap = document.createElement('div');
  wrap.className = 'search-input-wrap';
  wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  const input = document.createElement('input');
  input.className = 'search-input';
  input.id = 'mdvFolderSearchInput';
  input.type = 'text';
  input.placeholder = 'Search in every file of the folder';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'mdvFolderSearchList');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-label', 'Search in files');
  wrap.appendChild(input);
  const list = document.createElement('div');
  list.className = 'search-results mdv-palette-list mdv-xs-list';
  list.id = 'mdvFolderSearchList';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Matches');
  const foot = document.createElement('div');
  foot.className = 'search-footer mdv-palette-footer';
  const keys = (k, text) => { const s = document.createElement('span'); for (const x of k) { const kbd = document.createElement('kbd'); kbd.textContent = x; s.appendChild(kbd); } s.append(' ' + text); return s; };
  foot.append(keys(['↑', '↓'], 'Move'), keys(['Enter'], 'Go to the match'), keys(['Esc'], 'Close'));
  const status = document.createElement('span');
  status.className = 'mdv-palette-status';
  status.id = 'mdvFolderSearchStatus';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  foot.appendChild(status);
  box.append(wrap, list, foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  Object.assign(mdvXs, { overlay, input, list, status });
  input.addEventListener('input', () => {
    clearTimeout(mdvXs.timer);
    mdvXs.goWhenShown = null; // typing on after Enter: the reader is still choosing
    mdvXs.timer = setTimeout(() => mdvXsRun(input.value), 120);
  });
  input.addEventListener('keydown', mdvXsKeys);
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-xs-index]');
    if (row) mdvXsChoose(Number(row.dataset.xsIndex), e);
  });
}

// Lets the page breathe between slices of work.
function mdvXsYield() { return new Promise((resolve) => setTimeout(resolve, 0)); }

// ------- The index -------
function mdvXsStripComments(text) {
  if (typeof mdvLocateBlockAtEnd !== 'function') return text;
  try {
    const loc = mdvLocateBlockAtEnd(text);
    return loc && typeof loc.start === 'number' ? text.slice(0, loc.start) : text;
  } catch (e) { return text; }
}

// Size and time of a file now: the desktop listing carries them; a browser handle is asked.
async function mdvXsStat(entry) {
  if (mdvFolderState.kind === 'desktop') return { size: entry.size, mtimeMs: entry.mtimeMs, file: null };
  const file = await entry.handle.getFile();
  return { size: file.size, mtimeMs: file.lastModified, file };
}

// Takes a file out of the index, with the bytes its text counted against the budget.
function mdvXsForget(path) {
  const old = mdvXs.index.get(path);
  if (!old) return false;
  if (typeof old.text === 'string') mdvXs.bytes -= old.size || 0;
  mdvXs.index.delete(path);
  return true;
}

async function mdvXsReadOne(entry) {
  const cached = mdvXs.index.get(entry.path);
  let stat;
  try { stat = await mdvXsStat(entry); } catch (e) { return mdvXsForget(entry.path); }
  if (mdvFolderState.kind === 'browser') { entry.size = stat.size; entry.mtimeMs = stat.mtimeMs; entry.statAt = Date.now(); }
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return false;
  mdvXsForget(entry.path);
  if (stat.size > MDV_XS_MAX_FILE_BYTES) { mdvXs.index.set(entry.path, { skipped: 'large', size: stat.size, mtimeMs: stat.mtimeMs }); return true; }
  // The budget is taken before the read, so the files read at the same time cannot overrun it together.
  const bytes = stat.size || 0;
  if (mdvXs.bytes + bytes > MDV_XS_MAX_TOTAL_BYTES) { mdvXs.index.set(entry.path, { skipped: 'total', size: stat.size, mtimeMs: stat.mtimeMs }); return true; }
  mdvXs.bytes += bytes;
  let text;
  try {
    text = mdvFolderState.kind === 'desktop' ? (await window.mdvHost.readDocument(entry.path)).text : await stat.file.text();
  } catch (e) {
    mdvXs.bytes -= bytes;
    return !!cached;
  }
  text = mdvXsStripComments(String(text || ''));
  mdvXs.index.set(entry.path, { text, size: stat.size, mtimeMs: stat.mtimeMs });
  return true;
}

// What the index belongs to: the folder as opened (folder.js openId), never its name, which two folders can share.
function mdvXsFolderKey() {
  const s = mdvFolderState;
  return s.kind + ':' + s.openId;
}

// Brings the index up to date with the folder, a few files at a time. Resolves true when anything changed.
function mdvXsRefreshIndex() {
  if (mdvXs.indexing) return mdvXs.indexing;
  const s = mdvFolderState;
  const key = mdvXsFolderKey();
  if (mdvXs.indexFor !== key) { mdvXs.index = new Map(); mdvXs.bytes = 0; mdvXs.indexFor = key; mdvXs.lastResult = null; }
  mdvXs.indexing = (async () => {
    // A listing older than a few seconds is taken again first: files come and go while the reader works.
    if (s.kind && !s.loading && Date.now() - s.listedAt > MDV_FOLDER_STALE_MS) await mdvFolderRefresh();
    const entries = s.entries.slice();
    const listed = new Set(entries.map((e) => e.path));
    let changed = false;
    for (const path of [...mdvXs.index.keys()]) {
      if (!listed.has(path) && mdvXsForget(path)) changed = true;
    }
    mdvXs.progress = { done: 0, total: entries.length };
    let sliceStart = performance.now();
    for (let i = 0; i < entries.length; i += MDV_XS_PARALLEL) {
      if (mdvXsFolderKey() !== key) break; // another folder was opened meanwhile
      const batch = entries.slice(i, i + MDV_XS_PARALLEL);
      const results = await Promise.all(batch.map(mdvXsReadOne));
      if (results.some(Boolean)) changed = true;
      mdvXs.progress.done = Math.min(entries.length, i + batch.length);
      if (performance.now() - sliceStart > MDV_XS_SLICE_MS) {
        if (mdvXsIsOpen()) mdvXsRenderStatus();
        await mdvXsYield();
        sliceStart = performance.now();
      }
    }
    mdvXs.progress = null;
    return changed;
  })().finally(() => { mdvXs.indexing = null; });
  return mdvXs.indexing;
}

// ------- Searching -------
// Case-insensitive, by Unicode case folding: a regular expression over the text as it is, so the index holds one
// copy of each file and every position is a position in the text shown.
function mdvXsPattern(q) {
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

function mdvXsLineOf(doc, at) {
  const src = doc.text;
  const start = src.lastIndexOf('\n', at - 1) + 1;
  let end = src.indexOf('\n', at);
  if (end < 0) end = src.length;
  let line = 1;
  for (let i = src.indexOf('\n'); i >= 0 && i < at; i = src.indexOf('\n', i + 1)) line++;
  return { line, start, text: src.slice(start, end) };
}

// About 130 characters of the line around the match.
function mdvXsSnippet(lineText, offset, qlen) {
  const raw = lineText.replace(/\t/g, ' ');
  const lead = raw.length - raw.trimStart().length;
  let from = Math.max(lead, offset - 50);
  // Start at a word: the first space after the cut, if it comes before the match.
  if (from > lead) { const space = raw.indexOf(' ', from); if (space >= 0 && space < offset) from = space + 1; }
  const to = Math.min(raw.length, Math.max(offset + qlen + 80, from + 130));
  return (from > lead ? '…' : '') + raw.slice(from, to) + (to < raw.length ? '…' : '');
}

async function mdvXsRun(query) {
  const gen = ++mdvXs.gen;
  mdvXs.query = query;
  const q = query.trim().toLowerCase();
  if (q.length < 2) { mdvXsRender(null, query); return; }
  const pattern = mdvXsPattern(q);
  if (!mdvXs.index.size && mdvXs.indexing) {
    mdvXsRenderStatus();
    await mdvXs.indexing;
    if (gen !== mdvXs.gen) return;
  }
  const files = [];
  let matches = 0, more = false;
  let sliceStart = performance.now();
  for (const entry of mdvFolderState.entries) {
    const doc = mdvXs.index.get(entry.path);
    if (!doc || typeof doc.text !== 'string') continue;
    pattern.lastIndex = 0;
    let m = pattern.exec(doc.text);
    if (!m) continue;
    // One row per line: a second match on a line already listed is counted, and marked in that row's snippet.
    const hits = [];
    let count = 0, lines = 0, lineEnd = -1;
    while (m) {
      count++;
      if (m.index > lineEnd) {
        lines++;
        if (hits.length < MDV_XS_PER_FILE) hits.push({ at: m.index, length: m[0].length });
        lineEnd = doc.text.indexOf('\n', m.index);
        if (lineEnd < 0) lineEnd = doc.text.length;
      }
      m = pattern.exec(doc.text);
    }
    matches += count;
    if (files.length < MDV_XS_MAX_FILES) files.push({ entry, doc, hits, count, lines });
    else more = true;
    if (performance.now() - sliceStart > MDV_XS_SLICE_MS) {
      await mdvXsYield();
      if (gen !== mdvXs.gen) return;
      sliceStart = performance.now();
    }
  }
  if (gen !== mdvXs.gen) return;
  mdvXsRender({ q, files, matches, more }, query);
}

// ------- Drawing -------
// forValue: what was typed (as typed) that these results answer.
function mdvXsRender(result, forValue) {
  const list = mdvXs.list;
  mdvXs.options = [];
  mdvXs.focus = -1;
  mdvXs.input.removeAttribute('aria-activedescendant');
  mdvXs.lastResult = result;
  mdvXs.shownFor = forValue == null ? null : forValue;
  if (!result) {
    list.replaceChildren();
    mdvXs.input.setAttribute('aria-expanded', 'false');
    mdvXsRenderStatus();
    if (mdvXs.goWhenShown && mdvXs.goWhenShown.value === forValue) mdvXs.goWhenShown = null;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of result.files) {
    const group = document.createElement('div');
    group.className = 'mdv-xs-file';
    group.setAttribute('role', 'group');
    const head = document.createElement('div');
    head.className = 'mdv-xs-file-head';
    head.dataset.xsIndex = String(mdvXs.options.length);
    head.id = 'mdv-xs-' + mdvXs.options.length;
    head.setAttribute('role', 'option');
    head.setAttribute('aria-selected', 'false');
    const name = document.createElement('span');
    name.className = 'mdv-xs-name';
    name.textContent = f.entry.name;
    const where = document.createElement('span');
    where.className = 'mdv-xs-where';
    where.textContent = f.entry.dir || '';
    const count = document.createElement('span');
    count.className = 'mdv-xs-count';
    count.textContent = String(f.count);
    count.setAttribute('aria-label', `${f.count} match${f.count === 1 ? '' : 'es'}`);
    head.append(name, where, count);
    group.setAttribute('aria-label', f.entry.rel);
    group.appendChild(head);
    mdvXs.options.push({ el: head, path: f.entry.path, at: f.hits[0].at, doc: f.doc });
    for (const { at, length } of f.hits) {
      const line = mdvXsLineOf(f.doc, at);
      const row = document.createElement('div');
      row.className = 'search-result-item mdv-xs-hit';
      row.dataset.xsIndex = String(mdvXs.options.length);
      row.id = 'mdv-xs-' + mdvXs.options.length;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const num = document.createElement('span');
      num.className = 'mdv-xs-line';
      num.textContent = String(line.line);
      num.setAttribute('aria-label', `line ${line.line}`);
      const text = document.createElement('span');
      text.className = 'mdv-xs-text';
      text.appendChild(mdvHighlight(mdvXsSnippet(line.text, at - line.start, length), result.q));
      row.append(num, text);
      group.appendChild(row);
      mdvXs.options.push({ el: row, path: f.entry.path, at, doc: f.doc });
    }
    if (f.lines > f.hits.length) {
      const rest = document.createElement('div');
      rest.className = 'mdv-xs-more';
      const more = f.lines - f.hits.length;
      rest.textContent = `${more} more line${more === 1 ? '' : 's'} in this file`;
      group.appendChild(rest);
    }
    frag.appendChild(group);
  }
  list.replaceChildren(frag);
  list.scrollTop = 0;
  mdvXs.input.setAttribute('aria-expanded', String(mdvXs.options.length > 0));
  if (mdvXs.options.length > 1) mdvXsSetFocus(1); else if (mdvXs.options.length) mdvXsSetFocus(0);
  mdvXsRenderStatus();
  // Enter came before these results: go to the first match now (with none, the dialog stays and says so).
  const go = mdvXs.goWhenShown;
  if (go && go.value === forValue) {
    mdvXs.goWhenShown = null;
    if (mdvXs.options.length && mdvXsIsOpen()) mdvXsChoose(Math.max(0, mdvXs.focus), go.newWindow);
  }
}

function mdvXsRenderStatus() {
  const s = mdvFolderState;
  const r = mdvXs.lastResult;
  const skipped = [...mdvXs.index.values()].filter((d) => d.skipped).length;
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  let text;
  if (!s.kind) text = 'Open a folder to search its files';
  else if (mdvXs.progress && (!r || !mdvXs.index.size)) text = `Reading ${mdvXs.progress.done.toLocaleString()} of ${mdvXs.progress.total.toLocaleString()} files…`;
  else if (!r) text = mdvXs.query.trim().length === 1 ? 'Type at least 2 characters' : `${plural(s.entries.length, 'file', 'files')} to search`;
  // The folder searched is named: in the desktop app it is the document's own folder unless the reader chose another.
  else if (!r.files.length) text = `No matches in “${s.rootName}”`;
  else {
    text = `${plural(r.matches, 'match', 'matches')} in ${plural(r.files.length, 'file', 'files')}`;
    if (r.more) text += ` (the first ${MDV_XS_MAX_FILES} files)`;
  }
  if (mdvXs.progress && r) text += ` · reading ${mdvXs.progress.done.toLocaleString()} of ${mdvXs.progress.total.toLocaleString()}`;
  if (skipped) text += ` · ${plural(skipped, 'file', 'files')} too large to search`;
  mdvXs.status.textContent = text;
}

function mdvXsSetFocus(i) {
  const prev = mdvXs.options[mdvXs.focus];
  if (prev) { prev.el.classList.remove('focused'); prev.el.setAttribute('aria-selected', 'false'); }
  mdvXs.focus = i;
  const cur = mdvXs.options[i];
  if (!cur) { mdvXs.input.removeAttribute('aria-activedescendant'); return; }
  cur.el.classList.add('focused');
  cur.el.setAttribute('aria-selected', 'true');
  mdvXs.input.setAttribute('aria-activedescendant', cur.el.id);
  cur.el.scrollIntoView({ block: 'nearest' });
}

function mdvXsKeys(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const n = mdvXs.options.length;
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); mdvXsSetFocus((mdvXs.focus + 1) % n); }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); mdvXsSetFocus(mdvXs.focus <= 0 ? n - 1 : mdvXs.focus - 1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const newWindow = { metaKey: e.metaKey, ctrlKey: e.ctrlKey };
    const value = mdvXs.input.value;
    if (mdvXs.lastResult && mdvXs.shownFor === value) {
      if (n) mdvXsChoose(Math.max(0, mdvXs.focus), newWindow);
      return;
    }
    // The results on screen are not (yet) for what was typed: the debounce has not run, the first search is still
    // reading the folder, or a long search is part-way. Go to the first match when its results are drawn.
    mdvXs.goWhenShown = { value, newWindow };
    if (mdvXs.query !== value) {
      clearTimeout(mdvXs.timer);
      mdvXsRun(value);
    }
  }
}

// ------- Going to a match -------
function mdvXsChoose(i, event) {
  const opt = mdvXs.options[i];
  if (!opt) return;
  const q = (mdvXs.lastResult && mdvXs.lastResult.q) || mdvXs.query.trim().toLowerCase();
  const context = mdvXsContext(opt.doc, opt.at, q);
  const newWindow = !!(event && (event.metaKey || event.ctrlKey));
  mdvXsClose({ restoreFocus: false });
  mdvFolderOpenFile(opt.path, { newWindow, then: () => mdvXsReveal(q, context) });
}

// What identifies the match in the rendered page: the words around it, which occurrence it is in the file,
// and the heading above it in the source.
function mdvXsContext(doc, at, q) {
  const line = mdvXsLineOf(doc, at);
  const words = line.text.toLowerCase().replace(/[`*_~#>\[\]()!|\\-]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
  let occurrence = 0;
  const pattern = mdvXsPattern(q);
  for (let m = pattern.exec(doc.text); m && m.index < at; m = pattern.exec(doc.text)) occurrence++;
  let heading = null;
  const before = doc.text.slice(0, at);
  const re = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm;
  for (let m = re.exec(before); m; m = re.exec(before)) heading = m[1];
  return { words, occurrence, heading };
}

// The rendered block that holds the match. Every block of the page that holds the words is a candidate, taken in
// reading order (the document search's index lists every heading before every block), with the occurrences of the
// words it holds numbered through the page as they are in the file. A candidate scores
//   10 for each word of the match's line (3 letters or more) it holds,
//   5 when it sits under the heading the match sits under in the file,
//   less the distance between the match's occurrence number and the ones it holds;
// the best wins, the earliest on a tie. So a line with no long word ("- v2") still finds its block by where it falls
// in the file. With no candidate (the words are in a diagram's source, say), the heading above the match.
function mdvXsReveal(q, context) {
  const index = typeof mdvSearchIndex === 'function' ? mdvSearchIndex() : [];
  const candidates = index.filter((b) => b.lower.includes(q) && b.element && b.element.isConnected);
  candidates.sort((a, b) => (a.element === b.element ? 0
    : a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const heading = context.heading ? context.heading.replace(/[`*_~]/g, '').trim().toLowerCase() : null;
  let target = null;
  let best = -Infinity;
  let seen = 0; // occurrences in the blocks before this one
  for (const b of candidates) {
    let held = 0;
    for (let at = b.lower.indexOf(q); at >= 0; at = b.lower.indexOf(q, at + q.length)) held++;
    const first = seen, last = seen + Math.max(1, held) - 1;
    seen += held;
    const distance = context.occurrence < first ? first - context.occurrence : context.occurrence > last ? context.occurrence - last : 0;
    const overlap = context.words.reduce((n, w) => n + (b.lower.includes(w) ? 1 : 0), 0);
    const section = b.type === 'heading' ? b.lower : (b.headingText || '').toLowerCase();
    const under = heading && section === heading ? 1 : 0;
    const score = overlap * 10 + under * 5 - distance;
    if (score > best) { best = score; target = b.element; }
  }
  if (!target && heading) {
    target = [...document.querySelectorAll('#mdBody h1, #mdBody h2, #mdBody h3, #mdBody h4, #mdBody h5, #mdBody h6')]
      .find((h) => mdvHeadingText(h).toLowerCase() === heading) || null;
  }
  if (!target) return false;
  mdvGoTo(target, { flash: true });
  mdvXsHighlight(target, q);
  return true;
}

// Marks the words themselves for a few seconds with the CSS Custom Highlight API (nothing in the document
// changes). Browsers without it get the flash alone.
function mdvXsHighlight(el, q) {
  if (!(window.CSS && CSS.highlights && typeof Highlight === 'function')) return;
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (p && p.closest('.section-toggle, .header-anchor, .mdv-chip, .code-header, [aria-hidden="true"]')) continue;
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return;
  const ranges = [];
  for (let at = lower.indexOf(q); at >= 0 && ranges.length < 20; at = lower.indexOf(q, at + q.length)) {
    const locate = (pos) => {
      for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].start <= pos) return { node: nodes[i].node, offset: pos - nodes[i].start };
      return null;
    };
    const from = locate(at), to = locate(at + q.length);
    if (!from || !to) continue;
    const r = document.createRange();
    r.setStart(from.node, from.offset);
    r.setEnd(to.node, to.offset);
    ranges.push(r);
  }
  if (!ranges.length) return;
  CSS.highlights.set('mdv-folder-match', new Highlight(...ranges));
  clearTimeout(mdvXs.highlightTimer);
  mdvXs.highlightTimer = setTimeout(() => CSS.highlights.delete('mdv-folder-match'), 4000);
}

// ------- Opening and closing -------
function mdvXsIsOpen() { return !!(mdvModal && mdvXs.overlay && mdvModal.el === mdvXs.overlay); }

function mdvXsOpen() {
  if (!mdvXs.overlay) mdvXsBuild();
  mdvOpenModal(mdvXs.overlay, { label: 'Search in files', focus: mdvXs.input });
  mdvXs.input.select();
  mdvXsRenderStatus();
  mdvXsRefreshIndex().then((changed) => {
    if (!mdvXsIsOpen()) return;
    if (changed || !mdvXs.lastResult) mdvXsRun(mdvXs.input.value);
    else mdvXsRenderStatus();
  });
  if (mdvXs.input.value.trim().length >= 2) mdvXsRun(mdvXs.input.value);
}

function mdvXsClose(opts) { if (mdvXs.overlay) mdvCloseModal(mdvXs.overlay, opts); }

mdvRegisterActions({
  'folder-search':          { click: () => { if (mdvFolderState.kind) mdvXsOpen(); } },
  'folder-search-backdrop': { click: (el, arg, event) => { if (event.target === el) mdvXsClose(); } },
});

// With a folder open the key always searches, whether or not the sidebar is shown: a narrow window hides it, and a
// reader who hid it still has the folder. The fold row it shares the keys with says when it applies.
document.addEventListener('DOMContentLoaded', () => {
  const sameKeys = (row) => row.mod && row.shift && row.key === 'f';
  mdvFolderRelabelShortcut((row) => sameKeys(row) && /fold/i.test(row.label), 'Fold or unfold all sections (no folder open)');
  mdvFolderAddShortcut({
    mod: true, shift: true, key: 'f', label: 'Search in the folder’s files', modal: 'mdvFolderSearch',
    run: () => {
      if (mdvXsIsOpen()) mdvXsClose();
      else if (mdvFolderState.kind) mdvXsOpen();
      else toggleAllSections();
    },
  }, sameKeys);
});
