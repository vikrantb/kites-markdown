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
