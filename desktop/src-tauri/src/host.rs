//! The bridge commands the viewer calls (`mdv_*`). They are the page's only way to reach the disk,
//! and each checks its input: Markdown files only, saves only to the calling window's own document.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::error::HostError;
use crate::fsio::{self, Loaded, SaveOutcome};
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
      read_only: loaded.read_only.clone(),
      reason,
    }
  }
}

/// The result of a save, in the shape the comment code expects.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mtime_ms: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub current_mtime_ms: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
}

impl SaveResult {
  fn refused(reason: &'static str, message: impl Into<String>, current_mtime_ms: Option<f64>) -> Self {
    Self {
      ok: false,
      mtime_ms: None,
      reason: Some(reason),
      current_mtime_ms,
      message: Some(message.into()),
    }
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
  state.registry().note_served(window.label(), &loaded);
  Ok(Some(DocumentPayload::new(&path, &loaded, "initial")))
}

/// Reads any Markdown file. Reading does not open a window, start a watch or permit a save.
#[tauri::command]
pub async fn mdv_read_document(app: AppHandle, window: WebviewWindow, path: String) -> Result<DocumentPayload, HostError> {
  let path = paths::markdown_file(Path::new(&path))?;
  let loaded = fsio::read_document(&path)?;
  let state = app.state::<AppState>();
  let mut registry = state.registry();
  if registry
    .path(window.label())
    .map(|p| paths::same_file(&p, &path))
    .unwrap_or(false)
  {
    // The page is re-reading its own document, so it now has this version.
    registry.note_served(window.label(), &loaded);
  }
  Ok(DocumentPayload::new(&path, &loaded, "reload"))
}

/// Saves the calling window's own document, unless it changed on disk since the page read it.
#[tauri::command]
pub async fn mdv_save_document(
  app: AppHandle,
  window: WebviewWindow,
  path: String,
  text: String,
  expected_mtime_ms: f64,
) -> Result<SaveResult, HostError> {
  let state = app.state::<AppState>();
  let label = window.label().to_owned();
  let Some(own) = state.registry().path(&label) else {
    return Ok(SaveResult::refused("not-allowed", "This window has no file to save into.", None));
  };
  let target = match paths::markdown_file(Path::new(&path)) {
    Ok(p) if paths::same_file(&p, &own) => p,
    _ => {
      return Ok(SaveResult::refused(
        "not-allowed",
        "A window saves only into the file it opened.",
        None,
      ))
    }
  };
  if !expected_mtime_ms.is_finite() {
    return Ok(SaveResult::refused("conflict", "The page did not say which version it edited.", None));
  }

  let _one_at_a_time = state.save_lock();
  let (known, had_bom, read_only) = match state.registry().document(&label) {
    Some(doc) => (doc.known.clone(), doc.had_bom, doc.read_only.clone()),
    None => return Ok(SaveResult::refused("not-allowed", "The window closed.", None)),
  };
  if let Some(reason) = read_only {
    return Ok(SaveResult::refused("not-allowed", reason, None));
  }
  Ok(match fsio::save_document(&target, &text, expected_mtime_ms, &known, had_bom) {
    SaveOutcome::Saved(fingerprint) => {
      state.registry().note_saved(&label, fingerprint);
      SaveResult {
        ok: true,
        mtime_ms: Some(fingerprint.mtime_ms),
        reason: None,
        current_mtime_ms: None,
        message: None,
      }
    }
    SaveOutcome::Conflict { current_mtime_ms, message } => SaveResult::refused("conflict", message, current_mtime_ms),
    SaveOutcome::NotAllowed(message) => SaveResult::refused("not-allowed", message, None),
    SaveOutcome::Io(message) => SaveResult::refused("io", message, None),
  })
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
