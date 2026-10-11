// ============================================
// Folder paths: path arithmetic for the folder of documents
// ============================================
// Shared by js/folder.js and the scripts built on it. Two kinds of path:
//   - folder-relative ('handoffs/2026-10-01.md'), in a browser, where a folder is a FileSystemDirectoryHandle;
//   - absolute, in the desktop app: POSIX ('/home/reader/notes/a.md') or Windows ('C:\notes\a.md',
//     '\\server\share\a.md'), compared without case on macOS and Windows, as their file systems do.
// Which names are Markdown, and which folders a listing never enters, are decided here too, with the same rules as
// the shell (desktop/src-tauri/src/paths.rs and folders.rs).

const MDV_FOLDER_MARKDOWN = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;
const mdvFolderCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const mdvFolderCaseless = /Mac|Win/i.test(navigator.platform || navigator.userAgent || '');
function mdvFolderBaseName(p) { return String(p || '').split(/[\\/]/).pop(); }

function mdvFolderIsWindowsPath(p) { return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p); }

// An absolute path (POSIX or Windows) with '.' and '..' resolved; null when '..' would climb above its root.
function mdvFolderNormalizeAbsolute(p) {
  const windows = mdvFolderIsWindowsPath(p);
  const sep = windows ? '\\' : '/';
  const s = windows ? p.replace(/\//g, '\\') : p;
  let root;
  if (/^[a-zA-Z]:\\/.test(s)) root = s.slice(0, 3);
  else if (s.startsWith('\\\\')) root = '\\\\' + s.slice(2).split('\\').slice(0, 2).join('\\') + '\\';
  else if (s.startsWith('/')) root = '/';
  else return null;
  const out = [];
  for (const seg of s.slice(root.length).split(sep)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return root + out.join(sep);
}

function mdvFolderDirName(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return '';
  const dir = p.slice(0, i);
  if (!dir) return p[0];                         // '/a.md' → '/'
  if (/^[a-zA-Z]:$/.test(dir)) return dir + '\\'; // 'C:\a.md' → 'C:\'
  return dir;
}

function mdvFolderSamePath(a, b) {
  return !!a && !!b && (mdvFolderCaseless ? a.toLowerCase() === b.toLowerCase() : a === b);
}

// Whether the absolute `path` is `root` or inside it (desktop).
function mdvFolderInside(path, root) {
  if (!path || !root) return false;
  const sep = mdvFolderIsWindowsPath(root) ? '\\' : '/';
  const r = root.endsWith(sep) ? root : root + sep;
  const p = mdvFolderIsWindowsPath(root) ? path.replace(/\//g, '\\') : path;
  return mdvFolderCaseless ? p.toLowerCase().startsWith(r.toLowerCase()) : p.startsWith(r);
}

// A folder-relative path ('a/b.md') with '.' and '..' resolved; null when it would leave the folder.
function mdvFolderNormalizeRelative(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

// Folders first, then files, each by name (numbers in names in numeric order).
function mdvFolderCompareRel(a, b) {
  const pa = a.split('/'), pb = b.split('/');
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    if (pa[i] === pb[i]) continue;
    const fileA = i === pa.length - 1, fileB = i === pb.length - 1;
    if (fileA !== fileB) return fileA ? 1 : -1;
    return mdvFolderCollator.compare(pa[i], pb[i]) || (pa[i] < pb[i] ? -1 : 1);
  }
  return pa.length - pb.length;
}

function mdvFolderSkipped(name) { return name.startsWith('.') || name === 'node_modules'; }

// file:///… (desktop only): an absolute path.
function mdvFolderFileUrlPath(href) {
  try {
    const u = new URL(href);
    let p = decodeURIComponent(u.pathname);
    if (u.host) p = '\\\\' + u.host + p.replace(/\//g, '\\');
    else if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return p;
  } catch (e) { return null; }
}
