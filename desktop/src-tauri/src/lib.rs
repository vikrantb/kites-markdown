//! Kites Markdown, the desktop app: `markdown-viewer.html` in a native window per document.
//!
//! How documents arrive:
//! - macOS: `RunEvent::Opened` (Finder double-click, "Open With", `open -a`), at launch and later. Launch
//!   Services keeps the app to one instance, so the app opens no channel of its own (the single-instance
//!   plugin's macOS channel is a socket at a fixed path in the shared /tmp, which any local user could
//!   take first).
//! - Windows and Linux: the command line at first launch; later launches hand their command line to
//!   the running app (single instance, per user session) and exit.
//! - Everywhere: File → Open…, a link in a document, or a file dropped on a window.

mod default_app;
mod dialogs;
mod doc_windows;
mod error;
mod fsio;
mod host;
mod menu;
mod paths;
mod prefs;
mod registry;
mod selftest;
mod state;
mod watch;

#[cfg(not(target_os = "macos"))]
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, WindowEvent};

use crate::state::AppState;

pub fn run() {
  let args: Vec<String> = std::env::args().collect();
  let self_test = match selftest::SelfTest::from_env_and_args(&args) {
    Ok(t) => t,
    Err(message) => {
      eprintln!("{message}");
      std::process::exit(2);
    }
  };
  let cwd = std::env::current_dir().ok();
  let mut initial = paths::documents_from_args(args.get(1..).unwrap_or(&[]), cwd.as_deref());
  if let Some(test) = self_test.as_ref() {
    if let Some(file) = test.file.as_ref() {
      match paths::markdown_file(file) {
        Ok(path) => initial = vec![path],
        Err(e) => selftest::fail_early(test, &e.message),
      }
    }
  }
  let in_self_test = self_test.is_some();

  #[allow(unused_mut)]
  let mut builder = tauri::Builder::default();
  #[cfg(not(target_os = "macos"))]
  if !in_self_test {
    // Registered first, as the plugin requires. A self-test never hands itself to a running app.
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
      // This runs while the plugin handles the second launch's message (on Windows, inside a window
      // procedure answering another process). Tauri warns that creating a window there can deadlock, so
      // the work moves to its own thread.
      let app = app.clone();
      std::thread::spawn(move || {
        let docs = paths::documents_from_args(argv.get(1..).unwrap_or(&[]), Some(Path::new(&cwd)));
        if docs.is_empty() {
          doc_windows::show_any_or_welcome(&app);
        } else {
          doc_windows::open_paths(&app, docs, None);
        }
      });
    }));
  }

  let app = builder
    .manage(AppState::new(self_test, initial))
    .menu(menu::build)
    .on_menu_event(menu::on_event)
    .invoke_handler(tauri::generate_handler![
      host::mdv_initial_document,
      host::mdv_read_document,
      host::mdv_save_document,
      host::mdv_window_holds_text,
      host::mdv_open_dialog,
      host::mdv_open_path,
      host::mdv_open_external,
      host::mdv_make_default,
      host::mdv_self_test_requested,
      host::mdv_self_test_options,
      host::mdv_self_test_external_edit,
      host::mdv_self_test_report,
    ])
    .build(tauri::generate_context!())
    .expect("Kites Markdown could not start");

  app.run(move |handle, event| on_event(handle, event, in_self_test));
}

fn on_event(app: &AppHandle, event: RunEvent, in_self_test: bool) {
  match event {
    RunEvent::Ready => on_ready(app, in_self_test),
    #[cfg(target_os = "macos")]
    RunEvent::Opened { urls } => {
      let docs: Vec<PathBuf> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .filter_map(|p| paths::markdown_file(&p).ok())
        .collect();
      let now = app.state::<AppState>().queue_or_return(docs);
      doc_windows::open_paths(app, now, None);
    }
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { has_visible_windows, .. } => {
      if !has_visible_windows && !in_self_test {
        doc_windows::show_any_or_welcome(app);
      }
    }
    RunEvent::ExitRequested { code, api, .. } => {
      // On macOS an app stays running with no windows open, like every document app there;
      // double-clicking the next file then opens it at once.
      if cfg!(target_os = "macos") && code.is_none() && !in_self_test {
        api.prevent_exit();
      }
    }
    RunEvent::WindowEvent { label, event, .. } => match event {
      WindowEvent::Destroyed => doc_windows::forget(app, &label),
      WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => doc_windows::open_dropped(app, &label, paths),
      _ => {}
    },
    _ => {}
  }
}

fn on_ready(app: &AppHandle, in_self_test: bool) {
  let state = app.state::<AppState>();
  let waiting = state.become_ready();
  if in_self_test {
    selftest::start_timeout(app);
  }
  if !waiting.is_empty() {
    doc_windows::open_paths(app, waiting, None);
  } else if !in_self_test {
    if cfg!(target_os = "macos") {
      // Finder delivers a double-clicked file just after launch; give it a moment so the app does
      // not flash an empty window first.
      let handle = app.clone();
      std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
          if inner.webview_windows().is_empty() {
            doc_windows::open_welcome(&inner);
          }
        });
      });
    } else {
      doc_windows::open_welcome(app);
    }
  }
  if !in_self_test {
    maybe_ask_to_be_default(app);
  }
}

/// Once, on the first launch of the installed macOS app: offer to open Markdown files with it.
/// Windows asks in its installer instead (Settings → Default apps).
fn maybe_ask_to_be_default(app: &AppHandle) {
  if !cfg!(target_os = "macos") || !default_app::is_installed_app() {
    return;
  }
  let mut settings = prefs::load(app);
  if settings.asked_to_be_default {
    return;
  }
  let handle = app.clone();
  std::thread::spawn(move || {
    // Let the first window appear before asking.
    std::thread::sleep(Duration::from_millis(1200));
    settings.asked_to_be_default = true;
    prefs::save(&handle, &settings);
    if default_app::is_default() == Some(true) {
      return;
    }
    let parent = doc_windows::focused_label(&handle);
    let asker = handle.clone();
    dialogs::ask(
      &asker,
      parent.clone(),
      "Open Markdown files with Kites Markdown?",
      "Then double-clicking any .md file in Finder opens it here. You can change this later from the Kites Markdown menu.",
      "Use Kites Markdown",
      "Not Now",
      move |yes| {
        if yes {
          let result = default_app::make_default(&handle);
          if !result.ok {
            dialogs::inform(&handle, parent, "Not changed", &result.message, true);
          }
        }
      },
    );
  });
}
