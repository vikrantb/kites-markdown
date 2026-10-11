//! Reading and saving a document on disk.
//!
//! Every version of a file the page receives names its bytes: a `Version` (their length and a hash),
//! which the page holds as an opaque token. A save names the version its text was made from, and it is
//! refused, never merged, unless the file on disk still holds exactly those bytes. Modification times
//! decide nothing here: some file systems keep them to the second or coarser, so two versions can share
//! one.
//!
//! The write is atomic: the new text goes to a temporary file in the same folder (never more readable
//! than the document), is flushed to disk, and is renamed over the original after one last look at the
//! file. A crash or a full disk leaves the original untouched.

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

/// One version of a file, named by its bytes. Two reads of the same bytes are the same version, whatever
/// their times.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
  pub len: u64,
  pub hash: u64,
}

impl Version {
  /// The token the page holds and sends back with a save.
  pub fn token(&self) -> String {
    format!("{:016x}-{:x}", self.hash, self.len)
  }

  pub fn parse(token: &str) -> Option<Version> {
    let (hash, len) = token.split_once('-')?;
    let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit()) && !s.is_empty();
    if hash.len() != 16 || !hex(hash) || !hex(len) {
      return None;
    }
    Some(Version {
      hash: u64::from_str_radix(hash, 16).ok()?,
      len: u64::from_str_radix(len, 16).ok()?,
    })
  }
}

/// What a version of a file looked like when it was read: its bytes, and when it was modified.
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

  pub fn version(&self) -> Version {
    Version {
      len: self.len,
      hash: self.hash,
    }
  }

  pub fn same_bytes(&self, other: &Fingerprint) -> bool {
    self.version() == other.version()
  }

  pub fn same_mtime(&self, mtime_ms: f64) -> bool {
    (self.mtime_ms - mtime_ms).abs() <= 1.0
  }

  /// The same bytes with the same modification time: one read of the file, seen twice.
  pub fn same_read(&self, other: &Fingerprint) -> bool {
    self.same_bytes(other) && self.same_mtime(other.mtime_ms)
  }
}

/// A document as read from disk.
#[derive(Debug, Clone)]
pub struct Loaded {
  pub text: String,
  pub fingerprint: Fingerprint,
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
  } else if e.kind() == std::io::ErrorKind::PermissionDenied {
    HostError::new("io", format!("{} cannot be read: permission denied.", path.display()))
  } else {
    HostError::new("io", format!("{}: {e}", path.display()))
  }
}

pub fn read_document(path: &Path) -> Result<Loaded, HostError> {
  // The time is only a hint for live reload (see `registry::is_news`); the version is the bytes alone,
  // so a write between these two reads cannot make a save trust bytes the page never received.
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
  // A UTF-8 byte-order mark is not shown; a save puts it back (see `save_document`).
  let (text, _, read_only) = decode(&bytes);
  Ok(Loaded {
    text,
    fingerprint,
    read_only,
  })
}

/// The fingerprint of the file as it is now.
pub fn current_fingerprint(path: &Path) -> std::io::Result<Fingerprint> {
  let meta = fs::metadata(path)?;
  let bytes = fs::read(path)?;
  Ok(Fingerprint::of(&bytes, mtime_ms(&meta)))
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
  /// The file is not the version the page's text was made from. `current` is what is on disk now
  /// (`None`: the file is gone), so the page can offer to overwrite exactly that version.
  Conflict {
    current: Option<Fingerprint>,
    message: String,
  },
  NotAllowed(String),
  Io(String),
}

