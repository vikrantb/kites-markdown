//! The bridge commands the viewer calls (`mdv_*`). They are the page's only way to reach the disk,
//! and each checks its input: Markdown files only, saves only to the calling window's own document.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::error::HostError;
use crate::fsio::{self, Fingerprint, Loaded, SaveOutcome, Version};
use crate::state::AppState;
use crate::{default_app, dialogs, doc_windows, paths, selftest};

/// A document as the page receives it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
  pub path: String,
  pub name: String,
  pub text: String,
  pub mtime_ms: f64,
  /// Names these exact bytes. A save sends back the version its text was made from.
  pub version: String,
  /// Why saving into this file is refused, when it is.
  pub read_only: Option<String>,
  /// `initial`, `opened`, `changed` (another program wrote it) or `reload` (the person asked).
  pub reason: &'static str,
}

impl DocumentPayload {
  pub fn new(path: &Path, loaded: &Loaded, reason: &'static str) -> Self {
    Self {
      path: paths::display_path(path),
      name: paths::display_name(path),
      text: loaded.text.clone(),
      mtime_ms: loaded.fingerprint.mtime_ms,
      version: loaded.fingerprint.version().token(),
      read_only: loaded.read_only.clone(),
      reason,
    }
  }
}

/// The result of a save, in the shape the comment code expects.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mtime_ms: Option<f64>,
  /// The version now on disk, after a save.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<&'static str>,
  /// After a conflict: the version on disk, which the page may choose to overwrite.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub current_mtime_ms: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub current_version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
}

impl SaveResult {
  fn saved(written: Fingerprint) -> Self {
    Self {
      ok: true,
      mtime_ms: Some(written.mtime_ms),
      version: Some(written.version().token()),
      reason: None,
      current_mtime_ms: None,
      current_version: None,
      message: None,
    }
  }

  fn refused(reason: &'static str, message: impl Into<String>, current: Option<Fingerprint>) -> Self {
    Self {
      ok: false,
      mtime_ms: None,
      version: None,
      reason: Some(reason),
      current_mtime_ms: current.map(|c| c.mtime_ms),
      current_version: current.map(|c| c.version().token()),
      message: Some(message.into()),
    }
  }
}

/// Decides what a save request may write: only the calling window's own file (`own`), and only over the
/// version the page names. What the shell last sent the page decides nothing, because a page may hold back
/// a version it was sent (live reload waits while a comment is unsaved).
pub fn check_save_request(own: Option<&Path>, path: &str, version: Option<&str>) -> Result<(PathBuf, Version), SaveResult> {
  let Some(own) = own else {
    return Err(SaveResult::refused("not-allowed", "This window has no file to save into.", None));
  };
  let target = match paths::markdown_file(Path::new(path)) {
    Ok(p) if paths::same_file(&p, own) => p,
    _ => return Err(SaveResult::refused("not-allowed", "A window saves only into the file it opened.", None)),
  };
  match version.and_then(Version::parse) {
    Some(base) => Ok((target, base)),
    None => Err(SaveResult::refused(
      "conflict",
      "The page did not say which version of the file it edited, so nothing was written.",
      None,
    )),
  }
}

/// The calling window's document, read now. `None` for a window without one (the welcome screen).
#[tauri::command]
pub async fn mdv_initial_document(app: AppHandle, window: WebviewWindow) -> Result<Option<DocumentPayload>, HostError> {
  let state = app.state::<AppState>();
  let Some(path) = state.registry().path(window.label()) else {
    return Ok(None);
  };
  let loaded = fsio::read_document(&path)?;
  state.registry().note_version(window.label(), loaded.fingerprint);
  Ok(Some(DocumentPayload::new(&path, &loaded, "initial")))
}

/// Reads any Markdown file. Reading does not open a window, start a watch or permit a save, and the
/// shell records nothing about it.
#[tauri::command]
pub async fn mdv_read_document(path: String) -> Result<DocumentPayload, HostError> {
  let path = paths::markdown_file(Path::new(&path))?;
  let loaded = fsio::read_document(&path)?;
  Ok(DocumentPayload::new(&path, &loaded, "reload"))
}

