//! Self-test mode: open one document, let the viewer measure its own render, write the result as
//! JSON and exit 0 (pass) or 1 (fail). CI runs it on every platform it builds.
//!
//! Two ways to start it:
//! - `kites-markdown --self-test <file.md> --self-test-out <result.json> [--self-test-save-probe]`
//! - set `KITES_MARKDOWN_SELF_TEST_OUT=<result.json>` and open a file the way the system does
//!   (a double-click, `open -a` on macOS, the registered command on Windows). This proves the path a
//!   real double-click takes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::paths;
use crate::state::AppState;

/// Flags that take a value, so the value is not mistaken for a document.
pub const FLAGS_WITH_VALUE: &[&str] = &["--self-test", "--self-test-out"];
const SAVE_PROBE_FLAG: &str = "--self-test-save-probe";
const ENV_OUT: &str = "KITES_MARKDOWN_SELF_TEST_OUT";
const ENV_SAVE_PROBE: &str = "KITES_MARKDOWN_SELF_TEST_SAVE_PROBE";
const TIMEOUT: Duration = Duration::from_secs(60);

pub struct SelfTest {
  /// The document to open, when given by `--self-test`. Otherwise the first document that arrives.
  pub file: Option<PathBuf>,
  pub out: PathBuf,
  /// Also exercise saving: the document must be a scratch copy, because it is written to.
  pub save_probe: bool,
  pub launched_by: &'static str,
  started: Instant,
  finished: AtomicBool,
}

impl SelfTest {
  pub fn from_env_and_args(args: &[String]) -> Result<Option<SelfTest>, String> {
    let value_of = |flag: &str| -> Result<Option<String>, String> {
      match args.iter().position(|a| a == flag) {
        None => Ok(None),
        Some(i) => args
          .get(i + 1)
          .filter(|v| !v.starts_with("--"))
          .cloned()
          .map(Some)
          .ok_or_else(|| format!("{flag} needs a value")),
      }
    };
    let file = value_of("--self-test")?;
    let out = value_of("--self-test-out")?;
    let save_probe = args.iter().any(|a| a == SAVE_PROBE_FLAG)
      || std::env::var(ENV_SAVE_PROBE).map(|v| v == "1").unwrap_or(false);
    let env_out = std::env::var(ENV_OUT).ok().filter(|v| !v.is_empty());
    match (file, out, env_out) {
      (Some(file), Some(out), _) => Ok(Some(SelfTest::new(Some(file.into()), out.into(), save_probe, "arguments"))),
      (Some(_), None, _) => Err("--self-test needs --self-test-out <result.json>".into()),
      (None, Some(_), _) => Err("--self-test-out needs --self-test <file.md>".into()),
      (None, None, Some(out)) => Ok(Some(SelfTest::new(None, out.into(), save_probe, "environment"))),
      (None, None, None) => Ok(None),
    }
  }

  fn new(file: Option<PathBuf>, out: PathBuf, save_probe: bool, launched_by: &'static str) -> Self {
    Self {
      file,
      out,
      save_probe,
      launched_by,
      started: Instant::now(),
      finished: AtomicBool::new(false),
    }
  }

  fn claim_finish(&self) -> bool {
    !self.finished.swap(true, Ordering::SeqCst)
  }
}

/// Injected before the page's own scripts in self-test mode only: records every console.error,
/// uncaught error, unhandled rejection, failed resource and Content-Security-Policy violation from
/// the very start, which a script loaded by the page itself could not see.
pub const CAPTURE_SCRIPT: &str = r#"(function () {
  if (window.__mdvSelfTestLog) return;
  var log = { consoleErrors: [], pageErrors: [], resourceErrors: [], cspViolations: [] };
  Object.defineProperty(window, '__mdvSelfTestLog', { value: log });
  var clip = function (s) { s = String(s); return s.length > 400 ? s.slice(0, 400) + '…' : s; };
  var original = console.error;
  console.error = function () {
    try { log.consoleErrors.push(clip(Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack : a; }).join(' '))); } catch (_) {}
    return original.apply(console, arguments);
  };
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) { log.resourceErrors.push(clip(t.src || t.href)); return; }
    log.pageErrors.push(clip((e && e.message) || 'error'));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    log.pageErrors.push(clip('unhandled rejection: ' + (r && (r.message || r.code) ? (r.message || r.code) : r)));
  });
  document.addEventListener('securitypolicyviolation', function (e) {
    log.cspViolations.push({ directive: e.violatedDirective || e.effectiveDirective, blocked: clip(e.blockedURI || ''), sample: clip(e.sample || ''), at: Date.now() });
  });
})();"#;

/// The measurements, run in the page after the capture script (see self-test.js).
pub const PAGE_SCRIPT: &str = include_str!("self-test.js");

/// Appends a line to the window's document the way another editor would (a plain write, not the
/// app's own atomic save), so the save probe can check live reload and conflict detection.
pub fn external_edit(app: &AppHandle, label: &str) -> Result<(), String> {
  let state = app.state::<AppState>();
  match state.self_test.as_ref() {
    Some(t) if t.save_probe => {}
    _ => return Err("only in self-test mode with --self-test-save-probe".into()),
  }
  let path = state.registry().path(label).ok_or("this window has no document")?;
  let mut text = std::fs::read(&path).map_err(|e| e.to_string())?;
  text.extend_from_slice(b"\n<!-- kites-self-test: edited elsewhere -->\n");
  std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Fails the self-test if the viewer has not reported within the timeout.
pub fn start_timeout(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(TIMEOUT);
    let state = app.state::<AppState>();
    let Some(test) = state.self_test.as_ref() else { return };
    if !test.claim_finish() {
      return;
    }
    let report = json!({
      "ok": false,
      "reason": format!("timeout: the viewer did not report within {} s", TIMEOUT.as_secs()),
      "app": app_info(&app, test),
      "elapsedMs": test.started.elapsed().as_millis() as u64,
    });
    let _ = write_report(&test.out, &report);
    eprintln!("self-test: timeout");
    exit(&app, 1);
  });
}

