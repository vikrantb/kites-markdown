// ============================================
// The folder sidebar: the folder's Markdown files as a tree
// ============================================
// A panel at the left edge, before the outline: the folder's name and its tools (go to a file, search in
// files, refresh, another folder, hide), a filter box, and the tree. The document on screen is marked and
// kept in view. A click (or Enter) opens a file through mdvOpenDocument; Cmd/Ctrl-click opens it in its own
// window in the desktop app, as a link does.
//
// The tree follows the WAI-ARIA tree pattern as a flat list: each row is a treeitem with aria-level,
// aria-setsize and aria-posinset, folders carry aria-expanded, and one row at a time is in the Tab order.
// Keys: Up and Down move, Right opens a folder (or moves into it), Left closes it (or moves to its parent),
// Home and End, Enter or Space opens, and typing a name's first letters moves to it. From the filter box,
// Down moves into the tree and Enter opens the first match.
//
// Names come from the file system and are only ever set as text, never parsed as HTML.

const mdvTree = {
  panel: null, tree: null, filter: null, status: null, empty: null, name: null,
  expanded: new Set(),   // folders the reader opened ('' is the root, always open)
  seenRoot: null,        // the folder the expansion state belongs to
  focusRel: null,        // the row that is in the Tab order
  typed: '', typedAt: 0, // type-ahead
  rows: [],              // the rows drawn: {node, el}
  filterTimer: 0,
};

const MDV_TREE_ROW_LIMIT = MDV_FOLDER_LIMITS.entries; // every file the listing holds can be drawn
// A folder this small is shown fully opened: nothing to dig for.
const MDV_TREE_OPEN_ALL_UNDER = 40;

const MDV_TREE_ICONS = {
  quickOpen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 14l2 2 4-4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="9" x2="14" y2="9"/><line x1="8" y1="13" x2="12" y2="13"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
  choose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="9.5" y1="13.5" x2="14.5" y2="13.5"/></svg>',
  hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6 8v5l-4 2v-7z"/></svg>',
};

function mdvTreeButton(action, label, icon, shortcut) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mdv-folder-tool';
  b.dataset.action = action;
  b.setAttribute('aria-label', label);
  b.title = shortcut ? `${label} (${shortcut})` : label;
  b.innerHTML = icon; // the viewer's own icon markup, never document data
  return b;
}

function mdvTreeKeys(shift, key) {
  const mod = MDV_IS_MAC_FOLDER ? '⌘' : 'Ctrl+';
  return mod + (shift ? (MDV_IS_MAC_FOLDER ? '⇧' : 'Shift+') : '') + key;
}
const MDV_IS_MAC_FOLDER = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

function mdvTreeBuildPanel() {
  const panel = document.createElement('aside');
  panel.className = 'mdv-folder';
  panel.id = 'mdvFolderPanel';
  panel.setAttribute('aria-label', 'Folder');
  panel.hidden = true;

  const head = document.createElement('div');
  head.className = 'mdv-folder-head';
  const name = document.createElement('span');
  name.className = 'mdv-folder-name';
  name.id = 'mdvFolderName';
  name.textContent = 'Folder';
  const tools = document.createElement('div');
  tools.className = 'mdv-folder-tools';
  tools.append(
    mdvTreeButton('folder-quick-open', 'Go to a file', MDV_TREE_ICONS.quickOpen, mdvTreeKeys(false, 'P')),
    mdvTreeButton('folder-search', 'Search in files', MDV_TREE_ICONS.search, mdvTreeKeys(true, 'F')),
    mdvTreeButton('folder-refresh', 'List the folder again', MDV_TREE_ICONS.refresh),
    mdvTreeButton('folder-choose', 'Open another folder…', MDV_TREE_ICONS.choose),
    mdvTreeButton('folder-toggle', 'Hide the folder', MDV_TREE_ICONS.hide),
  );
  head.append(name, tools);

  const filterWrap = document.createElement('div');
  filterWrap.className = 'mdv-folder-filter';
  filterWrap.innerHTML = MDV_TREE_ICONS.filter;
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.id = 'mdvFolderFilter';
  filter.placeholder = 'Filter files';
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  filter.setAttribute('aria-label', 'Filter files');
  filter.setAttribute('aria-controls', 'mdvFolderTree');
  filterWrap.appendChild(filter);

  const status = document.createElement('div');
  status.className = 'mdv-folder-status';
  status.id = 'mdvFolderStatus';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const tree = document.createElement('ul');
  tree.className = 'mdv-folder-tree';
  tree.id = 'mdvFolderTree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Files');

  const empty = document.createElement('div');
  empty.className = 'mdv-folder-empty';
  empty.id = 'mdvFolderEmpty';

  panel.append(head, filterWrap, status, tree, empty);
  Object.assign(mdvTree, { panel, tree, filter, status, empty, name });

  filter.addEventListener('input', () => {
    clearTimeout(mdvTree.filterTimer);
    mdvTree.filterTimer = setTimeout(mdvTreeRender, 60);
  });
  filter.addEventListener('keydown', mdvTreeFilterKeys);
  tree.addEventListener('click', mdvTreeClick);
  tree.addEventListener('keydown', mdvTreeKeydown);
  tree.addEventListener('focusin', (e) => {
    const li = e.target.closest && e.target.closest('[role="treeitem"]');
    if (li) mdvTreeSetFocusRel(li.dataset.rel, false);
  });

  const layout = document.querySelector('.layout');
  (layout || document.body).prepend(panel);
}