/// Saves the calling window's own document, if the file still holds the version the page names.
#[tauri::command]
pub async fn mdv_save_document(
  app: AppHandle,
  window: WebviewWindow,
  path: String,
  text: String,
  version: Option<String>,
) -> Result<SaveResult, HostError> {
  let state = app.state::<AppState>();
  let label = window.label().to_owned();
  let own = state.registry().path(&label);
  let (target, base) = match check_save_request(own.as_deref(), &path, version.as_deref()) {
    Ok(ok) => ok,
    Err(refusal) => return Ok(refusal),
  };

  let _one_at_a_time = state.save_lock();
  if !state.registry().contains(&label) {
    return Ok(SaveResult::refused("not-allowed", "The window closed.", None));
  }
  Ok(match fsio::save_document(&target, &text, base) {
    SaveOutcome::Saved(written) => {
      state.registry().note_version(&label, written);
      SaveResult::saved(written)
    }
    SaveOutcome::Conflict { current, message } => SaveResult::refused("conflict", message, current),
    SaveOutcome::NotAllowed(message) => SaveResult::refused("not-allowed", message, None),
    SaveOutcome::Io(message) => SaveResult::refused("io", message, None),
  })
}

/// The page shows text that is in no file (it was pasted into an empty window), so a file opened
/// later goes to a new window instead of replacing it.
#[tauri::command]
pub fn mdv_window_holds_text(state: State<'_, AppState>, window: WebviewWindow) {
  state.registry().note_holds_text(window.label());
}

/// Shows the Open panel. The chosen files open in the calling window if it is empty, otherwise in
/// new windows (or focus the windows that already show them).
#[tauri::command]
pub async fn mdv_open_dialog(app: AppHandle, window: WebviewWindow) -> Result<(), HostError> {
  let label = window.label().to_owned();
  let handle = app.clone();
  dialogs::pick_markdown_files(&app, Some(label.clone()), move |files: Vec<PathBuf>| {
    doc_windows::open_paths(&handle, files, Some(label));
  });
  Ok(())
}

/// Opens a Markdown file (a link in a document) in its own window, or focuses the window that
/// already shows it.
#[tauri::command]
pub async fn mdv_open_path(app: AppHandle, path: String) -> Result<(), HostError> {
  doc_windows::open_path(&app, Path::new(&path), None).map(|_| ())
}

/// Opens a web or mail link in the default browser or mail app. Every other scheme is refused.
#[tauri::command]
pub async fn mdv_open_external(url: String) -> Result<(), HostError> {
  if url.len() > 8192 || url.chars().any(char::is_control) {
    return Err(HostError::new("not-allowed", "That link cannot be opened."));
  }
  let parsed = tauri::Url::parse(&url).map_err(|_| HostError::new("not-allowed", "That is not a valid link."))?;
  if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
    return Err(HostError::new(
      "not-allowed",
      format!("{}: links are not opened from documents.", parsed.scheme()),
    ));
  }
  tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>)
    .map_err(|e| HostError::new("io", format!("Could not open the link: {e}")))
}

/// Makes the app the default for Markdown files, or opens the system page where the person does.
#[tauri::command]
pub async fn mdv_make_default(app: AppHandle) -> Result<default_app::DefaultAppResult, HostError> {
  Ok(default_app::make_default(&app))
}

