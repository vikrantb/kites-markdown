//! Native dialogs, shown from Rust.

use std::path::PathBuf;

use rfd::{AsyncFileDialog, AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::paths::MARKDOWN_EXTENSIONS;

fn parent(app: &AppHandle, label: Option<&str>) -> Option<WebviewWindow> {
  label.and_then(|l| app.get_webview_window(l))
}

/// Shows the Open panel (attached to `parent_label`'s window when given) and calls `done` with the
/// chosen files, or with nothing when the person cancels.
pub fn pick_markdown_files<F>(app: &AppHandle, parent_label: Option<String>, done: F)
where
  F: FnOnce(Vec<PathBuf>) + Send + 'static,
{
  let handle = app.clone();
  // The panel must be created on the main thread; it is awaited on another one.
  let _ = app.run_on_main_thread(move || {
    let mut dialog = AsyncFileDialog::new()
      .set_title("Open Markdown")
      .add_filter("Markdown", MARKDOWN_EXTENSIONS);
    if let Some(window) = parent(&handle, parent_label.as_deref()) {
      dialog = dialog.set_parent(&window);
    }
    let picked = dialog.pick_files();
    std::thread::spawn(move || {
      let files = tauri::async_runtime::block_on(picked)
        .map(|v| v.iter().map(|f| f.path().to_path_buf()).collect())
        .unwrap_or_default();
      done(files);
    });
  });
}

/// Asks a yes-or-no question; `done` receives `true` for the `yes` button.
pub fn ask<F>(app: &AppHandle, parent_label: Option<String>, title: &str, message: &str, yes: &str, no: &str, done: F)
where
  F: FnOnce(bool) + Send + 'static,
{
  let handle = app.clone();
  let (title, message, yes, no) = (title.to_owned(), message.to_owned(), yes.to_owned(), no.to_owned());
  let _ = app.run_on_main_thread(move || {
    let mut dialog = AsyncMessageDialog::new()
      .set_level(MessageLevel::Info)
      .set_title(&title)
      .set_description(&message)
      .set_buttons(MessageButtons::OkCancelCustom(yes.clone(), no));
    if let Some(window) = parent(&handle, parent_label.as_deref()) {
      dialog = dialog.set_parent(&window);
    }
    let shown = dialog.show();
    std::thread::spawn(move || {
      let answer = tauri::async_runtime::block_on(shown);
      done(matches!(answer, MessageDialogResult::Ok | MessageDialogResult::Yes)
        || answer == MessageDialogResult::Custom(yes));
    });
  });
}

/// Shows a message with an OK button.
pub fn inform(app: &AppHandle, parent_label: Option<String>, title: &str, message: &str, warning: bool) {
  let handle = app.clone();
  let (title, message) = (title.to_owned(), message.to_owned());
  let _ = app.run_on_main_thread(move || {
    let mut dialog = AsyncMessageDialog::new()
      .set_level(if warning { MessageLevel::Warning } else { MessageLevel::Info })
      .set_title(&title)
      .set_description(&message)
      .set_buttons(MessageButtons::Ok);
    if let Some(window) = parent(&handle, parent_label.as_deref()) {
      dialog = dialog.set_parent(&window);
    }
    let shown = dialog.show();
    std::thread::spawn(move || {
      let _ = tauri::async_runtime::block_on(shown);
    });
  });
}

/// Where a download the page starts is saved (Export HTML: a file the page made, as a blob: URL). macOS's web view
/// cancels every download unless the app handles it, so the app asks where to save it, in a Save panel that starts
/// with the page's name for it in Downloads. Any other download is refused: a document cannot start one (js/host.js
/// takes over its links), and nothing but the viewer's own export should write a file. Windows' WebView2 has its own
/// download flow and keeps it. Returns whether the download goes on.
///
/// A download the app stops (refused, or the person cancelled the Save panel) is cancelled by the web view, which
/// then reports it as a failed download (wry: `download_did_fail`, `Finished { success: false }`). That is not a
/// failure to tell the person about, so `stopped` remembers it and its `Finished` stays silent.
#[cfg(target_os = "macos")]
pub fn save_download(
  webview: &tauri::Webview,
  event: tauri::webview::DownloadEvent<'_>,
  stopped: &std::sync::Mutex<StoppedDownloads>,
) -> bool {
  use tauri::webview::DownloadEvent;
  let stop = |url: &tauri::Url| {
    if let Ok(mut s) = stopped.lock() {
      s.stop(url.as_str());
    }
    false
  };
  match event {
    DownloadEvent::Requested { url, destination } => {
      if url.scheme() != "blob" {
        return stop(&url);
      }
      let mut dialog = rfd::FileDialog::new().set_title("Export").set_can_create_directories(true);
      if let Some(name) = destination.file_name().map(|n| suggested_name(&n.to_string_lossy())) {
        dialog = dialog.set_file_name(name);
      }
      if let Some(folder) = destination.parent() {
        dialog = dialog.set_directory(folder);
      }
      let window = webview.window();
      dialog = dialog.set_parent(&window);
      match dialog.save_file() {
        Some(path) => {
          *destination = path;
          true
        }
        None => stop(&url),
      }
    }
    DownloadEvent::Finished { url, success, .. } => {
      let failed = stopped.lock().map(|mut s| s.failed(url.as_str(), success)).unwrap_or(!success);
      if failed {
        crate::doc_windows::notify_page(webview.app_handle(), webview.label(), "The export could not be saved.");
      }
      true
    }
    _ => true,
  }
}

/// The downloads of one window that the app stopped on purpose, until the web view reports how each ended.
#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct StoppedDownloads(Vec<String>);

#[cfg(target_os = "macos")]
impl StoppedDownloads {
  /// At most this many are remembered: a web view that never reports a stopped download leaves no growing list.
  const KEPT: usize = 16;

  pub fn stop(&mut self, url: &str) {
    if self.0.len() >= Self::KEPT {
      self.0.remove(0);
    }
    self.0.push(url.to_string());
  }

  /// Whether a finished download failed in a way the person should hear about: it did not succeed, and the app had
  /// not stopped it itself.
  pub fn failed(&mut self, url: &str, success: bool) -> bool {
    if let Some(i) = self.0.iter().position(|u| u == url) {
      self.0.remove(i);
      return false;
    }
    !success
  }
}

/// The name the page gave a download, without the " (1)" the web view adds when Downloads already has one.
#[cfg(target_os = "macos")]
fn suggested_name(name: &str) -> String {
  let (stem, ext) = match name.rfind('.') {
    Some(i) if i > 0 => (&name[..i], &name[i..]),
    _ => (name, ""),
  };
  let numbered = stem
    .strip_suffix(')')
    .and_then(|s| s.rfind(" (").map(|i| (i, &s[i + 2..])))
    .filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
  let stem = match numbered {
    Some((i, _)) => &stem[..i],
    None => stem,
  };
  format!("{stem}{ext}")
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
  use super::{suggested_name, StoppedDownloads};

  #[test]
  fn a_download_the_app_stopped_is_not_reported_as_a_failed_export() {
    let mut s = StoppedDownloads::default();
    s.stop("blob:tauri://localhost/a");
    // The Save panel was cancelled: the web view's failure report for it is silent, once.
    assert!(!s.failed("blob:tauri://localhost/a", false));
    // A real failure of another export is reported; so is a later failure of the same URL, now forgotten.
    assert!(s.failed("blob:tauri://localhost/b", false));
    assert!(s.failed("blob:tauri://localhost/a", false));
    // A finished export is never a failure.
    assert!(!s.failed("blob:tauri://localhost/c", true));
  }

  #[test]
  fn stopped_downloads_are_bounded() {
    let mut s = StoppedDownloads::default();
    for i in 0..40 {
      s.stop(&format!("blob:x/{i}"));
    }
    assert!(s.failed("blob:x/0", false), "the oldest were let go");
    assert!(!s.failed("blob:x/39", false));
  }

  #[test]
  fn the_suggested_name_drops_the_number_the_web_view_adds() {
    assert_eq!(suggested_name("plan.html"), "plan.html");
    assert_eq!(suggested_name("plan (1).html"), "plan.html");
    assert_eq!(suggested_name("plan (12).html"), "plan.html");
    assert_eq!(suggested_name("plan (draft).html"), "plan (draft).html");
    assert_eq!(suggested_name("plan ().html"), "plan ().html");
    assert_eq!(suggested_name("notes"), "notes");
  }
}
