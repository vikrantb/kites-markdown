//! The menu bar: App (macOS), File, Edit, View, Go, Window (macOS) / Help (Windows and Linux).

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, EventTarget};
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

use crate::{default_app, dialogs, doc_windows};

const NEW_WINDOW: &str = "new-window";
const OPEN: &str = "open";
#[cfg(not(target_os = "macos"))]
const CLOSE: &str = "close-window";
const RELOAD: &str = "reload";
const GO_BACK: &str = "go-back";
const GO_FORWARD: &str = "go-forward";
const MAKE_DEFAULT: &str = "make-default";
/// Sent to the focused window by Go → Back and Go → Forward: the page moves between the documents it showed.
const GO: &str = "mdv://go";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
  let new_window = MenuItem::with_id(app, NEW_WINDOW, "New Window", true, Some("CmdOrCtrl+N"))?;
  let open = MenuItem::with_id(app, OPEN, "Open…", true, Some("CmdOrCtrl+O"))?;
  // On a Mac the system's own item closes the key window, whatever it is (the About panel too).
  #[cfg(target_os = "macos")]
  let close = PredefinedMenuItem::close_window(app, Some("Close Window"))?;
  #[cfg(not(target_os = "macos"))]
  let close = MenuItem::with_id(app, CLOSE, "Close Window", true, Some("CmdOrCtrl+W"))?;
  let reload = MenuItem::with_id(app, RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?;
  // A window shows the documents its links open, one after another (the page keeps them: js/history.js)
  #[cfg(target_os = "macos")]
  let (back_keys, forward_keys) = ("CmdOrCtrl+[", "CmdOrCtrl+]");
  #[cfg(not(target_os = "macos"))]
  let (back_keys, forward_keys) = ("Alt+Left", "Alt+Right");
  let back = MenuItem::with_id(app, GO_BACK, "Back", true, Some(back_keys))?;
  let forward = MenuItem::with_id(app, GO_FORWARD, "Forward", true, Some(forward_keys))?;
  let go = Submenu::with_items(app, "Go", true, &[&back, &forward])?;
  let make_default = MenuItem::with_id(app, MAKE_DEFAULT, "Make Default for Markdown Files…", true, None::<&str>)?;
  let info = app.package_info();
  let about = PredefinedMenuItem::about(
    app,
    Some("About Kites Markdown"),
    Some(AboutMetadata {
      name: Some("Kites Markdown".into()),
      version: Some(info.version.to_string()),
      short_version: Some(info.version.to_string()),
      comments: Some("A reader for Markdown: diagrams, math and code, beautifully.".into()),
      license: Some("MIT".into()),
      ..Default::default()
    }),
  )?;
  let separator = || PredefinedMenuItem::separator(app);
  let edit = Submenu::with_items(
    app,
    "Edit",
    true,
    &[
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
      &separator()?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
    ],
  )?;

  #[cfg(target_os = "macos")]
  {
    let app_menu = Submenu::with_items(
      app,
      "Kites Markdown",
      true,
      &[
        &about,
        &separator()?,
        &make_default,
        &separator()?,
        &PredefinedMenuItem::services(app, None)?,
        &separator()?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &separator()?,
        &PredefinedMenuItem::quit(app, None)?,
      ],
    )?;
    let file = Submenu::with_items(app, "File", true, &[&new_window, &open, &separator()?, &close])?;
    let view = Submenu::with_items(app, "View", true, &[&reload, &separator()?, &PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_items(
      app,
      "Window",
      true,
      &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window])
  }

  #[cfg(not(target_os = "macos"))]
  {
    let file = Submenu::with_items(
      app,
      "File",
      true,
      &[&new_window, &open, &make_default, &separator()?, &close, &PredefinedMenuItem::quit(app, Some("Exit"))?],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&reload])?;
    let help = Submenu::with_items(app, "Help", true, &[&about])?;
    Menu::with_items(app, &[&file, &edit, &view, &go, &help])
  }
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
  let focused = doc_windows::focused_label(app);
  let this_window = doc_windows::focused_document(app);
  match event.id().as_ref() {
    NEW_WINDOW => doc_windows::open_welcome(app),
    OPEN => {
      let handle = app.clone();
      let prefer = focused.clone();
      dialogs::pick_markdown_files(app, focused, move |files| doc_windows::open_paths(&handle, files, prefer));
    }
    #[cfg(not(target_os = "macos"))]
    CLOSE => {
      if let Some(window) = this_window.and_then(|l| app.get_webview_window(&l)) {
        let _ = window.close();
      }
    }
    RELOAD => {
      if let Some(label) = this_window {
        doc_windows::reload(app, &label);
      }
    }
    GO_BACK | GO_FORWARD => {
      if let Some(label) = this_window {
        let direction = if event.id().as_ref() == GO_BACK { "back" } else { "forward" };
        let _ = app.emit_to(EventTarget::webview_window(&label), GO, direction);
      }
    }
    MAKE_DEFAULT => {
      let handle = app.clone();
      // Launch Services may wait for the person to confirm, so never block the main thread on it.
      std::thread::spawn(move || {
        let result = default_app::make_default(&handle);
        let title = if result.ok { "Kites Markdown" } else { "Not changed" };
        dialogs::inform(&handle, focused, title, &result.message, !result.ok);
      });
    }
    _ => {}
  }
}
