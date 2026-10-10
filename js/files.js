// ============================================
// File handling
// ============================================
function handleFileInput(e) {
  const files = e.target.files;
  if (!files || !files.length) return;
  const file = files[0];
  readFile(file);
  // Reset so the same file can be picked again
  try { e.target.value = ''; } catch(_) { e.target.type = ''; e.target.type = 'file'; }
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      rawMarkdown = ev.target.result;
      currentFileName = file.name;
      // Drag-drop / file input has no writable handle. Try the workspace
      // folder first (zero popups if user has set one). Otherwise clear
      // any stale handle and prompt on first save.
      if (typeof mdvFileHandle !== 'undefined') {
        mdvFileHandle = null;
        const wsHandle = await (typeof mdvTryWorkspaceMatch !== 'undefined' ? mdvTryWorkspaceMatch(file.name) : null);
        if (wsHandle) {
          mdvFileHandle = wsHandle;
          try { await mdvPutHandle('current', wsHandle); } catch (e) {}
          mdvSetStatus && mdvSetStatus('Linked via workspace ✓');
        } else {
          mdvSetStatus && mdvSetStatus('No save location — click 📁 to set workspace', 'error');
        }
      }
      renderMarkdown(rawMarkdown, file.name);
      updateUrl(file.name);
    } catch (err) {
      console.error('Render error:', err);
      alert('Error rendering file: ' + err.message);
    }
  };
  reader.onerror = () => {
    console.error('Failed to read file:', file.name);
    alert('Failed to read file: ' + file.name);
  };
  reader.readAsText(file);
}

// Drag & drop
const dropZone = document.getElementById('dropZone');
['dragenter','dragover'].forEach(evt => {
  document.body.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
  if (dropZone) dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
});
['dragleave','drop'].forEach(evt => {
  if (dropZone) dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'));
});
document.body.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation();
  const file = e.dataTransfer.files[0];
  if (file && /\.(md|markdown|mdx|txt|text)$/i.test(file.name)) readFile(file);
});

// Paste
document.addEventListener('paste', e => {
  if (document.getElementById('searchOverlay').classList.contains('show')) return;
  // A paste into a text field (comment box, settings) belongs to that field, not to the document.
  const target = e.target;
  if (target && (target.isContentEditable || (target.closest && target.closest('input, textarea, select')))) return;
  const text = e.clipboardData.getData('text');
  if (text && text.length > 10) {
    // Pasted text is a new, unsaved document. Unlink the opened file so a later comment
    // auto-save cannot write the pasted text over it.
    mdvFileHandle = null;
    rawMarkdown = text; renderMarkdown(text, 'Pasted Content'); updateUrl('pasted');
  }
});

// URL-based file loading
function updateUrl(name) {
  const url = new URL(window.location);
  url.searchParams.set('file', name);
  url.hash = '';
  history.replaceState(null, '', url);
  document.title = `${name} - Markdown Viewer`;
}

async function loadFromUrl() {
  const url = new URL(window.location);
  const filePath = url.searchParams.get('file');
  if (!filePath) {
    if (url.hash === '#demo') loadDemo();
    return;
  }

  const isFileProtocol = window.location.protocol === 'file:';

  // If running on a server (http/https), try to fetch the file
  if (!isFileProtocol) {
    const basePath = localStorage.getItem('mdv-basepath') || '';
    const pathsToTry = [filePath];
    if (basePath) pathsToTry.push(basePath + filePath);

    for (const p of pathsToTry) {
      try {
        const resp = await fetch(p);
        if (resp.ok) {
          rawMarkdown = await resp.text();
          currentFileName = filePath.split('/').pop();
          // A fetched document has no writable handle. If the last-opened file was restored
          // while this fetch was in flight, unlink it so a comment save cannot overwrite it.
          mdvFileHandle = null;
          renderMarkdown(rawMarkdown, filePath);
          return;
        }
      } catch (_) {}
    }
  }

  // Can't fetch (file:// or server path not found) — show helpful UI
  const fileName = filePath.split('/').pop();
  document.getElementById('titleText').textContent = fileName;
  document.getElementById('breadcrumb').textContent = filePath;

  // Replace welcome screen with a helpful "open this file" prompt
  const welcome = document.getElementById('welcomeScreen');
  welcome.innerHTML = `
    <div class="drop-zone" id="dropZone2" style="max-width:560px">
      <div class="drop-zone-icon">&#128196;</div>
      <div class="drop-zone-title" style="margin-bottom:8px">Open: ${escapeHtml(fileName)}</div>
      <div class="drop-zone-sub" style="margin-bottom:4px;font-family:var(--font-mono);font-size:0.75rem;color:var(--text-tertiary);word-break:break-all">${escapeHtml(filePath)}</div>
      <div class="drop-zone-sub" style="margin-bottom:16px">
        ${isFileProtocol
          ? 'Cannot auto-load from <code>file://</code>. Drag the file here, browse to it, or serve via a local server.'
          : 'File not found on server. Drag the file here or browse to it.'}
      </div>
      <button class="drop-btn" onclick="event.stopPropagation(); document.getElementById('fileInput').click()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
        Browse to ${escapeHtml(fileName)}
      </button>
      <div class="drop-or">or drag & drop the file here</div>
      ${isFileProtocol ? `<div style="margin-top:14px;padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-sm);text-align:left">
        <div style="font-size:0.72rem;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">To enable auto-loading, serve a folder that contains both this viewer and your files:</div>
        <code style="font-size:0.78rem;display:block;padding:6px 8px;background:var(--bg-code);border-radius:4px;word-break:break-all">cd /path/to/that/folder && python3 -m http.server 8080 --bind 127.0.0.1</code>
        <div style="font-size:0.7rem;color:var(--text-tertiary);margin-top:4px">Then open: <code style="font-size:0.7rem">http://localhost:8080/&lt;path-to&gt;/markdown-viewer.html?file=${escapeHtml(filePath)}</code></div>
      </div>` : ''}
    </div>
  `;

  // Re-bind drag & drop on the new drop zone
  const dz2 = document.getElementById('dropZone2');
  if (dz2) {
    ['dragenter','dragover'].forEach(evt => {
      dz2.addEventListener(evt, e => { e.preventDefault(); dz2.classList.add('drag-over'); });
    });
    ['dragleave','drop'].forEach(evt => {
      dz2.addEventListener(evt, () => dz2.classList.remove('drag-over'));
    });
  }
}