// ------- Showing and hiding the panel -------
function mdvTreeShown() { return !!mdvTree.panel && !mdvTree.panel.hidden; }
const mdvTreeNarrow = window.matchMedia('(max-width: 900px)');

// persist: false when the window, not the reader, decided (narrowing it hides the panel; it is not a preference).
function mdvTreeShow(on, { persist = true } = {}) {
  if (!mdvTree.panel) return;
  mdvTree.panel.hidden = !on;
  document.body.classList.toggle('mdv-folder-open', on);
  const btn = document.getElementById('mdvFolderBtn');
  if (btn) {
    btn.setAttribute('aria-expanded', String(on));
    btn.classList.toggle('active', on);
  }
  if (persist) mdvFolderStorage('mdv-folder-panel', on ? 'open' : 'closed');
  if (on) mdvTreeRender();
}

// The toolbar button: shows the folder (opening one first when there is none), or hides it.
async function mdvTreeToggle() {
  if (mdvTreeShown()) {
    const hadFocus = mdvTree.panel.contains(document.activeElement);
    mdvTreeShow(false);
    if (hadFocus) { const btn = document.getElementById('mdvFolderBtn'); if (btn) btn.focus(); }
    return;
  }
  mdvTreeShow(true);
  if (!mdvFolderState.kind) await mdvFolderOpen();
  else if (Date.now() - mdvFolderState.listedAt > MDV_FOLDER_STALE_MS && !mdvFolderState.loading) mdvFolderRefresh();
  mdvTreeFocus();
}

function mdvTreeFocus() {
  if (!mdvTreeShown()) return;
  const row = mdvTree.tree.querySelector('[role="treeitem"][tabindex="0"]');
  if (row) row.focus({ preventScroll: false });
  else if (mdvFolderState.kind) mdvTree.filter.focus();
}

// ------- The model: folders and files as nodes -------
function mdvTreeModel(entries) {
  const root = { type: 'dir', name: '', rel: '', children: [], files: 0, parent: null };
  const dirs = new Map([['', root]]);
  const dirOf = (rel) => {
    if (dirs.has(rel)) return dirs.get(rel);
    const i = rel.lastIndexOf('/');
    const parent = dirOf(i < 0 ? '' : rel.slice(0, i));
    const node = { type: 'dir', name: i < 0 ? rel : rel.slice(i + 1), rel, children: [], files: 0, parent };
    parent.children.push(node);
    dirs.set(rel, node);
    return node;
  };
  for (const e of entries) {
    const parent = dirOf(e.dir);
    parent.children.push({ type: 'file', name: e.name, rel: e.rel, path: e.path, parent });
    for (let d = parent; d; d = d.parent) d.files++;
  }
  return root;
}

function mdvTreeTerms() {
  return mdvTree.filter.value.toLowerCase().split(/\s+/).filter(Boolean);
}

