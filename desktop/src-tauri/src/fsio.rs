//! Reading and saving a document on disk.
//!
//! A save is refused, never merged, when the file changed since the window read it, and it replaces
//! the file atomically: the new text goes to a temporary file in the same folder, is flushed to disk,
//! and is then renamed over the original. A crash or a full disk leaves the original untouched.

use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::error::HostError;

/// Larger files are refused: the page holds the whole text in memory and re-renders it on change.
pub const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// What a version of a file looked like: when it was modified, its size and a hash of its bytes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fingerprint {
  pub mtime_ms: f64,
  pub len: u64,
  pub hash: u64,
}

impl Fingerprint {
  pub fn of(bytes: &[u8], mtime_ms: f64) -> Self {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    Self {
      mtime_ms,
      len: bytes.len() as u64,
      hash: h.finish(),
    }
  }

  pub fn same_bytes(&self, other: &Fingerprint) -> bool {
    self.len == other.len && self.hash == other.hash
  }

  pub fn same_mtime(&self, mtime_ms: f64) -> bool {
    (self.mtime_ms - mtime_ms).abs() <= 1.0
  }
}

/// A document as read from disk.
#[derive(Debug, Clone)]
pub struct Loaded {
  pub text: String,
  pub fingerprint: Fingerprint,
  /// The file started with a UTF-8 byte-order mark, which is kept on save.
  pub had_bom: bool,
  /// Why saving this file is refused, if it is (it is not UTF-8, so writing it back would change
  /// bytes the reader never saw).
  pub read_only: Option<String>,
}

pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
  meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_nanos() as f64 / 1_000_000.0)
    .unwrap_or(0.0)
}

fn io_error(path: &Path, e: std::io::Error) -> HostError {
  if e.kind() == std::io::ErrorKind::NotFound {
    HostError::new("not-found", format!("{} no longer exists.", path.display()))
  } else {
    HostError::new("io", format!("{}: {e}", path.display()))
  }
}

pub fn read_document(path: &Path) -> Result<Loaded, HostError> {
  // The time is taken BEFORE the bytes are read. If another program writes in between, the
  // fingerprint pairs the old time with the new bytes, and the next save is refused as a conflict.
  // The other order would pair the new time with old bytes and let a save overwrite the change.
  let meta = fs::metadata(path).map_err(|e| io_error(path, e))?;
  if meta.len() > MAX_DOCUMENT_BYTES {
    return Err(HostError::new(
      "too-large",
      format!(
        "{} is {} MB; the limit is {} MB.",
        path.display(),
        meta.len() / (1024 * 1024),
        MAX_DOCUMENT_BYTES / (1024 * 1024)
      ),
    ));
  }
  let mtime = mtime_ms(&meta);
  let bytes = fs::read(path).map_err(|e| io_error(path, e))?;
  let fingerprint = Fingerprint::of(&bytes, mtime);
  let (text, had_bom, read_only) = decode(&bytes);
  Ok(Loaded {
    text,
    fingerprint,
    had_bom,
    read_only,
  })
}

/// Decodes a file's bytes for display: UTF-8 (with or without a byte-order mark), or UTF-16 with a
/// byte-order mark. Anything that cannot be written back unchanged is marked read-only.
pub fn decode(bytes: &[u8]) -> (String, bool, Option<String>) {
  if let Some(body) = bytes.strip_prefix(UTF8_BOM) {
    return match std::str::from_utf8(body) {
      Ok(s) => (s.to_owned(), true, None),
      Err(_) => (String::from_utf8_lossy(body).into_owned(), true, Some(not_utf8())),
    };
  }
  let utf16 = |le: bool| -> String {
    let units: Vec<u16> = bytes[2..]
      .chunks_exact(2)
      .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
      .collect();
    String::from_utf16_lossy(&units)
  };
  if bytes.starts_with(&[0xFF, 0xFE]) {
    return (utf16(true), false, Some(utf16_note()));
  }
  if bytes.starts_with(&[0xFE, 0xFF]) {
    return (utf16(false), false, Some(utf16_note()));
  }
  match std::str::from_utf8(bytes) {
    Ok(s) => (s.to_owned(), false, None),
    Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false, Some(not_utf8())),
  }
}

fn not_utf8() -> String {
  "This file is not UTF-8 text, so saving comments into it would change other bytes. It is read-only here."
    .to_owned()
}

fn utf16_note() -> String {
  "This file is UTF-16 text. Kites Markdown displays it but does not save into it.".to_owned()
}

/// The result of a save, as the page receives it.
#[derive(Debug, Clone, PartialEq)]
pub enum SaveOutcome {
  Saved(Fingerprint),
  Conflict {
    current_mtime_ms: Option<f64>,
    message: String,
  },
  NotAllowed(String),
  Io(String),
}

