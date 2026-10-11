//! Opening documents in windows: one window per document.
//!
//! A document that is already open is focused, not opened twice. An empty window (the welcome screen)
//! takes the next document that arrives, so launching the app and then opening a file uses one window.

use std::path::{Path, PathBuf};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::HostError;
use crate::fsio;
use crate::host::DocumentPayload;
use crate::paths;
use crate::selftest;
use crate::state::AppState;
use crate::watch;

/// Sent to an empty window that has just been given a document.
pub const OPEN_DOCUMENT: &str = "mdv://open-document";
/// A short message for the page to show.
pub const NOTICE: &str = "mdv://notice";

const APP_TITLE: &str = "Kites Markdown";
const DEFAULT_WIDTH: f64 = 1180.0;
const DEFAULT_HEIGHT: f64 = 860.0;
const CASCADE: f64 = 28.0;

/// Opens each path, reusing `prefer` (or any empty window) for the first one.
pub fn open_paths(app: &AppHandle, paths: Vec<PathBuf>, prefer: Option<String>) {
  let mut prefer = prefer;
  for path in paths {
    if let Err(e) = open_path(app, &path, prefer.take()) {
      eprintln!("could not open {}: {e}", path.display());
    }
  }
}

/// Opens one document and returns the label of the window that shows it.
pub fn open_path(app: &AppHandle, raw: &Path, prefer: Option<String>) -> Result<String, HostError> {
  let path = paths::markdown_file(raw)?;
  let state = app.state::<AppState>();

  if let Some(label) = state.registry().label_for(&path) {
    focus(app, &label);
    return Ok(label);
  }

  allow_document_folder(app, &path);
  let reuse = state.registry().empty_window(prefer.as_deref());
  if let Some(label) = reuse {
    // Record the document first, then tell the page. A page that has not started yet asks for
    // its document when it does (initial document); one that has started gets the event.
    state.registry().set_document(&label, path.clone());
    start_watching(app, &label, &path);
    if let Some(window) = app.get_webview_window(&label) {
      let _ = window.set_title(&paths::display_name(&path));
    }
    match fsio::read_document(&path) {
      Ok(loaded) => {
        state.registry().note_version(&label, loaded.fingerprint);
        let payload = DocumentPayload::new(&path, &loaded, "opened");
        let _ = app.emit_to(EventTarget::webview_window(&label), OPEN_DOCUMENT, payload);
      }
      Err(e) => notify_page(app, &label, &e.message),
    }
    focus(app, &label);
    return Ok(label);
  }

  let label = state.next_label();
  state.registry().add_window(&label, Some(path.clone()));
  start_watching(app, &label, &path);
  if let Err(e) = create_window(app, &label, &paths::display_name(&path)) {
    forget(app, &label);
    return Err(HostError::new("io", format!("Could not open a window: {e}")));
  }
  Ok(label)
}

/// Shows an existing window, or the welcome screen when there is none.
pub fn show_any_or_welcome(app: &AppHandle) {
  let labels = app.state::<AppState>().registry().labels();
  if let Some(label) = labels.last() {
    focus(app, label);
  } else {
    open_welcome(app);
  }
}

pub fn open_welcome(app: &AppHandle) {
  let state = app.state::<AppState>();
  let label = state.next_label();
  state.registry().add_window(&label, None);
  if let Err(e) = create_window(app, &label, APP_TITLE) {
    eprintln!("could not open a window: {e}");
    forget(app, &label);
  }
}

/// Files dropped on a window: Markdown files open (the first one in this window if it is empty);
/// anything else is refused with a notice.
pub fn open_dropped(app: &AppHandle, label: &str, dropped: Vec<PathBuf>) {
  let (markdown, other): (Vec<PathBuf>, Vec<PathBuf>) =
    dropped.into_iter().partition(|p| paths::has_markdown_extension(p));
  if !other.is_empty() {
    let names: Vec<String> = other.iter().map(|p| paths::display_name(p)).collect();
    notify_page(
      app,
      label,
      &format!("Only Markdown files open here. Not opened: {}", names.join(", ")),
    );
  }
  open_paths(app, markdown, Some(label.to_owned()));
}