// The rows to draw, in order: [{node, level, setsize, posinset}]. With a filter, only matching files and the
// folders that hold them, all open.
function mdvTreeRows(root, terms) {
  const rows = [];
  const matches = (node) => {
    if (node.type === 'file') {
      const rel = node.rel.toLowerCase();
      return terms.every((t) => rel.includes(t));
    }
    return node.children.some(matches);
  };
  const walk = (dir, level) => {
    const kids = terms.length ? dir.children.filter(matches) : dir.children;
    kids.forEach((node, i) => {
      if (rows.length >= MDV_TREE_ROW_LIMIT) return;
      rows.push({ node, level, setsize: kids.length, posinset: i + 1 });
      if (node.type === 'dir' && (terms.length || mdvTree.expanded.has(node.rel))) walk(node, level + 1);
    });
  };
  walk(root, 1);
  return rows;
}

function mdvTreeOpenAncestors(rel) {
  if (!rel) return;
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) mdvTree.expanded.add(parts.slice(0, i).join('/'));
}

// The text of a name with each filter term marked (text nodes only).
function mdvTreeLabel(name, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) { frag.append(name); return frag; }
  const lower = name.toLowerCase();
  if (lower.length !== name.length) { frag.append(name); return frag; }
  const marks = [];
  for (const t of terms) {
    for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + t.length)) marks.push([at, at + t.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  let i = 0;
  for (const [from, to] of marks) {
    if (from < i) continue;
    if (from > i) frag.append(name.slice(i, from));
    const m = document.createElement('mark');
    m.textContent = name.slice(from, to);
    frag.appendChild(m);
    i = to;
  }
  if (i < name.length) frag.append(name.slice(i));
  return frag;
}

// ------- Drawing -------
function mdvTreeRender() {
  if (!mdvTree.panel || !mdvTreeShown()) return;
  const s = mdvFolderState;
  mdvTreeRenderHead();
  mdvTreeRenderEmpty();
  const tree = mdvTree.tree;
  if (!s.kind || (!s.entries.length && s.loading)) {
    tree.replaceChildren();
    mdvTree.rows = [];
    mdvTreeRenderStatus(0, 0);
    return;
  }
  // A new folder starts with its own expansion: the current document's folders, or everything when it is small.
  const rootKey = s.kind + ':' + (s.kind === 'desktop' ? s.root : s.rootName);
  if (mdvTree.seenRoot !== rootKey) {
    mdvTree.seenRoot = rootKey;
    mdvTree.expanded = new Set();
    mdvTree.focusRel = null;
    if (s.entries.length <= MDV_TREE_OPEN_ALL_UNDER) for (const e of s.entries) mdvTreeOpenAncestors(e.rel);
  }
  const currentEntry = s.current ? s.byPath.get(s.current) : null;
  if (currentEntry) mdvTreeOpenAncestors(currentEntry.rel);

  const terms = mdvTreeTerms();
  const model = mdvTreeModel(s.entries);
  const rows = mdvTreeRows(model, terms);
  const visibleRels = new Set(rows.map((r) => r.node.rel));
  if (!mdvTree.focusRel || !visibleRels.has(mdvTree.focusRel)) {
    mdvTree.focusRel = currentEntry && visibleRels.has(currentEntry.rel) ? currentEntry.rel : (rows[0] ? rows[0].node.rel : null);
  }
  const hadFocus = tree.contains(document.activeElement);
  const frag = document.createDocumentFragment();
  mdvTree.rows = rows.map((r) => {
    const { node } = r;
    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    li.className = 'mdv-tree-item ' + (node.type === 'dir' ? 'is-dir' : 'is-file');
    li.dataset.rel = node.rel;
    li.dataset.type = node.type;
    li.setAttribute('aria-level', String(r.level));
    li.setAttribute('aria-setsize', String(r.setsize));
    li.setAttribute('aria-posinset', String(r.posinset));
    li.tabIndex = node.rel === mdvTree.focusRel ? 0 : -1;
    li.style.setProperty('--mdv-tree-level', String(r.level - 1));
    const row = document.createElement('span');
    row.className = 'mdv-tree-row';
    const twisty = document.createElement('span');
    twisty.className = 'mdv-tree-twisty';
    twisty.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'mdv-tree-label';
    label.appendChild(mdvTreeLabel(node.type === 'file' ? node.name.replace(MDV_FOLDER_MARKDOWN, '') : node.name, terms));
    row.append(twisty, label);
    if (node.type === 'dir') {
      const open = terms.length > 0 || mdvTree.expanded.has(node.rel);
      li.setAttribute('aria-expanded', String(open));
      const count = document.createElement('span');
      count.className = 'mdv-tree-count';
      count.textContent = String(node.files);
      count.setAttribute('aria-hidden', 'true');
      row.appendChild(count);
      li.setAttribute('aria-label', `${node.name}, ${node.files} file${node.files === 1 ? '' : 's'}`);
    } else {
      const ext = /\.([^.]+)$/.exec(node.name);
      if (ext && ext[1].toLowerCase() !== 'md') {
        const tag = document.createElement('span');
        tag.className = 'mdv-tree-ext';
        tag.textContent = ext[1];
        row.appendChild(tag);
      }
      li.dataset.path = node.path;
      li.setAttribute('aria-label', node.name);
      li.title = node.rel;
      const current = currentEntry && currentEntry.rel === node.rel;
      li.setAttribute('aria-selected', String(!!current));
      if (current) { li.classList.add('is-current'); li.setAttribute('aria-current', 'page'); }
    }
    li.appendChild(row);
    frag.appendChild(li);
    return { node, el: li };
  });
  tree.replaceChildren(frag);
  mdvTreeRenderStatus(rows.length, terms.length ? rows.filter((r) => r.node.type === 'file').length : null);
  if (hadFocus) {
    const focused = mdvTreeRowEl(mdvTree.focusRel);
    if (focused) focused.focus({ preventScroll: true });
  }
  const cur = tree.querySelector('.is-current');
  if (cur && !hadFocus) mdvTreeKeepInView(cur);
}

function mdvTreeRowEl(rel) {
  if (rel == null) return null;
  const hit = mdvTree.rows.find((r) => r.node.rel === rel);
  return hit ? hit.el : null;
}

function mdvTreeKeepInView(el) {
  const box = mdvTree.tree;
  const e = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (e.top < b.top) box.scrollTop += e.top - b.top - 24;
  else if (e.bottom > b.bottom) box.scrollTop += e.bottom - b.bottom + 24;
}

function mdvTreeRenderHead() {
  const s = mdvFolderState;
  const name = s.kind ? s.rootName : (s.waiting ? s.waiting.name : 'Folder');
  mdvTree.name.textContent = name || 'Folder';
  mdvTree.name.title = s.kind === 'desktop' ? s.root : name;
  mdvTree.panel.setAttribute('aria-label', s.kind ? `Folder: ${name}` : 'Folder');
  mdvTree.tree.setAttribute('aria-label', s.kind ? `Files in ${name}` : 'Files');
  for (const b of mdvTree.panel.querySelectorAll('.mdv-folder-tool')) {
    const needsFolder = b.dataset.action !== 'folder-toggle' && b.dataset.action !== 'folder-choose';
    b.disabled = needsFolder && !s.kind;
  }
  mdvTree.filter.disabled = !s.kind;
}

function mdvTreeRenderStatus(rowCount, matchedFiles) {
  const s = mdvFolderState;
  const n = s.entries.length;
  const plural = (k, one, many) => `${k.toLocaleString()} ${k === 1 ? one : many}`;
  let text = '';
  if (s.loading && !n) text = s.progress ? `Listing… ${plural(s.progress, 'file', 'files')} so far` : 'Listing the folder…';
  else if (s.error) text = s.error;
  else if (s.kind) {
    text = matchedFiles != null ? `${plural(matchedFiles, 'file matches', 'files match')} of ${n.toLocaleString()}` : plural(n, 'Markdown file', 'Markdown files');
    if (rowCount >= MDV_TREE_ROW_LIMIT) text += ` (the first ${MDV_TREE_ROW_LIMIT.toLocaleString()} rows: type more to narrow it)`;
    if (s.truncated) text += ` · the listing stopped at ${MDV_FOLDER_LIMITS.entries.toLocaleString()} files or ${MDV_FOLDER_LIMITS.depth} folders deep`;
    if (s.unreadable) text += ` · ${plural(s.unreadable, 'folder', 'folders')} could not be read`;
  }
  mdvTree.status.textContent = text;
  mdvTree.status.classList.toggle('is-error', !!s.error);
}

// The panel's message when there is no tree to show.
function mdvTreeRenderEmpty() {
  const s = mdvFolderState;
  const box = mdvTree.empty;
  box.replaceChildren();
  let message = '', actions = [];
  if (s.kind && !s.loading && !s.entries.length && !s.error) {
    message = 'No Markdown files here. Folders whose names start with a dot, and node_modules, are not looked in.';
    actions = [['folder-choose', 'Open another folder…', false]];
  } else if (!s.kind && s.waiting) {
    message = `Reconnect to “${s.waiting.name}”: the browser asks again before the viewer may read it.`;
    actions = [['folder-reconnect', 'Reconnect', true], ['folder-choose', 'Open another folder…', false]];
  } else if (!s.kind && !s.loading) {
    const supported = mdvFolderIsDesktop() || 'showDirectoryPicker' in window;
    message = supported
      ? 'Open a folder to see its Markdown files here, jump to any of them, and search them all.'
      : 'Opening a folder needs Chrome, Edge or another Chromium browser: Firefox and Safari cannot list a folder.';
    if (supported) actions = [['folder-open', 'Open a folder…', true]];
  } else if (s.error && !s.entries.length) {
    actions = [['folder-refresh', 'Try again', true], ['folder-choose', 'Open another folder…', false]];
  }
  box.hidden = !message && !actions.length;
  if (message) {
    const p = document.createElement('p');
    p.textContent = message;
    box.appendChild(p);
  }
  for (const [action, label, primary] of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'mdv-folder-primary' : 'mdv-folder-secondary';
    b.dataset.action = action;
    b.textContent = label;
    box.appendChild(b);
  }
}

// ------- Using the tree -------
function mdvTreeSetFocusRel(rel, move) {
  mdvTree.focusRel = rel;
  for (const r of mdvTree.rows) r.el.tabIndex = r.node.rel === rel ? 0 : -1;
  if (move) {
    const el = mdvTreeRowEl(rel);
    if (el) { el.focus({ preventScroll: true }); mdvTreeKeepInView(el); }
  }
}

function mdvTreeToggleDir(rel, open) {
  const isOpen = mdvTree.expanded.has(rel);
  const want = open === undefined ? !isOpen : open;
  if (want === isOpen || mdvTreeTerms().length) return false;
  if (want) mdvTree.expanded.add(rel); else mdvTree.expanded.delete(rel);
  mdvTreeRender();
  return true;
}

function mdvTreeOpenFileRow(node, event) {
  const newWindow = !!(event && (event.metaKey || event.ctrlKey));
  if (mdvTreeNarrow.matches && !newWindow) mdvTreeShow(false, { persist: false });
  mdvFolderOpenFile(node.path, { newWindow });
}

function mdvTreeClick(e) {
  const li = e.target.closest('[role="treeitem"]');
  if (!li) return;
  const row = mdvTree.rows.find((r) => r.el === li);
  if (!row) return;
  mdvTreeSetFocusRel(row.node.rel, true);
  if (row.node.type === 'dir') mdvTreeToggleDir(row.node.rel);
  else mdvTreeOpenFileRow(row.node, e);
}

function mdvTreeKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const rows = mdvTree.rows;
  const i = rows.findIndex((r) => r.node.rel === mdvTree.focusRel);
  if (i < 0) return;
  const { node } = rows[i];
  const go = (j) => { if (rows[j]) mdvTreeSetFocusRel(rows[j].node.rel, true); };
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  switch (e.key) {
    case 'ArrowDown': handled(); go(Math.min(rows.length - 1, i + 1)); return;
    case 'ArrowUp': handled(); go(Math.max(0, i - 1)); return;
    case 'Home': handled(); go(0); return;
    case 'End': handled(); go(rows.length - 1); return;
    case 'ArrowRight':
      handled();
      if (node.type === 'dir') {
        if (!mdvTreeToggleDir(node.rel, true) && rows[i + 1] && rows[i + 1].node.parent === node) go(i + 1);
        else mdvTreeSetFocusRel(node.rel, true);
      }
      return;
    case 'ArrowLeft':
      handled();
      if (node.type === 'dir' && mdvTree.expanded.has(node.rel) && !mdvTreeTerms().length) { mdvTreeToggleDir(node.rel, false); mdvTreeSetFocusRel(node.rel, true); }
      else if (node.parent && node.parent.rel !== '') mdvTreeSetFocusRel(node.parent.rel, true);
      return;
    case 'Enter':
    case ' ':
      handled();
      if (node.type === 'dir') { mdvTreeToggleDir(node.rel); mdvTreeSetFocusRel(node.rel, true); }
      else mdvTreeOpenFileRow(node, e);
      return;
    case 'Escape':
      if (mdvTree.filter.value) { handled(); mdvTree.filter.value = ''; mdvTreeRender(); mdvTreeSetFocusRel(mdvTree.focusRel, true); }
      else if (mdvTreeNarrow.matches) { handled(); mdvTreeShow(false); }
      return;
    default:
      break;
  }
  // Type-ahead: the next row whose name starts with what was typed in the last half second.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
    handled();
    const now = Date.now();
    mdvTree.typed = (now - mdvTree.typedAt < 600 ? mdvTree.typed : '') + e.key.toLowerCase();
    mdvTree.typedAt = now;
    const n = rows.length;
    const start = mdvTree.typed.length === 1 ? i + 1 : i;
    for (let k = 0; k < n; k++) {
      const r = rows[(start + k) % n];
      if (r.node.name.toLowerCase().startsWith(mdvTree.typed)) { mdvTreeSetFocusRel(r.node.rel, true); break; }
    }
  }
}