fn changed_on_disk(current: Option<Fingerprint>) -> SaveOutcome {
  SaveOutcome::Conflict {
    message: match current {
      Some(_) => "The file changed on disk; reload to see the new version. Your change was not saved.".into(),
      None => "The file was moved or deleted since it was opened. Nothing was written.".into(),
    },
    current,
  }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Saves `text` over `path` if the file still holds exactly the bytes of `base`, the version the page's
/// text was made from. Its time does not matter: a file that was only touched, or rewritten with the same
/// bytes, loses nothing, while any other change is refused even when the file system kept the old time.
pub fn save_document(path: &Path, text: &str, base: Version) -> SaveOutcome {
  save_pausing_before_replace(path, text, base, || {})
}

/// `save_document`, calling `pause` after the new text is on disk and before the last look at the file:
/// the moment another program's write is most likely to land, which tests use to land one.
fn save_pausing_before_replace(path: &Path, text: &str, base: Version, pause: impl FnOnce()) -> SaveOutcome {
  let meta = match fs::metadata(path) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return changed_on_disk(None),
    Err(e) => return SaveOutcome::Io(format!("{}: {e}", path.display())),
  };
  match may_write(path) {
    Ok(true) => {}
    Ok(false) => return SaveOutcome::NotAllowed("The file is read-only for you, so the change was not saved.".into()),
    Err(e) => return SaveOutcome::Io(format!("{}: {e}", path.display())),
  }
  let on_disk = match fs::read(path) {
    Ok(b) => b,
    Err(e) => return SaveOutcome::Io(format!("{}: {e}", path.display())),
  };
  let current = Fingerprint::of(&on_disk, mtime_ms(&meta));
  if current.version() != base {
    return changed_on_disk(Some(current));
  }
  // The encoding is the file's own: these bytes are the version the page edited.
  let (_, had_bom, read_only) = decode(&on_disk);
  if let Some(reason) = read_only {
    return SaveOutcome::NotAllowed(reason);
  }

  let mut data = Vec::with_capacity(text.len() + UTF8_BOM.len());
  if had_bom {
    data.extend_from_slice(UTF8_BOM);
  }
  data.extend_from_slice(text.as_bytes());
  let staged = match Staged::write(path, &data, &meta) {
    Ok(s) => s,
    Err(e) => return SaveOutcome::Io(format!("Could not save {}: {e}", path.display())),
  };
  pause();
  match staged.replace_if_unchanged(path, base) {
    Ok(()) => {}
    Err(ReplaceError::Changed(now)) => return changed_on_disk(now),
    Err(ReplaceError::Io(e)) => return SaveOutcome::Io(format!("Could not save {}: {e}", path.display())),
  }
  match fs::metadata(path) {
    Ok(m) => SaveOutcome::Saved(Fingerprint::of(&data, mtime_ms(&m))),
    Err(e) => SaveOutcome::Io(format!("{}: {e}", path.display())),
  }
}

/// Whether this user may write the file itself. The save replaces the file by renaming a new one over it,
/// which needs only the folder's permission, so a file whose own permissions forbid writing (read-only,
/// or writable by its group but not by its owner) would otherwise be replaced all the same.
fn may_write(path: &Path) -> std::io::Result<bool> {
  match fs::OpenOptions::new().write(true).open(path) {
    Ok(_) => Ok(true),
    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
    Err(e) => Err(e),
  }
}

fn temp_path_for(path: &Path) -> Option<PathBuf> {
  let dir = path.parent()?;
  let name = path.file_name()?.to_string_lossy();
  let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
  Some(dir.join(format!(".{name}.kites-{}-{n}.tmp", std::process::id())))
}

/// Creates the temporary file. On Unix it starts with the original's permission bits (less whatever the
/// umask removes), so the new text is never more readable than the document while it is written.
fn create_temp(tmp: &Path, original: &fs::Metadata) -> std::io::Result<fs::File> {
  let mut options = fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    options.mode(original.permissions().mode() & 0o777);
  }
  #[cfg(not(unix))]
  let _ = original;
  options.open(tmp)
}

/// New text written next to the document and flushed, not yet in its place. Dropping it removes the
/// temporary file, so no failure leaves one behind.
pub struct Staged {
  tmp: PathBuf,
  done: bool,
}

pub enum ReplaceError {
  /// The file changed while the new text was being written; `None` when it is gone.
  Changed(Option<Fingerprint>),
  Io(std::io::Error),
}

impl Staged {
  /// Writes `data` to a temporary file next to `path`, flushes it and gives it the original's
  /// permissions.
  pub fn write(path: &Path, data: &[u8], original: &fs::Metadata) -> std::io::Result<Staged> {
    let tmp = temp_path_for(path).ok_or_else(|| {
      std::io::Error::new(std::io::ErrorKind::InvalidInput, "the path has no folder")
    })?;
    let mut file = create_temp(&tmp, original)?;
    // From here on, any failure drops `staged`, which removes the temporary file.
    let staged = Staged { tmp, done: false };
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    // Restores any bit the umask removed; never wider than the original.
    fs::set_permissions(&staged.tmp, original.permissions())?;
    Ok(staged)
  }

  /// Renames the new text over `path`, unless the file stopped being `base` while the text was written
  /// and flushed (a flush can take a while). The window for a lost edit shrinks to the rename itself; no
  /// file system offers a rename that compares first.
  pub fn replace_if_unchanged(mut self, path: &Path, base: Version) -> Result<(), ReplaceError> {
    match current_fingerprint(path) {
      Ok(now) if now.version() == base => {}
      Ok(now) => return Err(ReplaceError::Changed(Some(now))),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReplaceError::Changed(None)),
      Err(e) => return Err(ReplaceError::Io(e)),
    }
    fs::rename(&self.tmp, path).map_err(ReplaceError::Io)?;
    self.done = true;
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
      // Make the rename itself durable.
      if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
      }
    }
    Ok(())
  }
}

