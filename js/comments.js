// ============================================
// MDV Comments — embedded threaded annotations
// ============================================
// Storage format:
//   Inline marker: <!-- MDV-ANCHOR id="..." --> placed BEFORE target block
//   Trailing block: <!-- MDV-COMMENTS:v1 ... MDV-COMMENTS:end --> at end of file (single JSON payload)
// All markers use the MDV- namespace prefix; other CommonMark renderers ignore HTML comments.

const MDV_VERSION = 1;
const MDV_RE_BLOCK = /<!--\s*MDV-COMMENTS:v(\d+)\s*([\s\S]*?)\s*MDV-COMMENTS:end\s*-->/;
const MDV_RE_ANCHOR = /<!--\s*MDV-ANCHOR\s+id="([a-zA-Z0-9_-]+)"\s*-->/g;

let mdvComments = [];      // flat list of {id, parent_id, anchor, author, body_md, created_at, updated_at, status}
let mdvFileHandle = null;  // FileSystemFileHandle | null
let mdvWorkspaceDir = null; // FileSystemDirectoryHandle | null — pick folder once, all files inside save silently
let mdvDirty = false;
let mdvSaveTimer = null;
let mdvLastSavedAt = null;
let mdvAuthorName = localStorage.getItem('mdv-author-name') || 'You';
const _mdvDmp = (typeof diff_match_patch !== 'undefined') ? new diff_match_patch() : null;

// ------- Parse / serialize -------
function mdvParseFile(src) {
  const m = src.match(MDV_RE_BLOCK);
  if (!m) return { stripped: src, comments: [], parseError: null };
  let comments = [];
  let parseError = null;
  try {
    const json = m[2].replace(/\\u002d/g, '-').replace(/\\u003c/g, '<');
    const obj = JSON.parse(json);
    comments = Array.isArray(obj.comments) ? obj.comments : [];
  } catch (e) {
    parseError = e.message;
  }
  return { stripped: src, comments, parseError };
}

function mdvSerialize(src, comments) {
  const noBlock = src.replace(MDV_RE_BLOCK, '').replace(/\n+$/, '');
  if (!comments || comments.length === 0) return noBlock + '\n';
  const json = JSON.stringify({ version: MDV_VERSION, generator: 'mdv-viewer', comments });
  // Escape sequences that would break out of the HTML comment: --, <
  const safe = json.replace(/--/g, '-\\u002d').replace(/</g, '\\u003c');
  return noBlock + '\n\n<!-- MDV-COMMENTS:v' + MDV_VERSION + '\n' + safe + '\nMDV-COMMENTS:end -->\n';
}

