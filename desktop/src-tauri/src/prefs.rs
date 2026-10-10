//! The few settings the shell keeps between launches, in the app's config folder.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
  /// The first-launch "open Markdown files with Kites Markdown?" question has been asked.
  pub asked_to_be_default: bool,
}

fn file(app: &AppHandle) -> Option<std::path::PathBuf> {
  app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Prefs {
  file(app)
    .and_then(|f| std::fs::read(f).ok())
    .and_then(|b| serde_json::from_slice(&b).ok())
    .unwrap_or_default()
}

pub fn save(app: &AppHandle, prefs: &Prefs) {
  let Some(f) = file(app) else { return };
  if let Some(dir) = f.parent() {
    let _ = std::fs::create_dir_all(dir);
  }
  if let Ok(bytes) = serde_json::to_vec_pretty(prefs) {
    let _ = std::fs::write(f, bytes);
  }
}