function mdvTreeFilterKeys(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown' && mdvTree.rows.length) {
    e.preventDefault();
    mdvTreeSetFocusRel(mdvTree.rows[0].node.rel, true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(mdvTree.filterTimer);
    mdvTreeRender();
    const first = mdvTree.rows.find((r) => r.node.type === 'file');
    if (first) mdvTreeOpenFileRow(first.node, e);
  } else if (e.key === 'Escape' && mdvTree.filter.value) {
    e.preventDefault();
    e.stopPropagation();
    mdvTree.filter.value = '';
    mdvTreeRender();
  }
}

mdvRegisterActions({
  'folder-toggle':     { click: () => mdvTreeToggle() },
  'folder-open':       { click: () => mdvFolderOpen().then((ok) => { if (ok) mdvTreeFocus(); }) },
  'folder-choose':     { click: () => mdvFolderChoose().then((ok) => { if (ok) { mdvTreeShow(true); mdvTreeFocus(); } }) },
  'folder-reconnect':  { click: () => mdvFolderReconnect().then((ok) => { if (ok) mdvTreeFocus(); }) },
  'folder-refresh':    { click: () => mdvFolderRefresh() },
});

mdvTreeBuildPanel();
// A new current document: when its row is already drawn, only the marks move (opening a file in a large folder
// does not redraw the tree); otherwise the tree opens the folders down to it.
function mdvTreeMarkCurrent() {
  if (!mdvTreeShown()) return;
  const s = mdvFolderState;
  const entry = s.current ? s.byPath.get(s.current) : null;
  const row = entry ? mdvTreeRowEl(entry.rel) : null;
  if (entry && !row) { mdvTreeRender(); return; }
  for (const el of mdvTree.tree.querySelectorAll('.is-current')) {
    el.classList.remove('is-current');
    el.removeAttribute('aria-current');
    el.setAttribute('aria-selected', 'false');
  }
  if (!row) return;
  row.classList.add('is-current');
  row.setAttribute('aria-current', 'page');
  row.setAttribute('aria-selected', 'true');
  if (!mdvTree.tree.contains(document.activeElement)) mdvTreeKeepInView(row);
}

mdvFolderOn('change', mdvTreeRender);
mdvFolderOn('current', mdvTreeMarkCurrent);
mdvTreeNarrow.addEventListener('change', () => { if (mdvTreeShown() && mdvTreeNarrow.matches) mdvTreeShow(false, { persist: false }); });
// The panel comes back as the reader left it.
if (mdvFolderStorage('mdv-folder-panel') === 'open' && !mdvTreeNarrow.matches) mdvTreeShow(true);