// ------- Anchor utilities -------
function mdvShortId() {
  return 'c_' + Math.random().toString(36).slice(2, 12);
}
function mdvNormalize(t) { return (t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

async function mdvHash(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf, 0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function mdvComputeAnchor(elem, selectionText) {
  const blockText = (elem.innerText || elem.textContent || '').trim();
  const blockHash = await mdvHash(mdvNormalize(blockText));
  const sibIdx = Array.from(elem.parentNode ? elem.parentNode.children : []).indexOf(elem);
  const id = mdvShortId();
  let quote = null;
  if (selectionText) {
    const fullText = elem.innerText || '';
    const i = fullText.indexOf(selectionText);
    if (i >= 0) {
      quote = {
        exact: selectionText,
        prefix: fullText.slice(Math.max(0, i - 32), i),
        suffix: fullText.slice(i + selectionText.length, i + selectionText.length + 32)
      };
    } else {
      quote = { exact: selectionText, prefix: '', suffix: '' };
    }
  }
  return { id, blockKind: elem.tagName.toLowerCase(), blockHash, sibIdx, quote };
}

// Find map of anchor-id -> DOM element by walking comment nodes in render
function mdvBuildAnchorMap(container) {
  const map = {};
  if (!container) return map;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT);
  let node;
  while ((node = walker.nextNode())) {
    const m = node.nodeValue.match(/^\s*MDV-ANCHOR\s+id="([a-zA-Z0-9_-]+)"\s*$/);
    if (m) {
      let next = node.nextSibling;
      // skip text-node whitespace
      while (next && next.nodeType !== 1) next = next.nextSibling;
      if (next) map[m[1]] = next;
    }
  }
  return map;
}

// Resolve anchor to DOM element; returns {elem, strength: 'exact'|'fuzzy'|'orphan'}
function mdvResolveAnchor(anchor, container) {
  // Level 1: marker by ID
  const idMap = mdvBuildAnchorMap(container);
  if (anchor.id && idMap[anchor.id]) return { elem: idMap[anchor.id], strength: 'exact' };
  // Level 2 (synchronous fallback): match by sibling-index + tag — approximate
  if (anchor.blockKind && typeof anchor.sibIdx === 'number') {
    const candidates = container.querySelectorAll(anchor.blockKind);
    if (candidates[anchor.sibIdx]) return { elem: candidates[anchor.sibIdx], strength: 'weak' };
  }
  // Level 3: fuzzy match the quote text
  if (anchor.quote && anchor.quote.exact && _mdvDmp) {
    _mdvDmp.Match_Threshold = 0.5;
    _mdvDmp.Match_Distance = 1000;
    const flat = container.innerText || '';
    const idx = _mdvDmp.match_main(flat, anchor.quote.exact, 0);
    if (idx !== -1) {
      let cursor = 0;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (cursor + n.nodeValue.length >= idx) {
          let el = n.parentElement;
          const blockKinds = ['P','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','TD','DT','DD'];
          while (el && !blockKinds.includes(el.tagName)) el = el.parentElement;
          if (el) return { elem: el, strength: 'fuzzy' };
          break;
        }
        cursor += n.nodeValue.length;
      }
    }
  }
  return { elem: null, strength: 'orphan' };
}

// ------- File handle persistence (IndexedDB) -------
const MDV_DB = 'mdv-viewer';
const MDV_STORE = 'handles';
function mdvOpenDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(MDV_DB, 1);
    r.onupgradeneeded = (e) => e.target.result.createObjectStore(MDV_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function mdvPutHandle(key, h) {
  const db = await mdvOpenDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(MDV_STORE, 'readwrite');
    tx.objectStore(MDV_STORE).put(h, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function mdvGetHandle(key) {
  try {
    const db = await mdvOpenDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(MDV_STORE, 'readonly');
      const r = tx.objectStore(MDV_STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch (e) { return null; }
}

// ------- File picking + saving -------
async function mdvPickFile() {
  if (!('showOpenFilePicker' in window)) {
    mdvShowToast('Browser does not support in-place save. Drag-drop a file and use "Download with comments" to save changes.', 'error');
    document.getElementById('mdFile').click();
    return;
  }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'Markdown', accept: { 'text/plain': ['.md', '.markdown', '.txt'] } }]
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw e;
  }
  await mdvOpenWithHandle(handle);
}

async function mdvOpenWithHandle(handle) {
  if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      mdvShowToast('Read-only access; comments will not save back to disk.', 'error');
    }
  }
  mdvFileHandle = handle;
  await mdvPutHandle('current', handle);
  const file = await handle.getFile();
  const text = await file.text();
  rawMarkdown = text;
  currentFileName = file.name;
  renderMarkdown(text, file.name);
}

// Prompt for save location via showSaveFilePicker. Must be invoked from a
// user-gesture chain (button click, etc.) — Chromium blocks otherwise.
// Returns the handle (now also stored in mdvFileHandle + IDB), or null.
async function mdvEnsureWritableHandle() {
  if (mdvFileHandle) {
    if ((await mdvFileHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      try {
        const p = await mdvFileHandle.requestPermission({ mode: 'readwrite' });
        if (p !== 'granted') return null;
      } catch (e) { return null; }
    }
    return mdvFileHandle;
  }
  if (!('showSaveFilePicker' in window)) return null;
  try {
    const h = await window.showSaveFilePicker({
      suggestedName: currentFileName || 'document.md',
      types: [{
        description: 'Markdown',
        accept: { 'text/plain': ['.md', '.markdown', '.txt'] }
      }]
    });
    mdvFileHandle = h;
    try { await mdvPutHandle('current', h); } catch (e) {}
    return h;
  } catch (e) {
    if (e.name !== 'AbortError') console.error('mdvEnsureWritableHandle error:', e);
    return null;
  }
}

async function mdvSaveFile(opts) {
  opts = opts || {};
  const allowPrompt = opts.allowPrompt === true;
  const silent = opts.silent === true;
  if (mdvSaveTimer) { clearTimeout(mdvSaveTimer); mdvSaveTimer = null; }
  // No handle: try to get one (only if we're in gesture)
  let handle = mdvFileHandle;
  if (!handle && allowPrompt) handle = await mdvEnsureWritableHandle();
  if (!handle) {
    if (!('showSaveFilePicker' in window)) {
      // Firefox/Safari — download is the only option
      mdvShowToast('Browser does not support in-place save. Downloading instead.', 'error');
      return mdvDownloadFallback();
    }
    // Chromium without handle: refuse to silently download. Auto-save will
    // park here until the user provides a save location.
    mdvSetStatus('Click 📄 or Cmd+S to set save location', 'error');
    mdvDirty = true;
    return false;
  }
  if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if (!allowPrompt) {
      mdvSetStatus('Click 📄 or Cmd+S to grant write permission', 'error');
      return false;
    }
    try {
      const p = await handle.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') { mdvSetStatus('Permission denied', 'error'); return false; }
    } catch (e) {
      mdvSetStatus('Permission required', 'error');
      return false;
    }
  }
  const text = mdvSerialize(rawMarkdown, mdvComments);
  rawMarkdown = text;
  try {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    mdvDirty = false;
    mdvLastSavedAt = Date.now();
    if (!silent) mdvSetStatus('Saved ✓');
    setTimeout(() => { if (Date.now() - mdvLastSavedAt > 2500) mdvSetStatus(''); }, 3000);
    return true;
  } catch (e) {
    mdvSetStatus('Save failed', 'error');
    console.error('MDV save failed:', e);
    return false;
  }
}

function mdvDownloadFallback() {
  const text = mdvSerialize(rawMarkdown, mdvComments);
  rawMarkdown = text;
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = currentFileName || 'document.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  mdvSetStatus('Downloaded — replace original to persist');
  return true;
}

function mdvScheduleSave() {
  mdvDirty = true;
  if (mdvFileHandle) mdvSetStatus('Saving…', 'saving');
  if (mdvSaveTimer) clearTimeout(mdvSaveTimer);
  mdvSaveTimer = setTimeout(() => mdvSaveFile({ allowPrompt: false }), 1500);
}

function mdvSetStatus(text, kind) {
  const el = document.getElementById('mdvSaveStatus');
  if (!el) return;
  el.style.display = text ? '' : 'none';
  el.textContent = text;
  el.className = 'mdv-save-status' + (kind === 'saving' ? ' mdv-status-saving' : (kind === 'error' ? ' mdv-status-error' : ''));
}

// ------- UI -------
function mdvShowToast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'mdv-toast' + (kind === 'error' ? ' mdv-toast-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
}

function mdvEscape(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function mdvThreadTree() {
  const byId = {};
  mdvComments.forEach(c => byId[c.id] = Object.assign({}, c, { replies: [] }));
  const roots = [];
  Object.values(byId).forEach(c => {
    if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(c);
    else if (!c.parent_id) roots.push(c);
  });
  const sortFn = (a, b) => (a.created_at || '').localeCompare(b.created_at || '');
  roots.sort(sortFn);
  Object.values(byId).forEach(c => c.replies.sort(sortFn));
  return roots;
}

function mdvToggleSidebar(force) {
  const sb = document.getElementById('mdvSidebar');
  const willOpen = (force === true) || (force == null && !sb.classList.contains('open'));
  sb.classList.toggle('open', willOpen);
  document.body.classList.toggle('mdv-sidebar-open', willOpen);
  document.getElementById('mdvToggleBtn').classList.toggle('mdv-active', willOpen);
  sb.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
}

function mdvRenderSidebar() {
  const list = document.getElementById('mdvThreadList');
  if (!list) return;
  const status = document.getElementById('mdvSidebarStatus');
  list.innerHTML = '';
  const roots = mdvThreadTree();
  if (roots.length === 0) {
    list.innerHTML = '<div class="mdv-empty">No comments yet.<br>Right-click any paragraph or select text to add one.</div>';
    if (status) status.textContent = '';
  } else {
    if (status) status.textContent = roots.length + ' thread' + (roots.length === 1 ? '' : 's');
  }
  const idMap = mdvBuildAnchorMap(document.getElementById('mdBody'));
  roots.forEach(thread => {
    const card = document.createElement('div');
    card.className = 'mdv-thread' + (thread.status === 'resolved' ? ' mdv-resolved' : '');
    card.dataset.threadId = thread.id;
    const elem = thread.anchor && idMap[thread.anchor.id];
    const isOrphan = !elem && thread.anchor;
    if (isOrphan) card.classList.add('mdv-orphan');
    card.innerHTML = mdvRenderThreadCard(thread, isOrphan);
    list.appendChild(card);
    // Wire reply submit
    const ta = card.querySelector('.mdv-reply-input');
    const replyBtn = card.querySelector('.mdv-reply-btn');
    if (replyBtn) replyBtn.onclick = () => mdvPostReply(thread.id, ta);
    if (ta) ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') mdvPostReply(thread.id, ta);
    });
    const resBtn = card.querySelector('.mdv-resolve-btn');
    if (resBtn) resBtn.onclick = () => mdvResolveThread(thread.id);
    const delBtn = card.querySelector('.mdv-delete-btn');
    if (delBtn) delBtn.onclick = () => mdvDeleteThread(thread.id);
  });
  mdvRenderChips();
  // Update toolbar badge
  const badge = document.getElementById('mdvBadge');
  if (badge) {
    const open = roots.filter(t => t.status !== 'resolved').length;
    badge.textContent = open || '';
    badge.style.display = open ? '' : 'none';
  }
  // Show toggle button now that we have a doc loaded
  const tgl = document.getElementById('mdvToggleBtn');
  if (tgl) tgl.style.display = '';
}