impl Drop for Staged {
  fn drop(&mut self) {
    if !self.done {
      let _ = fs::remove_file(&self.tmp);
    }
  }
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  /// A scratch folder that is removed when the test ends, whether it passed or failed.
  pub(crate) struct Scratch(pub PathBuf);

  impl Scratch {
    pub(crate) fn new(prefix: &str, name: &str) -> Self {
      let dir = std::env::temp_dir().join(format!("kites-{prefix}-{}-{name}", std::process::id()));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).unwrap();
      Scratch(dir)
    }

    pub(crate) fn join(&self, name: &str) -> PathBuf {
      self.0.join(name)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  fn scratch(name: &str) -> Scratch {
    Scratch::new("fsio", name)
  }

  /// Sets the file's modification time, as a file system that keeps times to the second would leave it
  /// after a quick second write.
  pub(crate) fn set_mtime(path: &Path, to: std::time::SystemTime) {
    fs::File::options().write(true).open(path).unwrap().set_modified(to).unwrap();
  }

  /// Another program's write that keeps the file's old modification time (a coarse-time file system).
  pub(crate) fn write_keeping_time(path: &Path, text: &str) {
    let t = fs::metadata(path).unwrap().modified().unwrap();
    fs::write(path, text).unwrap();
    set_mtime(path, t);
  }

  fn leftovers(dir: &Scratch) -> Vec<String> {
    fs::read_dir(&dir.0)
      .unwrap()
      .filter_map(|e| e.ok())
      .map(|e| e.file_name().to_string_lossy().into_owned())
      .filter(|n| n.contains(".kites-"))
      .collect()
  }

  fn version_of(path: &Path) -> Version {
    read_document(path).unwrap().fingerprint.version()
  }

  #[test]
  fn a_version_token_names_exactly_one_version() {
    let v = Fingerprint::of(b"# One\n", 1.0).version();
    assert_eq!(Version::parse(&v.token()), Some(v));
    assert_ne!(Fingerprint::of(b"# One\n", 99.0).version().token(), Fingerprint::of(b"# Two\n", 1.0).version().token());
    assert_eq!(Fingerprint::of(b"# One\n", 99.0).version(), v, "the time is not part of the version");
    for bad in ["", "-", "0123456789abcdef", "0123456789abcdef-", "xyz-1", "0123456789abcdeg-6", "123-6"] {
      assert_eq!(Version::parse(bad), None, "{bad:?}");
    }
  }

  #[test]
  fn a_save_based_on_the_current_version_replaces_the_file() {
    let dir = scratch("save");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let out = save_document(&path, "# Two\n", version_of(&path));
    let SaveOutcome::Saved(written) = out else { panic!("{out:?}") };
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Two\n");
    assert_eq!(written.version(), version_of(&path), "the saved version is what is on disk");
    assert_eq!(leftovers(&dir), Vec::<String>::new());
  }

  #[test]
  fn a_save_based_on_an_old_version_is_refused_and_writes_nothing() {
    let dir = scratch("conflict");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let base = version_of(&path);
    // Another program edits the file; its time moves on.
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&path, "# Edited elsewhere\n").unwrap();
    let out = save_document(&path, "# Mine\n", base);
    let SaveOutcome::Conflict { current: Some(now), .. } = out else { panic!("{out:?}") };
    assert_eq!(now.version(), Fingerprint::of(b"# Edited elsewhere\n", 0.0).version());
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Edited elsewhere\n");
  }