/// Re-reads the window's document from disk and sends it to the page (View → Reload).
pub fn reload(app: &AppHandle, label: &str) {
  let state = app.state::<AppState>();
  let Some(path) = state.registry().path(label) else { return };
  match fsio::read_document(&path) {
    Ok(loaded) => {
      state.registry().note_version(label, loaded.fingerprint);
      let payload = DocumentPayload::new(&path, &loaded, "reload");
      let _ = app.emit_to(EventTarget::webview_window(label), watch::DOCUMENT_CHANGED, payload);
    }
    Err(e) => notify_page(app, label, &e.message),
  }
}

/// Clean-up when a window closes.
pub fn forget(app: &AppHandle, label: &str) {
  let state = app.state::<AppState>();
  state.registry().remove(label);
  state.watchers().remove(label);
}

pub fn notify_page(app: &AppHandle, label: &str, message: &str) {
  let _ = app.emit_to(
    EventTarget::webview_window(label),
    NOTICE,
    serde_json::json!({ "message": message }),
  );
}

pub fn focus(app: &AppHandle, label: &str) {
  if let Some(window) = app.get_webview_window(label) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

/// The label of the focused window, or of any window.
pub fn focused_label(app: &AppHandle) -> Option<String> {
  let windows = app.webview_windows();
  windows
    .iter()
    .find(|(_, w)| w.is_focused().unwrap_or(false))
    .or_else(|| windows.iter().next())
    .map(|(l, _)| l.clone())
}

fn start_watching(app: &AppHandle, label: &str, path: &Path) {
  match watch::watch(app, label, path) {
    Ok(w) => {
      app.state::<AppState>().watchers().insert(label.to_owned(), w);
    }
    Err(e) => eprintln!("live reload is off for {}: {e}", path.display()),
  }
}

/// Lets the page load images from the document's folder (and below) through the asset protocol.
fn allow_document_folder(app: &AppHandle, path: &Path) {
  if let Some(dir) = path.parent() {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
      eprintln!("images in {} will not load: {e}", dir.display());
    }
  }
}

/// Only the app's own pages may load in a window. Links are handled by the page; anything that
/// still tries to navigate (a meta refresh, say) is stopped here.
fn is_app_url(url: &tauri::Url) -> bool {
  match url.scheme() {
    "tauri" => url.host_str() == Some("localhost"),
    "http" | "https" => url.host_str() == Some("tauri.localhost"),
    _ => false,
  }
}

fn is_external(url: &tauri::Url) -> bool {
  matches!(url.scheme(), "http" | "https" | "mailto")
}

fn window_size(app: &AppHandle) -> (f64, f64) {
  if let Ok(Some(monitor)) = app.primary_monitor() {
    let scale = monitor.scale_factor();
    let area = monitor.work_area().size.to_logical::<f64>(scale);
    return (
      DEFAULT_WIDTH.min(area.width * 0.92).max(480.0),
      DEFAULT_HEIGHT.min(area.height * 0.92).max(360.0),
    );
  }
  (DEFAULT_WIDTH, DEFAULT_HEIGHT)
}

/// Each new window steps down and right from the focused one, so a new window never hides an
/// older one exactly.
fn cascade_position(app: &AppHandle) -> Option<(f64, f64)> {
  let label = focused_label(app)?;
  let window = app.get_webview_window(&label)?;
  let scale = window.scale_factor().ok()?;
  let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
  let (x, y) = (pos.x + CASCADE, pos.y + CASCADE);
  if let Ok(Some(monitor)) = window.current_monitor() {
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);
    if x + 400.0 > origin.x + size.width || y + 300.0 > origin.y + size.height {
      return Some((origin.x + CASCADE, origin.y + CASCADE));
    }
  }
  Some((x, y))
}

fn create_window(app: &AppHandle, label: &str, title: &str) -> tauri::Result<WebviewWindow> {
  let state = app.state::<AppState>();
  let (width, height) = window_size(app);
  let cascade = cascade_position(app);
  let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
    .title(title)
    .inner_size(width, height)
    .min_inner_size(480.0, 360.0)
    .on_navigation(is_app_url)
    .on_new_window(|url, _features| {
      // A link with target="_blank" that the page did not handle: open it in the browser if it is
      // a web or mail link, and never in a new app window.
      if is_external(&url) {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
      }
      NewWindowResponse::Deny
    });
  builder = match cascade {
    Some((x, y)) => builder.position(x, y),
    None => builder.center(),
  };
  if state.self_test.is_some() {
    builder = builder
      .initialization_script(selftest::CAPTURE_SCRIPT)
      .initialization_script(selftest::PAGE_SCRIPT);
  }
  builder.build()
}