function mdvRenderThreadCard(thread, isOrphan) {
  const quote = (thread.anchor && thread.anchor.quote && thread.anchor.quote.exact) || '(block)';
  let html = '<div class="mdv-thread-head">';
  html += '<div class="mdv-quote' + (isOrphan ? ' mdv-quote-orphan' : '') + '">' + mdvEscape(quote.slice(0, 140)) + '</div>';
  html += '</div>';
  html += '<div class="mdv-replies">';
  html += mdvRenderCommentBody(thread);
  thread.replies.forEach(r => { html += mdvRenderCommentBody(r); });
  html += '</div>';
  if (thread.status !== 'resolved') {
    html += '<div class="mdv-reply-row">';
    html += '<textarea class="mdv-reply-input" placeholder="Reply… (Cmd+Enter to send)"></textarea>';
    html += '<div class="mdv-reply-actions">';
    html += '<button class="mdv-btn mdv-delete-btn" title="Delete thread">Delete</button>';
    html += '<button class="mdv-btn mdv-resolve-btn">Resolve</button>';
    html += '<button class="mdv-btn mdv-btn-primary mdv-reply-btn">Reply</button>';
    html += '</div></div>';
  } else {
    html += '<div class="mdv-reply-row"><div class="mdv-reply-actions">';
    html += '<button class="mdv-btn mdv-resolve-btn">Reopen</button>';
    html += '</div></div>';
  }
  return html;
}