/// What the shell knows about the versions of a file this window has seen.
#[derive(Debug, Clone, Default)]
pub struct KnownVersions {
  /// Versions handed to the page (opened, reloaded, or saved by it), newest last.
  pub served: Vec<Fingerprint>,
  /// The version this app wrote most recently.
  pub last_self_write: Option<Fingerprint>,
}

impl KnownVersions {
  /// Whether `current` is the version the page based its edit on (`expected_mtime_ms`).
  fn page_has_seen(&self, expected_mtime_ms: f64, current: &Fingerprint) -> bool {
    if !current.same_mtime(expected_mtime_ms) {
      return false;
    }
    // The times agree. When the shell knows the bytes of that version, they must agree too: some
    // file systems (FAT, network shares) keep times to the second or coarser, so a quick edit by
    // another program can keep the time and change the bytes.
    match self.served.iter().rev().find(|v| v.same_mtime(expected_mtime_ms)) {
      Some(seen) => seen.same_bytes(current),
      None => true,
    }
  }

  /// Whether the file on disk is exactly what this app last wrote. Then the page's text is newer
  /// than the disk, even if two saves were in flight with the same expected time.
  fn is_own_write(&self, current: &Fingerprint) -> bool {
    self
      .last_self_write
      .map(|w| w.same_bytes(current))
      .unwrap_or(false)
  }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Saves `text` over `path` if the file is still the version the page last saw.
pub fn save_document(
  path: &Path,
  text: &str,
  expected_mtime_ms: f64,
  known: &KnownVersions,
  had_bom: bool,
) -> SaveOutcome {
  let meta = match fs::metadata(path) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      return SaveOutcome::Conflict {
        current_mtime_ms: None,
        message: "The file was moved or deleted since it was opened. Nothing was written.".into(),
      }
    }
    Err(e) => return SaveOutcome::Io(format!("{}: {e}", path.display())),
  };
  if meta.permissions().readonly() {
    return SaveOutcome::NotAllowed("The file is read-only, so the change was not saved.".into());
  }
  let on_disk = match fs::read(path) {
    Ok(b) => b,
    Err(e) => return SaveOutcome::Io(format!("{}: {e}", path.display())),
  };
  let current = Fingerprint::of(&on_disk, mtime_ms(&meta));
  if !(known.page_has_seen(expected_mtime_ms, &current) || known.is_own_write(&current)) {
    return SaveOutcome::Conflict {
      current_mtime_ms: Some(current.mtime_ms),
      message: "The file changed on disk; reload to see the new version. Your change was not saved."
        .into(),
    };
  }

  let mut data = Vec::with_capacity(text.len() + UTF8_BOM.len());
  if had_bom {
    data.extend_from_slice(UTF8_BOM);
  }
  data.extend_from_slice(text.as_bytes());
  if let Err(e) = write_atomic(path, &data, &meta) {
    return SaveOutcome::Io(format!("Could not save {}: {e}", path.display()));
  }
  match fs::metadata(path) {
    Ok(m) => SaveOutcome::Saved(Fingerprint::of(&data, mtime_ms(&m))),
    Err(e) => SaveOutcome::Io(format!("{}: {e}", path.display())),
  }
}

fn temp_path_for(path: &Path) -> Option<PathBuf> {
  let dir = path.parent()?;
  let name = path.file_name()?.to_string_lossy();
  let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
  Some(dir.join(format!(".{name}.kites-{}-{n}.tmp", std::process::id())))
}