#[tauri::command]
pub fn mdv_self_test_requested(state: State<'_, AppState>) -> bool {
  state.self_test.is_some()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestOptions {
  pub save_probe: bool,
}

/// Extra options for self-test mode; `None` outside it.
#[tauri::command]
pub fn mdv_self_test_options(state: State<'_, AppState>) -> Option<SelfTestOptions> {
  state.self_test.as_ref().map(|t| SelfTestOptions { save_probe: t.save_probe })
}

/// Self-test with the save probe only: changes the window's document as another program would.
#[tauri::command]
pub async fn mdv_self_test_external_edit(app: AppHandle, window: WebviewWindow) -> Result<(), HostError> {
  selftest::external_edit(&app, window.label()).map_err(|e| HostError::new("not-allowed", e))
}

/// The page's self-test measurements. Writes the report and exits.
#[tauri::command]
pub async fn mdv_self_test_report(app: AppHandle, window: WebviewWindow, stats: Value) -> Result<(), HostError> {
  selftest::finish(&app, window.label(), stats).map_err(|e| HostError::new("not-allowed", e))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fsio::tests::{write_keeping_time, Scratch};
  use crate::registry::Registry;
  use std::fs;

  fn token(path: &Path) -> String {
    fsio::read_document(path).unwrap().fingerprint.version().token()
  }

  fn refusal(r: Result<(PathBuf, Version), SaveResult>) -> (&'static str, String) {
    let e = r.expect_err("the request should be refused");
    (e.reason.unwrap(), e.message.unwrap())
  }

  #[test]
  fn a_window_saves_only_into_its_own_file() {
    let dir = Scratch::new("host", "own");
    let own = dir.join("doc.md");
    let sibling = dir.join("sibling.md");
    fs::write(&own, "# Own\n").unwrap();
    fs::write(&sibling, "# Sibling\n").unwrap();
    let own_path = paths::markdown_file(&own).unwrap();
    let mine = Some(own_path.as_path());

    let (target, base) = check_save_request(mine, &own.to_string_lossy(), Some(&token(&own))).unwrap();
    assert!(paths::same_file(&target, &own_path));
    assert_eq!(base.token(), token(&own));
    // An existing Markdown file next to it, with its real version: still not this window's file.
    let other = check_save_request(mine, &sibling.to_string_lossy(), Some(&token(&sibling)));
    assert_eq!(refusal(other).0, "not-allowed");
    assert_eq!(fs::read_to_string(&sibling).unwrap(), "# Sibling\n");
    // A window without a file (the welcome screen, or one the shell does not know).
    assert_eq!(refusal(check_save_request(None, &own.to_string_lossy(), Some(&token(&own)))).0, "not-allowed");
  }

  #[test]
  fn a_save_that_names_no_version_writes_nothing() {
    let dir = Scratch::new("host", "noversion");
    let own = dir.join("doc.md");
    fs::write(&own, "# Own\n").unwrap();
    let own_path = paths::markdown_file(&own).unwrap();
    for version in [None, Some(""), Some("1000"), Some("not-a-version")] {
      let (reason, _) = refusal(check_save_request(Some(&own_path), &own.to_string_lossy(), version));
      assert_eq!(reason, "conflict", "{version:?}");
    }
  }

  /// The case all three reviews reproduced: on a volume that keeps times to the second, another program's
  /// edit lands in the same second; the shell reads it and sends it on (live reload, or a re-read), but the
  /// page holds it back because a comment is being saved. The save, made from the older version, must not
  /// overwrite the edit.
  #[test]
  fn a_save_made_from_a_held_back_version_does_not_overwrite_the_edit() {
    let dir = Scratch::new("host", "held");
    let own = dir.join("doc.md");
    fs::write(&own, "# Doc\n\nOriginal.\n").unwrap();
    let mut r = Registry::default();
    r.add_window("doc-1", Some(paths::markdown_file(&own).unwrap()));
    let v0 = fsio::read_document(&own).unwrap();
    r.note_version("doc-1", v0.fingerprint);
    let page_version = v0.fingerprint.version().token();

    write_keeping_time(&own, "# Doc\n\nEdited by another program.\n");
    // What the watcher does: it reads the edit, finds it is news, and sends it.
    let v1 = fsio::read_document(&own).unwrap();
    assert_eq!(v1.fingerprint.mtime_ms, v0.fingerprint.mtime_ms, "the edit kept the time");
    assert!(r.is_news("doc-1", &v1.fingerprint));
    r.note_version("doc-1", v1.fingerprint);
    // And what a re-read would hand the page.
    let _peek = DocumentPayload::new(&own, &v1, "reload");

    let mine = r.path("doc-1");
    let (target, base) = check_save_request(mine.as_deref(), &own.to_string_lossy(), Some(&page_version)).unwrap();
    let out = fsio::save_document(&target, "# Doc\n\nOriginal.\n\n<!-- my comment -->\n", base);
    assert!(matches!(out, SaveOutcome::Conflict { current: Some(_), .. }), "{out:?}");
    assert_eq!(fs::read_to_string(&own).unwrap(), "# Doc\n\nEdited by another program.\n");
  }

  #[test]
  fn a_conflict_names_the_version_on_disk_so_the_page_can_overwrite_exactly_that() {
    let on_disk = Fingerprint::of(b"theirs", 5000.0);
    let r = SaveResult::refused("conflict", "changed", Some(on_disk));
    assert_eq!(r.current_version.as_deref(), Some(on_disk.version().token().as_str()));
    assert_eq!(r.current_mtime_ms, Some(5000.0));
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["currentVersion"], on_disk.version().token());
    assert!(json.get("version").is_none());
  }
}