function mdvRenderCommentBody(c) {
  const author = c.author ? c.author.name : 'Anon';
  const kind = c.author ? (c.author.kind || 'human') : 'human';
  const when = c.created_at ? new Date(c.created_at).toLocaleString() : '';
  return '<div class="mdv-comment mdv-kind-' + mdvEscape(kind) + '" data-comment-id="' + mdvEscape(c.id) + '">' +
         '<div class="mdv-author"><span class="mdv-author-name">' + mdvEscape(author) + '</span>' +
         '<span class="mdv-when">' + mdvEscape(when) + '</span></div>' +
         '<div class="mdv-body">' + mdvEscape(c.body_md || '') + '</div></div>';
}

function mdvRenderChips() {
  document.querySelectorAll('.mdv-chip').forEach(c => c.remove());
  const idMap = mdvBuildAnchorMap(document.getElementById('mdBody'));
  const roots = mdvThreadTree();
  roots.forEach(thread => {
    if (!thread.anchor) return;
    const elem = idMap[thread.anchor.id];
    if (!elem) return; // orphan — only shown in sidebar
    const count = 1 + thread.replies.length;
    const chip = document.createElement('span');
    chip.className = 'mdv-chip' + (thread.status === 'resolved' ? ' mdv-chip-resolved' : '');
    chip.textContent = '💬 ' + count;
    chip.title = 'Open thread';
    chip.dataset.threadId = thread.id;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', 'Comment thread, ' + count + ' message' + (count === 1 ? '' : 's'));
    chip.onclick = (e) => { e.stopPropagation(); mdvFocusThread(thread.id); };
    elem.appendChild(chip);
  });
}

