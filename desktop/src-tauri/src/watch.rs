//! Live reload: watch each open document and send the page the new text when another program
//! changes it.
//!
//! The watch is on the document's folder, filtered by name, because many editors save by writing a
//! new file and renaming it over the old one, which a watch on the file itself would lose. Events are
//! debounced (300 ms of quiet). The app's own saves are recognised (the registry remembers what it wrote)
//! and not echoed.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use crate::fsio;
use crate::host::DocumentPayload;
use crate::paths;
use crate::state::AppState;

pub const DOCUMENT_CHANGED: &str = "mdv://document-changed";
const QUIET: Duration = Duration::from_millis(300);

/// Dropping it stops the watch and ends its thread.
pub struct DocWatcher {
  _watcher: RecommendedWatcher,
}

fn name_key(name: &std::ffi::OsStr) -> String {
  let s = name.to_string_lossy();
  if cfg!(any(target_os = "macos", windows)) {
    s.to_lowercase()
  } else {
    s.into_owned()
  }
}

pub fn watch(app: &AppHandle, label: &str, path: &Path) -> notify::Result<DocWatcher> {
  let dir = path
    .parent()
    .ok_or_else(|| notify::Error::generic("the document has no folder"))?
    .to_path_buf();
  let name = path
    .file_name()
    .ok_or_else(|| notify::Error::generic("the document has no name"))?;
  let wanted = name_key(name);
  let (tx, rx) = mpsc::channel::<()>();
  let dir_for_events = dir.clone();
  let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    let relevant = match &res {
      // A rescan or an event with no path may hide a change to the document.
      Ok(event) => {
        event.paths.is_empty()
          || event.paths.iter().any(|p| {
            p == &dir_for_events || p.file_name().map(name_key).as_deref() == Some(wanted.as_str())
          })
      }
      Err(_) => true,
    };
    if relevant {
      let _ = tx.send(());
    }
  })?;
  watcher.watch(&dir, RecursiveMode::NonRecursive)?;

  let app = app.clone();
  let label = label.to_owned();
  let path = path.to_path_buf();
  std::thread::Builder::new()
    .name(format!("watch-{label}"))
    .spawn(move || {
      // `recv` fails once the watcher (and with it the sender) is dropped: the window closed.
      while rx.recv().is_ok() {
        loop {
          match rx.recv_timeout(QUIET) {
            Ok(()) => continue,
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => return,
          }
        }
        check(&app, &label, &path);
      }
    })
    .map_err(|e| notify::Error::generic(&e.to_string()))?;
  Ok(DocWatcher { _watcher: watcher })
}

/// Reads the document and, if it is news to the page, sends it.
fn check(app: &AppHandle, label: &str, path: &PathBuf) {
  let state = app.state::<AppState>();
  let still_open = state
    .registry()
    .path(label)
    .map(|p| paths::same_file(&p, path))
    .unwrap_or(false);
  if !still_open {
    return;
  }
  // A missing or unreadable file (mid-rename, or deleted) keeps the last version on screen.
  let Ok(loaded) = fsio::read_document(path) else { return };
  {
    let mut registry = state.registry();
    if !registry.is_news(label, &loaded.fingerprint) {
      return;
    }
    // Sent is not applied: the page may hold this version back while a comment is unsaved. That is safe,
    // because a save names its own base version and the shell trusts nothing else.
    registry.note_version(label, loaded.fingerprint);
  }
  let payload = DocumentPayload::new(path, &loaded, "changed");
  let _ = app.emit_to(EventTarget::webview_window(label), DOCUMENT_CHANGED, payload);
}