/// Fails the self-test at once, for a problem the shell finds before any window opens.
pub fn fail_early(test: &SelfTest, reason: &str) -> ! {
  let report = json!({ "ok": false, "reason": reason });
  let _ = write_report(&test.out, &report);
  eprintln!("self-test: {reason}");
  std::process::exit(1);
}

/// Called by the page with its measurements. Adds what only the shell can see, writes the report
/// and exits.
pub fn finish(app: &AppHandle, label: &str, viewer: Value) -> Result<(), String> {
  let state = app.state::<AppState>();
  let Some(test) = state.self_test.as_ref() else {
    return Err("not in self-test mode".into());
  };
  if !test.claim_finish() {
    return Ok(());
  }
  let path = state.registry().path(label);
  let title = app
    .get_webview_window(label)
    .and_then(|w| w.title().ok())
    .unwrap_or_default();
  let expected_title = path.as_deref().map(paths::display_name).unwrap_or_default();
  let scope = app.asset_protocol_scope();
  // Images in the document's folder and below may load, those in dot-folders (.github/, .gitbook/) too;
  // nothing in the folder above.
  let (folder_allowed, dot_folder_allowed, parent_allowed) = match path.as_deref().and_then(|p| p.parent()) {
    Some(dir) => (
      scope.is_allowed(dir.join("kites-self-test-probe.png")),
      scope.is_allowed(dir.join(".kites-self-test").join("probe.png")),
      dir
        .parent()
        .map(|up| scope.is_allowed(up.join("kites-self-test-outside.png")))
        .unwrap_or(false),
    ),
    None => (false, false, false),
  };
  let viewer_ok = viewer.get("ok").and_then(Value::as_bool).unwrap_or(false);
  let shell_ok = path.is_some() && title == expected_title && folder_allowed && dot_folder_allowed && !parent_allowed;
  let ok = viewer_ok && shell_ok;
  let report = json!({
    "ok": ok,
    "reason": if ok { Value::Null } else if !viewer_ok { json!("the viewer reported a failure") } else { json!("a shell check failed") },
    "app": app_info(app, test),
    "document": {
      "path": path.as_deref().map(paths::display_path),
      "windowTitle": title,
      "expectedTitle": expected_title,
      "assetScope": { "documentFolder": folder_allowed, "dotFolder": dot_folder_allowed, "parentFolder": parent_allowed },
    },
    "defaultHandler": crate::default_app::current_handler(),
    "elapsedMs": test.started.elapsed().as_millis() as u64,
    "viewer": viewer,
  });
  write_report(&test.out, &report).map_err(|e| format!("could not write {}: {e}", test.out.display()))?;
  println!("self-test: {} ({})", if ok { "PASS" } else { "FAIL" }, test.out.display());
  exit(app, if ok { 0 } else { 1 });
  Ok(())
}

fn app_info(app: &AppHandle, test: &SelfTest) -> Value {
  json!({
    "name": app.package_info().name,
    "version": app.package_info().version.to_string(),
    "os": std::env::consts::OS,
    "arch": std::env::consts::ARCH,
    "launchedBy": test.launched_by,
    "saveProbe": test.save_probe,
  })
}

fn write_report(out: &std::path::Path, report: &Value) -> std::io::Result<()> {
  if let Some(dir) = out.parent() {
    if !dir.as_os_str().is_empty() {
      std::fs::create_dir_all(dir)?;
    }
  }
  std::fs::write(out, serde_json::to_vec_pretty(report).unwrap_or_default())
}

/// Ends the process with `code`. Not `AppHandle::exit`: the runtime ends its event loop with status 0
/// whatever code that is given, and CI reads the status.
fn exit(_app: &AppHandle, code: i32) {
  use std::io::Write;
  let _ = std::io::stdout().flush();
  let _ = std::io::stderr().flush();
  std::process::exit(code);
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn the_flags_are_parsed_and_checked() {
    std::env::remove_var(ENV_OUT);
    let t = SelfTest::from_env_and_args(&args(&["app", "--self-test", "a.md", "--self-test-out", "r.json"]))
      .unwrap()
      .unwrap();
    assert_eq!(t.file.as_deref(), Some(std::path::Path::new("a.md")));
    assert!(!t.save_probe);
    assert!(SelfTest::from_env_and_args(&args(&["app", "--self-test", "a.md"])).is_err());
    assert!(SelfTest::from_env_and_args(&args(&["app", "--self-test-out", "r.json"])).is_err());
    assert!(SelfTest::from_env_and_args(&args(&["app", "--self-test", "--self-test-out", "r.json"])).is_err());
    assert!(SelfTest::from_env_and_args(&args(&["app", "notes.md"])).unwrap().is_none());
    let t = SelfTest::from_env_and_args(&args(&[
      "app", "--self-test", "a.md", "--self-test-out", "r.json", "--self-test-save-probe",
    ]))
    .unwrap()
    .unwrap();
    assert!(t.save_probe);
  }
}