function mdvFocusThread(id) {
  mdvToggleSidebar(true);
  setTimeout(() => {
    const card = document.querySelector('.mdv-thread[data-thread-id="' + id + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid rgb(107,143,113)';
      setTimeout(() => card.style.outline = '', 1200);
    }
  }, 80);
}

// ------- Add comment popup -------
async function mdvShowAddPopup(elem, selectionText) {
  document.querySelectorAll('.mdv-add-popup').forEach(p => p.remove());
  const rect = elem.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'mdv-add-popup';
  pop.innerHTML = '<div class="mdv-add-head">Add comment</div>' +
                  '<textarea class="mdv-add-input" placeholder="Type your comment… (Cmd+Enter to save, Esc to cancel)"></textarea>' +
                  '<div class="mdv-add-actions">' +
                  '<button class="mdv-btn mdv-add-cancel">Cancel</button>' +
                  '<button class="mdv-btn mdv-btn-primary mdv-add-save">Save</button></div>';
  const left = Math.min(window.innerWidth - 340, Math.max(8, rect.left));
  const top = Math.min(window.innerHeight - 200, rect.bottom + window.scrollY + 6);
  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';
  document.body.appendChild(pop);
  const ta = pop.querySelector('textarea');
  ta.focus();
  pop.querySelector('.mdv-add-cancel').onclick = () => pop.remove();
  pop.querySelector('.mdv-add-save').onclick = async () => {
    const body = ta.value.trim();
    if (!body) { pop.remove(); return; }
    // EnsureWritableHandle inside the user-gesture chain so showSaveFilePicker
    // (if needed) can fire. After the picker, we still have an active gesture
    // for the followup createWritable() call.
    if (!mdvFileHandle && 'showSaveFilePicker' in window) {
      const h = await mdvEnsureWritableHandle();
      if (!h) {
        // User cancelled the picker — keep popup open so they can retry.
        mdvShowToast('Save cancelled. Pick a location to enable inline save.', 'error');
        return;
      }
    }
    pop.remove();
    await mdvAddComment(elem, selectionText, body);
    // Force an immediate save (we just acquired a gesture-fresh handle).
    await mdvSaveFile({ allowPrompt: false });
  };
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') pop.querySelector('.mdv-add-save').click();
    if (e.key === 'Escape') pop.remove();
  });
}

async function mdvAddComment(elem, selectionText, body) {
  const anchor = await mdvComputeAnchor(elem, selectionText);
  // Inject anchor marker into rawMarkdown source
  const blockText = (elem.innerText || elem.textContent || '').trim();
  let injected = false;
  if (blockText) {
    const idx = rawMarkdown.indexOf(blockText);
    if (idx >= 0) {
      // Insert anchor on its own line before the block
      const before = rawMarkdown.slice(0, idx);
      const after = rawMarkdown.slice(idx);
      const lineStart = before.lastIndexOf('\n') + 1;
      const prefix = rawMarkdown.slice(0, lineStart);
      const suffix = rawMarkdown.slice(lineStart);
      rawMarkdown = prefix + '<!-- MDV-ANCHOR id="' + anchor.id + '" -->\n' + suffix;
      injected = true;
    }
  }
  if (!injected) {
    // Couldn't precisely locate; append marker before the file's MDV-COMMENTS block (last resort)
    console.warn('MDV: could not inject anchor marker for', anchor.id, '— comment will be orphan-tracked.');
  }
  const comment = {
    id: 'cm_' + Math.random().toString(36).slice(2, 12),
    parent_id: null,
    anchor: anchor,
    author: { name: mdvAuthorName, kind: 'human' },
    body_md: body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'open'
  };
  mdvComments.push(comment);
  // Re-render so the anchor marker is parsed into a Comment node
  renderMarkdown(rawMarkdown, currentFileName);
  mdvToggleSidebar(true);
  mdvFocusThread(comment.id);
  mdvScheduleSave();
}

function mdvPostReply(threadId, textareaEl) {
  const body = (textareaEl.value || '').trim();
  if (!body) return;
  mdvComments.push({
    id: 'cm_' + Math.random().toString(36).slice(2, 12),
    parent_id: threadId,
    author: { name: mdvAuthorName, kind: 'human' },
    body_md: body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'open'
  });
  textareaEl.value = '';
  mdvRenderSidebar();
  mdvScheduleSave();
}