  #[test]
  fn an_edit_that_keeps_the_time_is_caught_by_its_bytes() {
    let dir = scratch("coarse");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    write_keeping_time(&path, "# Two, same second\n");
    assert_eq!(mtime_ms(&fs::metadata(&path).unwrap()), loaded.fingerprint.mtime_ms);
    let out = save_document(&path, "# Mine\n", loaded.fingerprint.version());
    assert!(matches!(out, SaveOutcome::Conflict { current: Some(_), .. }), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Two, same second\n");
  }

  #[test]
  fn a_touch_that_keeps_the_bytes_does_not_block_a_save() {
    let dir = scratch("touch");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let base = version_of(&path);
    set_mtime(&path, std::time::SystemTime::now() + std::time::Duration::from_secs(5));
    let out = save_document(&path, "# Two\n", base);
    assert!(matches!(out, SaveOutcome::Saved(_)), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Two\n");
  }

  #[test]
  fn an_edit_made_while_the_new_text_is_flushed_is_kept() {
    let dir = scratch("race");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let base = version_of(&path);
    // Another program writes after the first look at the file, while the new text is being flushed.
    let out = save_pausing_before_replace(&path, "# Mine\n", base, || {
      fs::write(&path, "# Edited during the save\n").unwrap();
    });
    assert!(matches!(out, SaveOutcome::Conflict { current: Some(_), .. }), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Edited during the save\n");
    assert_eq!(leftovers(&dir), Vec::<String>::new(), "the temporary file is removed");
  }

  #[test]
  fn a_deleted_file_is_a_conflict_and_is_not_recreated() {
    let dir = scratch("gone");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let base = version_of(&path);
    fs::remove_file(&path).unwrap();
    let out = save_document(&path, "# Mine\n", base);
    assert!(matches!(out, SaveOutcome::Conflict { current: None, .. }), "{out:?}");
    assert!(!path.exists());
  }

  #[test]
  fn a_read_only_file_is_not_written() {
    let dir = scratch("ro");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let base = version_of(&path);
    let mut perms = fs::metadata(&path).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&path, perms.clone()).unwrap();
    let out = save_document(&path, "# Mine\n", base);
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(&path, perms).unwrap();
    assert!(matches!(out, SaveOutcome::NotAllowed(_)), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# One\n");
  }

  #[cfg(unix)]
  #[test]
  fn a_file_its_owner_may_not_write_is_not_replaced() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("owner");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    let base = version_of(&path);
    // The owner may read it; only the group may write it. Not "read-only" in the std sense.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o464)).unwrap();
    assert!(!fs::metadata(&path).unwrap().permissions().readonly());
    let control = fs::OpenOptions::new().write(true).open(&path);
    let out = save_document(&path, "# Mine\n", base);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(control.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied, "control: the owner cannot write it");
    assert!(matches!(out, SaveOutcome::NotAllowed(_)), "{out:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "# One\n");
  }

  #[cfg(unix)]
  #[test]
  fn permissions_are_kept() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("perm");
    let path = dir.join("doc.md");
    fs::write(&path, "# One\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let out = save_document(&path, "# Two\n", version_of(&path));
    assert!(matches!(out, SaveOutcome::Saved(_)), "{out:?}");
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
  }

  #[cfg(unix)]
  #[test]
  fn the_new_text_is_never_more_readable_than_the_document() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("private");
    let path = dir.join("doc.md");
    fs::write(&path, "# Private\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let meta = fs::metadata(&path).unwrap();
    // Control: a file created the ordinary way in this folder is readable by others (the umask allows it).
    let ordinary = dir.join("ordinary");
    fs::OpenOptions::new().write(true).create_new(true).open(&ordinary).unwrap();
    assert_ne!(fs::metadata(&ordinary).unwrap().permissions().mode() & 0o044, 0, "control: the umask must let others read");
    // The temporary file is private from the moment it exists, before a byte is written to it.
    let tmp = dir.join("staged.tmp");
    let _file = create_temp(&tmp, &meta).unwrap();
    assert_eq!(fs::metadata(&tmp).unwrap().permissions().mode() & 0o077, 0);
  }

  #[test]
  fn a_byte_order_mark_is_kept() {
    let dir = scratch("bom");
    let path = dir.join("doc.md");
    fs::write(&path, b"\xEF\xBB\xBF---\ntitle: x\n---\n# One\n").unwrap();
    let loaded = read_document(&path).unwrap();
    assert!(loaded.text.starts_with("---"), "the mark is not shown: {:?}", &loaded.text[..8]);
    let out = save_document(&path, "# Two\n", loaded.fingerprint.version());
    assert!(matches!(out, SaveOutcome::Saved(_)), "{out:?}");
    assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBF# Two\n");
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
  fn a_file_that_is_not_utf8_is_not_saved_into() {
    let dir = scratch("latin1");
    let path = dir.join("doc.md");
    fs::write(&path, b"# caf\xE9\n").unwrap();
    let out = save_document(&path, "# cafe\n", version_of(&path));
    assert!(matches!(out, SaveOutcome::NotAllowed(_)), "{out:?}");
    assert_eq!(fs::read(&path).unwrap(), b"# caf\xE9\n");
  }

  #[test]
  fn an_oversized_file_is_refused() {
    let dir = scratch("big");
    let path = dir.join("big.md");
    let f = fs::File::create(&path).unwrap();
    f.set_len(MAX_DOCUMENT_BYTES + 1).unwrap();
    assert_eq!(read_document(&path).unwrap_err().code, "too-large");
  }
}