/// Writes `data` to a temporary file next to `path`, flushes it, gives it the original's permissions
/// and renames it over `path`.
pub fn write_atomic(path: &Path, data: &[u8], original: &fs::Metadata) -> std::io::Result<()> {
  let tmp = temp_path_for(path).ok_or_else(|| {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, "the path has no folder")
  })?;
  let result = (|| {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&tmp)?;
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    fs::set_permissions(&tmp, original.permissions())?;
    fs::rename(&tmp, path)
  })();
  if result.is_err() {
    let _ = fs::remove_file(&tmp);
  }
  result?;
  #[cfg(unix)]
  if let Some(dir) = path.parent() {
    // Make the rename itself durable.
    if let Ok(d) = fs::File::open(dir) {
      let _ = d.sync_all();
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kites-fsio-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn seen(loaded: &Loaded) -> KnownVersions {
    KnownVersions {
      served: vec![loaded.fingerprint],
      last_self_write: None,
    }
  }

  #[test]
  fn a_save_based_on_the_current_version_replaces_the_file() {
    let dir = scratch("save");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    let out = save_document(&path, "# Two\n", loaded.fingerprint.mtime_ms, &seen(&loaded), false);
    assert!(matches!(out, SaveOutcome::Saved(_)), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Two\n");
    // No temporary file is left behind.
    let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
    assert_eq!(leftovers.len(), 1, "{leftovers:?}");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_save_based_on_an_old_version_is_refused_and_writes_nothing() {
    let dir = scratch("conflict");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    // Another program edits the file; its time moves on.
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&path, "# Edited elsewhere\n").unwrap();
    let out = save_document(&path, "# Mine\n", loaded.fingerprint.mtime_ms, &seen(&loaded), false);
    assert!(matches!(out, SaveOutcome::Conflict { current_mtime_ms: Some(_), .. }), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Edited elsewhere\n");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_edit_that_keeps_the_time_is_still_caught_by_its_bytes() {
    let dir = scratch("coarse");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    // Simulate a coarse-time file system: same time, different bytes.
    let mut known = seen(&loaded);
    known.served[0].hash ^= 1;
    let out = save_document(&path, "# Mine\n", loaded.fingerprint.mtime_ms, &known, false);
    assert!(matches!(out, SaveOutcome::Conflict { .. }), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# One\n");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn two_quick_saves_from_the_app_do_not_conflict_with_each_other() {
    let dir = scratch("own");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    let mut known = seen(&loaded);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let first = save_document(&path, "# Two\n", loaded.fingerprint.mtime_ms, &known, false);
    let SaveOutcome::Saved(fp) = first else { panic!("{first:?}") };
    known.last_self_write = Some(fp);
    // The second save still carries the time from before the first one.
    let second = save_document(&path, "# Three\n", loaded.fingerprint.mtime_ms, &known, false);
    assert!(matches!(second, SaveOutcome::Saved(_)), "{second:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Three\n");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_deleted_file_is_not_recreated() {
    let dir = scratch("deleted");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    fs::remove_file(&path).unwrap();
    let out = save_document(&path, "# Mine\n", loaded.fingerprint.mtime_ms, &seen(&loaded), false);
    assert!(matches!(out, SaveOutcome::Conflict { current_mtime_ms: None, .. }), "{out:?}");
    assert!(!path.exists());
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_read_only_file_is_not_written() {
    let dir = scratch("readonly");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    let mut perms = fs::metadata(&path).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&path, perms.clone()).unwrap();
    let out = save_document(&path, "# Mine\n", loaded.fingerprint.mtime_ms, &seen(&loaded), false);
    assert!(matches!(out, SaveOutcome::NotAllowed(_)), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# One\n");
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(&path, perms).unwrap();
    let _ = fs::remove_dir_all(&dir);
  }

  #[cfg(unix)]
  #[test]
  fn a_save_keeps_the_file_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("perms");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let loaded = read_document(&path).unwrap();
    let out = save_document(&path, "# Two\n", loaded.fingerprint.mtime_ms, &seen(&loaded), false);
    assert!(matches!(out, SaveOutcome::Saved(_)), "{out:?}");
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_byte_order_mark_is_hidden_from_the_page_and_kept_on_save() {
    let dir = scratch("bom");
    let path = dir.join("doc.md");
    fs::write(&path, b"\xEF\xBB\xBF---\ntitle: x\n---\n# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    assert!(loaded.had_bom);
    assert!(loaded.text.starts_with("---"), "{:?}", &loaded.text[..8]);
    let out = save_document(&path, "# Two\n", loaded.fingerprint.mtime_ms, &seen(&loaded), true);
    assert!(matches!(out, SaveOutcome::Saved(_)), "{out:?}");
    assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBF# Two\n");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn text_that_cannot_be_written_back_unchanged_is_read_only() {
    let (text, _, ro) = decode(b"caf\xE9 au lait");
    assert!(ro.is_some());
    assert!(text.starts_with("caf"));
    let (text, bom, ro) = decode(&[0xFF, 0xFE, b'#', 0, b' ', 0, b'H', 0]);
    assert_eq!((text.as_str(), bom), ("# H", false));
    assert!(ro.is_some());
    let (text, _, ro) = decode("# Plain UTF-8 — ok\n".as_bytes());
    assert_eq!(text, "# Plain UTF-8 — ok\n");
    assert!(ro.is_none());
  }

  #[test]
  fn an_oversized_file_is_refused() {
    let dir = scratch("big");
    let path = dir.join("big.md");
    let f = fs::File::create(&path).unwrap();
    f.set_len(MAX_DOCUMENT_BYTES + 1).unwrap();
    assert_eq!(read_document(&path).unwrap_err().code, "too-large");
    let _ = fs::remove_dir_all(&dir);
  }
}