function mdvResolveThread(threadId) {
  const c = mdvComments.find(x => x.id === threadId);
  if (!c) return;
  c.status = c.status === 'resolved' ? 'open' : 'resolved';
  c.updated_at = new Date().toISOString();
  mdvRenderSidebar();
  mdvScheduleSave();
}

function mdvDeleteThread(threadId) {
  if (!confirm('Delete this thread? It will be permanently removed.')) return;
  mdvComments = mdvComments.filter(c => c.id !== threadId && c.parent_id !== threadId);
  // Also strip the anchor marker from rawMarkdown
  const root = mdvComments.find(c => c.id === threadId);
  // (we already filtered, so look at the original anchor — need to keep the id)
  // Easier: just re-derive from current rawMarkdown — strip any MDV-ANCHOR not referenced by remaining comments
  const refs = new Set();
  mdvComments.forEach(c => { if (c.anchor && c.anchor.id) refs.add(c.anchor.id); });
  rawMarkdown = rawMarkdown.replace(MDV_RE_ANCHOR, (m, id) => refs.has(id) ? m : '');
  // Clean up double blank lines
  rawMarkdown = rawMarkdown.replace(/\n{3,}/g, '\n\n');
  renderMarkdown(rawMarkdown, currentFileName);
  mdvScheduleSave();
}

// ------- Right-click + selection UX -------
const MDV_BLOCK_TAGS = ['P','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','TD','DT','DD'];

function mdvFindBlock(node) {
  let el = node && (node.nodeType === 3 ? node.parentElement : node);
  while (el && !MDV_BLOCK_TAGS.includes(el.tagName)) el = el.parentElement;
  return el;
}

function mdvAttachContextMenu() {
  const content = document.getElementById('mdBody');
  if (!content || content.__mdvWired) return;
  content.__mdvWired = true;
  content.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return; // shift-right-click yields native menu
    const elem = mdvFindBlock(e.target);
    if (!elem) return;
    e.preventDefault();
    const sel = window.getSelection();
    const selText = sel && !sel.isCollapsed ? sel.toString().trim() : null;
    mdvShowContextMenu(e.clientX, e.clientY, elem, selText);
  });
}

// Wire mouseup ONCE at document level (not on every render) so we can
// guard against the popover-self-click case.
if (!window.__mdvMouseupWired) {
  window.__mdvMouseupWired = true;
  document.addEventListener('mouseup', (e) => {
    // Don't re-evaluate selection when the click landed inside any MDV UI:
    // the popover/menu/popup/sidebar handles its own actions and we must
    // not destroy them or reset selection here.
    if (e.target && e.target.closest && e.target.closest(
      '.mdv-sel-popover, .mdv-add-popup, .mdv-ctx-menu, .mdv-sidebar'
    )) return;
    mdvHandleSelection();
  });
}

function mdvShowContextMenu(x, y, elem, selectionText) {
  document.querySelectorAll('.mdv-ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'mdv-ctx-menu';
  menu.innerHTML = '<button class="mdv-ctx-item">💬 Add comment' + (selectionText ? ' on selection' : '') + '</button>';
  menu.style.left = Math.min(window.innerWidth - 200, x) + 'px';
  menu.style.top = Math.min(window.innerHeight - 60, y) + 'px';
  document.body.appendChild(menu);
  menu.querySelector('button').onclick = () => {
    menu.remove();
    mdvShowAddPopup(elem, selectionText);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', function close(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
    });
  }, 10);
}

function mdvHandleSelection() {
  // Tear down any existing popover before we decide whether to re-show.
  document.querySelectorAll('.mdv-sel-popover').forEach(p => p.remove());
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const mdBody = document.getElementById('mdBody');
  if (!mdBody || !mdBody.contains(range.commonAncestorContainer)) return;
  const text = sel.toString().trim();
  if (text.length < 3) return;
  // Capture geometry + the element + text NOW (closure) — selection may collapse
  // by the time the user clicks the popover, but our captured values stay valid.
  const elem = mdvFindBlock(range.startContainer);
  if (!elem) return;
  const rect = range.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'mdv-sel-popover';
  pop.textContent = '💬 Comment';
  pop.style.left = (rect.left + window.scrollX) + 'px';
  pop.style.top = (rect.top + window.scrollY - 36) + 'px';
  // Stop the mousedown that would (a) deselect the text and (b) also bubble to
  // the document mousedown cleaner. We still allow click to fire on this elem.
  pop.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.remove();
    mdvShowAddPopup(elem, text);
  });
  document.body.appendChild(pop);
}

