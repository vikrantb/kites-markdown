//! Which window shows which document.
//!
//! One window per document: a window label (`doc-<n>`) maps to at most one path, and a path is shown by
//! at most one window. A window with no path shows the welcome screen, or Markdown pasted into it.
//!
//! The registry has no say in saving: a save names the version it was made from (see `fsio`). It only
//! remembers the newest version each window was sent or wrote, so live reload does not send a page the
//! version it already has.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::fsio::Fingerprint;
use crate::paths::same_file;

#[derive(Debug, Default, Clone)]
pub struct WindowDocument {
  pub path: Option<PathBuf>,
  /// The newest version sent to the page or written for it.
  last_known: Option<Fingerprint>,
  /// The window has no file but shows text (pasted), so a file opened later must not replace it.
  holds_text: bool,
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

  pub fn contains(&self, label: &str) -> bool {
    self.windows.contains_key(label)
  }

  pub fn path(&self, label: &str) -> Option<PathBuf> {
    self.windows.get(label).and_then(|w| w.path.clone())
  }

  /// A window that can take the next document: no file, and nothing pasted into it.
  pub fn is_empty_window(&self, label: &str) -> bool {
    self.windows.get(label).map(|w| w.path.is_none() && !w.holds_text).unwrap_or(false)
  }

  /// Records that a window without a file shows text of its own.
  pub fn note_holds_text(&mut self, label: &str) {
    if let Some(w) = self.windows.get_mut(label) {
      if w.path.is_none() {
        w.holds_text = true;
      }
    }
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
    let mut empty: Vec<&String> = self.windows.keys().filter(|l| self.is_empty_window(l)).collect();
    empty.sort();
    empty.first().map(|l| (*l).clone())
  }

  pub fn labels(&self) -> Vec<String> {
    let mut v: Vec<String> = self.windows.keys().cloned().collect();
    v.sort();
    v
  }

  /// Records a version the page in `label` was sent, or that the app wrote for it.
  pub fn note_version(&mut self, label: &str, version: Fingerprint) {
    if let Some(w) = self.windows.get_mut(label) {
      w.last_known = Some(version);
    }
  }

  /// Whether `current` needs to be sent to the page: it is not the newest version the window was sent or
  /// wrote. A touch that only moves the time is news too (the page then updates only the time).
  pub fn is_news(&self, label: &str, current: &Fingerprint) -> bool {
    match self.windows.get(label) {
      Some(w) => !w.last_known.map(|k| k.same_read(current)).unwrap_or(false),
      None => false,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

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

  #[test]
  fn a_window_with_pasted_text_does_not_take_the_next_document() {
    let mut r = Registry::default();
    r.add_window("doc-1", None);
    r.add_window("doc-2", None);
    r.note_holds_text("doc-1");
    assert!(!r.is_empty_window("doc-1"));
    assert_eq!(r.empty_window(Some("doc-1")).as_deref(), Some("doc-2"));
    r.note_holds_text("doc-2");
    assert_eq!(r.empty_window(Some("doc-2")), None);
    // A window that shows a file is not changed by the note.
    r.add_window("doc-3", Some(PathBuf::from("/a/x.md")));
    r.note_holds_text("doc-3");
    assert_eq!(r.path("doc-3"), Some(PathBuf::from("/a/x.md")));
  }

  #[cfg(any(target_os = "macos", windows))]
  #[test]
  fn paths_differing_only_in_case_are_the_same_document_on_case_insensitive_systems() {
    let mut r = Registry::default();
    r.add_window("doc-1", Some(PathBuf::from("/a/Notes.md")));
    assert_eq!(r.label_for(Path::new("/a/notes.MD")).as_deref(), Some("doc-1"));
  }

  #[test]
  fn the_version_a_window_has_is_not_news() {
    let mut r = Registry::default();
    r.add_window("doc-1", Some(PathBuf::from("/a/x.md")));
    let one = Fingerprint::of(b"one", 1000.0);
    assert!(r.is_news("doc-1", &one), "nothing sent yet");
    r.note_version("doc-1", one);
    assert!(!r.is_news("doc-1", &one));
    let saved = Fingerprint::of(b"two", 2000.0);
    r.note_version("doc-1", saved);
    assert!(!r.is_news("doc-1", &saved));
    // An external edit is news; so is a touch that only moves the time.
    assert!(r.is_news("doc-1", &Fingerprint::of(b"three", 3000.0)));
    assert!(r.is_news("doc-1", &Fingerprint::of(b"two", 4000.0)));
    assert!(!r.is_news("doc-404", &saved));
  }
}
