//! Which window shows which document, and what the shell knows about each document's versions.
//!
//! One window per document: a window label (`doc-<n>`) maps to at most one path, and a path is shown
//! by at most one window. A window with no path shows the welcome screen.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::fsio::{Fingerprint, KnownVersions, Loaded};
use crate::paths::same_file;

/// How many served versions to remember per document, for the conflict check.
const SERVED_HISTORY: usize = 8;

#[derive(Debug, Default, Clone)]
pub struct WindowDocument {
  pub path: Option<PathBuf>,
  pub had_bom: bool,
  pub read_only: Option<String>,
  pub known: KnownVersions,
}

#[derive(Debug, Default)]
pub struct Registry {
  windows: HashMap<String, WindowDocument>,
}

impl Registry {
  pub fn add_window(&mut self, label: &str, path: Option<PathBuf>) {
    self.windows.insert(
      label.to_owned(),
      WindowDocument {
        path,
        ..Default::default()
      },
    );
  }

  /// Gives an existing window (normally an empty one) its document.
  pub fn set_document(&mut self, label: &str, path: PathBuf) {
    let entry = self.windows.entry(label.to_owned()).or_default();
    *entry = WindowDocument {
      path: Some(path),
      ..Default::default()
    };
  }

  pub fn remove(&mut self, label: &str) -> Option<WindowDocument> {
    self.windows.remove(label)
  }

  pub fn path(&self, label: &str) -> Option<PathBuf> {
    self.windows.get(label).and_then(|w| w.path.clone())
  }

  pub fn document(&self, label: &str) -> Option<&WindowDocument> {
    self.windows.get(label)
  }

  pub fn is_empty_window(&self, label: &str) -> bool {
    self.windows.get(label).map(|w| w.path.is_none()).unwrap_or(false)
  }

  /// The window that shows `path`, if any.
  pub fn label_for(&self, path: &Path) -> Option<String> {
    self
      .windows
      .iter()
      .find(|(_, w)| w.path.as_deref().map(|p| same_file(p, path)).unwrap_or(false))
      .map(|(label, _)| label.clone())
  }

  /// An empty window, preferring `preferred` when it is one.
  pub fn empty_window(&self, preferred: Option<&str>) -> Option<String> {
    if let Some(p) = preferred {
      if self.is_empty_window(p) {
        return Some(p.to_owned());
      }
    }
    let mut empty: Vec<&String> = self
      .windows
      .iter()
      .filter(|(_, w)| w.path.is_none())
      .map(|(l, _)| l)
      .collect();
    empty.sort();
    empty.first().map(|l| (*l).clone())
  }

  pub fn labels(&self) -> Vec<String> {
    let mut v: Vec<String> = self.windows.keys().cloned().collect();
    v.sort();
    v
  }

  /// Records that the page in `label` was handed this version of its document.
  pub fn note_served(&mut self, label: &str, loaded: &Loaded) {
    if let Some(w) = self.windows.get_mut(label) {
      w.had_bom = loaded.had_bom;
      w.read_only = loaded.read_only.clone();
      w.known.served.push(loaded.fingerprint);
      let excess = w.known.served.len().saturating_sub(SERVED_HISTORY);
      w.known.served.drain(..excess);
    }
  }

  /// Records a version this app wrote. The page has it too, since the page sent the text.
  pub fn note_saved(&mut self, label: &str, fingerprint: Fingerprint) {
    if let Some(w) = self.windows.get_mut(label) {
      w.known.last_self_write = Some(fingerprint);
      w.known.served.push(fingerprint);
      let excess = w.known.served.len().saturating_sub(SERVED_HISTORY);
      w.known.served.drain(..excess);
    }
  }

  /// Whether `current` needs to be sent to the page: it is neither the app's own last write nor the
  /// version the page already has.
  pub fn is_news(&self, label: &str, current: &Fingerprint) -> bool {
    let Some(w) = self.windows.get(label) else {
      return false;
    };
    let own = w
      .known
      .last_self_write
      .map(|s| s.same_bytes(current) && s.same_mtime(current.mtime_ms))
      .unwrap_or(false);
    let latest = w
      .known
      .served
      .last()
      .map(|s| s.same_bytes(current) && s.same_mtime(current.mtime_ms))
      .unwrap_or(false);
    !(own || latest)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn loaded(text: &str, mtime: f64) -> Loaded {
    Loaded {
      text: text.into(),
      fingerprint: Fingerprint::of(text.as_bytes(), mtime),
      had_bom: false,
      read_only: None,
    }
  }

  #[test]
  fn a_path_belongs_to_one_window() {
    let mut r = Registry::default();
    r.add_window("doc-1", Some(PathBuf::from("/a/One.md")));
    r.add_window("doc-2", None);
    assert_eq!(r.label_for(Path::new("/a/One.md")).as_deref(), Some("doc-1"));
    assert_eq!(r.label_for(Path::new("/a/two.md")), None);
    assert_eq!(r.empty_window(None).as_deref(), Some("doc-2"));
    assert_eq!(r.empty_window(Some("doc-1")).as_deref(), Some("doc-2"));
    r.set_document("doc-2", PathBuf::from("/a/two.md"));
    assert_eq!(r.empty_window(None), None);
    assert!(r.remove("doc-1").is_some());
    assert_eq!(r.label_for(Path::new("/a/One.md")), None);
  }

  #[cfg(any(target_os = "macos", windows))]
  #[test]
  fn paths_differing_only_in_case_are_the_same_document_on_case_insensitive_systems() {
    let mut r = Registry::default();
    r.add_window("doc-1", Some(PathBuf::from("/a/Notes.md")));
    assert_eq!(r.label_for(Path::new("/a/notes.MD")).as_deref(), Some("doc-1"));
  }

  #[test]
  fn the_apps_own_write_and_the_version_the_page_has_are_not_news() {
    let mut r = Registry::default();
    r.add_window("doc-1", Some(PathBuf::from("/a/x.md")));
    let v1 = loaded("one", 1000.0);
    r.note_served("doc-1", &v1);
    assert!(!r.is_news("doc-1", &v1.fingerprint));
    let saved = Fingerprint::of(b"two", 2000.0);
    r.note_saved("doc-1", saved);
    assert!(!r.is_news("doc-1", &saved));
    // An external edit is news; so is a touch that only moves the time.
    assert!(r.is_news("doc-1", &Fingerprint::of(b"three", 3000.0)));
    assert!(r.is_news("doc-1", &Fingerprint::of(b"two", 4000.0)));
    assert!(!r.is_news("doc-404", &saved));
  }

  #[test]
  fn served_history_is_bounded() {
    let mut r = Registry::default();
    r.add_window("doc-1", Some(PathBuf::from("/a/x.md")));
    for i in 0..20 {
      r.note_served("doc-1", &loaded(&format!("v{i}"), i as f64 * 10.0));
    }
    assert_eq!(r.document("doc-1").unwrap().known.served.len(), SERVED_HISTORY);
  }
}