// ------- Keyboard shortcut -------
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+Shift+C — toggle comments sidebar
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault();
    mdvToggleSidebar();
  }
  // Ctrl/Cmd+S — save (prompt for location if no handle yet)
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    if (rawMarkdown) {
      e.preventDefault();
      mdvSaveFile({ allowPrompt: true });
    }
  }
});

// ------- Hook into renderMarkdown -------
(function () {
  const orig = window.renderMarkdown;
  window.renderMarkdown = function(source, title) {
    // Parse comments out of source data; the anchor markers stay in source so they render as DOM Comment nodes
    const parsed = mdvParseFile(source);
    mdvComments = parsed.comments;
    if (parsed.parseError) mdvShowToast('Comments parse error: ' + parsed.parseError, 'error');
    // Render the source with markers intact (CommonMark renders HTML comments through unchanged)
    orig(source, title);
    setTimeout(() => {
      mdvAttachContextMenu();
      mdvRenderSidebar();
    }, 50);
  };
})();

// ------- Auto-restore workspace + last file on load -------
window.addEventListener('load', async () => {
  // Workspace folder first (so subsequent file loads can auto-link via it)
  try {
    const ws = await mdvGetHandle('workspace');
    if (ws && (await ws.queryPermission({ mode: 'read' })) === 'granted') {
      mdvWorkspaceDir = ws;
    }
  } catch (e) { /* ignore */ }
  try {
    const handle = await mdvGetHandle('current');
    if (!handle) return;
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') {
      await mdvOpenWithHandle(handle);
    }
  } catch (e) { /* IDB unavailable, ignore */ }
});

// ----- Workspace folder (one-time pick → zero popups forever) -----
async function mdvPickWorkspace() {
  if (!('showDirectoryPicker' in window)) {
    mdvShowToast('This browser does not support workspace folders. Use Chrome / Edge / Brave.', 'error');
    return null;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return null;
    console.error(e);
    return null;
  }
  if ((await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const p = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') {
      mdvShowToast('Workspace permission denied.', 'error');
      return null;
    }
  }
  mdvWorkspaceDir = dirHandle;
  try { await mdvPutHandle('workspace', dirHandle); } catch (e) {}
  mdvShowToast('Workspace set to "' + dirHandle.name + '". Files in this folder save silently — no more popups.');
  // If a file is currently loaded and lives in this folder, link it
  if (currentFileName && !mdvFileHandle) {
    try {
      const fh = await dirHandle.getFileHandle(currentFileName);
      mdvFileHandle = fh;
      try { await mdvPutHandle('current', fh); } catch (e) {}
      // Save current state immediately
      await mdvSaveFile({ allowPrompt: false });
    } catch (e) {
      mdvShowToast('Current file not found in workspace — drag it again from this folder to link.', 'error');
    }
  }
  return dirHandle;
}

// Try to look up a writable handle for `filename` from the cached workspace.
// Silent on failure — used during file-load to auto-link without prompting.
async function mdvTryWorkspaceMatch(filename) {
  if (!mdvWorkspaceDir || !filename) return null;
  try {
    if ((await mdvWorkspaceDir.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    return await mdvWorkspaceDir.getFileHandle(filename);
  } catch (e) { return null; }
}

// Smart open/save-location button: if no file is loaded, opens one
// (writable). If a file is already loaded but no save location yet, opens
// the Save dialog so the user pins where future saves go.
async function mdvOpenOrSetSaveLocation() {
  if (rawMarkdown && !mdvFileHandle) {
    // File loaded via drag-drop / paste / URL — pin the save location now.
    const h = await mdvEnsureWritableHandle();
    if (h) {
      mdvShowToast('Save location set to ' + (h.name || 'file') + '. Auto-save active.');
      // Save current state immediately so the file on disk now contains comments.
      await mdvSaveFile({ allowPrompt: false });
    }
  } else {
    // No file or wants to open a different one
    await mdvPickFile();
  }
}

// Expose handlers used by inline onclick attributes
window.mdvPickFile = mdvPickFile;
window.mdvPickWorkspace = mdvPickWorkspace;
window.mdvOpenOrSetSaveLocation = mdvOpenOrSetSaveLocation;
window.mdvToggleSidebar = mdvToggleSidebar;
window.mdvSaveFile = mdvSaveFile;
