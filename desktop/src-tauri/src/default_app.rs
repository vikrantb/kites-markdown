//! Making Kites Markdown the app that opens Markdown files.
//!
//! - macOS: Launch Services, for the type `net.daringfireball.markdown` (what `.md` files are).
//!   `NSWorkspace.setDefaultApplication(at:toOpen:)` on macOS 12 and later, then the older
//!   `LSSetDefaultRoleHandlerForContentType`. The outcome is read back and reported, never assumed.
//! - Windows: the default can only be chosen by the person, so this opens Settings → Default apps
//!   at the app's own page. The installer registers the app there.
//! - Linux: not automated; the message says how.

use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppResult {
  pub ok: bool,
  pub message: String,
  /// The app that opens Markdown files now, when the system can say.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub handler: Option<String>,
}

pub const MANUAL_STEPS_MAC: &str =
  "In Finder, select any .md file, choose File → Get Info, pick Kites Markdown under “Open with”, then click “Change All…”.";

pub fn make_default(app: &AppHandle) -> DefaultAppResult {
  let _ = app;
  #[cfg(target_os = "macos")]
  {
    mac::make_default()
  }
  #[cfg(windows)]
  {
    windows::make_default()
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  {
    DefaultAppResult {
      ok: false,
      message: "Use your file manager: right-click a .md file → Open With → Kites Markdown, and set it as the default.".into(),
      handler: None,
    }
  }
}

/// The app that opens Markdown files now (macOS: its bundle identifier), when the system can say.
pub fn current_handler() -> Option<String> {
  #[cfg(target_os = "macos")]
  {
    mac::current_handler()
  }
  #[cfg(not(target_os = "macos"))]
  {
    None
  }
}

/// Whether this app already opens Markdown files. `None` when the system cannot say.
pub fn is_default() -> Option<bool> {
  #[cfg(target_os = "macos")]
  {
    let ours = mac::own_bundle_identifier()?;
    current_handler().map(|h| h.eq_ignore_ascii_case(&ours))
  }
  #[cfg(not(target_os = "macos"))]
  {
    None
  }
}

/// Whether this process runs from an installed app bundle (not a bare binary from a build folder).
pub fn is_installed_app() -> bool {
  #[cfg(target_os = "macos")]
  {
    mac::own_bundle_identifier().is_some()
  }
  #[cfg(not(target_os = "macos"))]
  {
    true
  }
}

#[cfg(target_os = "macos")]
mod mac {
  use std::ffi::c_void;
  use std::sync::mpsc;
  use std::time::Duration;

  use block2::RcBlock;
  use objc2::rc::Retained;
  use objc2_app_kit::NSWorkspace;
  use objc2_foundation::{NSBundle, NSError, NSOperatingSystemVersion, NSProcessInfo, NSString};
  use objc2_uniform_type_identifiers::UTType;

  use super::{DefaultAppResult, MANUAL_STEPS_MAC};

  pub const MARKDOWN_TYPE: &str = "net.daringfireball.markdown";
  const IDENTIFIER: &str = "app.kitesmarkdown.viewer";
  const ROLES_ALL: u32 = 0xFFFF_FFFF;

  #[link(name = "CoreServices", kind = "framework")]
  extern "C" {
    fn LSSetDefaultRoleHandlerForContentType(content_type: *const c_void, role: u32, handler: *const c_void) -> i32;
    fn LSCopyDefaultRoleHandlerForContentType(content_type: *const c_void, role: u32) -> *mut c_void;
  }

  fn at_least_macos_12() -> bool {
    let version = NSOperatingSystemVersion {
      majorVersion: 12,
      minorVersion: 0,
      patchVersion: 0,
    };
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(version)
  }

  /// This app's bundle identifier, when it runs from its `.app` bundle.
  pub fn own_bundle_identifier() -> Option<String> {
    let bundle = NSBundle::mainBundle();
    let id = bundle.bundleIdentifier()?.to_string();
    let is_app = bundle.bundleURL().path().map(|p| p.to_string().ends_with(".app")).unwrap_or(false);
    (is_app && id == IDENTIFIER).then_some(id)
  }

  fn markdown_type() -> Option<Retained<UTType>> {
    UTType::typeWithIdentifier(&NSString::from_str(MARKDOWN_TYPE))
  }

  pub fn current_handler() -> Option<String> {
    if at_least_macos_12() {
      let ty = markdown_type()?;
      let url = NSWorkspace::sharedWorkspace().URLForApplicationToOpenContentType(&ty)?;
      let path = url.path()?;
      let bundle = NSBundle::bundleWithPath(&path)?;
      return bundle.bundleIdentifier().map(|s| s.to_string()).or_else(|| Some(path.to_string()));
    }
    let uti = NSString::from_str(MARKDOWN_TYPE);
    // SAFETY: NSString is toll-free bridged to CFString. The function follows the Create rule, so
    // the returned string is owned here and released by `Retained`.
    unsafe {
      let raw = LSCopyDefaultRoleHandlerForContentType(Retained::as_ptr(&uti) as *const c_void, ROLES_ALL);
      if raw.is_null() {
        return None;
      }
      Retained::from_raw(raw as *mut NSString).map(|s| s.to_string())
    }
  }

  pub fn make_default() -> DefaultAppResult {
    let Some(ours) = own_bundle_identifier() else {
      return DefaultAppResult {
        ok: false,
        message: format!("Run Kites Markdown from its installed app (in Applications) to make it the default. {MANUAL_STEPS_MAC}"),
        handler: current_handler(),
      };
    };
    let mut detail: Option<String> = None;

    if at_least_macos_12() {
      if let Some(ty) = markdown_type() {
        let (tx, rx) = mpsc::channel::<Option<String>>();
        let block = RcBlock::new(move |error: *mut NSError| {
          // SAFETY: the completion handler receives either null or a valid NSError.
          let message = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
          let _ = tx.send(message);
        });
        let app_url = NSBundle::mainBundle().bundleURL();
        NSWorkspace::sharedWorkspace().setDefaultApplicationAtURL_toOpenContentType_completionHandler(
          &app_url,
          &ty,
          Some(&block),
        );
        // macOS may ask the person to confirm, so allow time for that.
        match rx.recv_timeout(Duration::from_secs(120)) {
          Ok(None) => {}
          Ok(Some(e)) => detail = Some(e),
          Err(_) => detail = Some("macOS did not answer in time.".into()),
        }
      }
    }

    if current_handler().as_deref() != Some(ours.as_str()) {
      let uti = NSString::from_str(MARKDOWN_TYPE);
      let id = NSString::from_str(&ours);
      // SAFETY: both arguments are valid CFStrings for the duration of the call (toll-free bridged).
      let status = unsafe {
        LSSetDefaultRoleHandlerForContentType(
          Retained::as_ptr(&uti) as *const c_void,
          ROLES_ALL,
          Retained::as_ptr(&id) as *const c_void,
        )
      };
      if status != 0 && detail.is_none() {
        detail = Some(format!("Launch Services returned {status}."));
      }
    }

    let handler = current_handler();
    if handler.as_deref().map(|h| h.eq_ignore_ascii_case(&ours)).unwrap_or(false) {
      DefaultAppResult {
        ok: true,
        message: "Markdown files now open in Kites Markdown. Double-click any .md file in Finder.".into(),
        handler,
      }
    } else {
      let now = handler.clone().unwrap_or_else(|| "another app".into());
      DefaultAppResult {
        ok: false,
        message: format!(
          "macOS still opens Markdown files with {now}.{} {MANUAL_STEPS_MAC}",
          detail.map(|d| format!(" ({d})")).unwrap_or_default()
        ),
        handler,
      }
    }
  }
}

#[cfg(windows)]
mod windows {
  use super::DefaultAppResult;

  const MANUAL_STEPS_WINDOWS: &str =
    "In Settings → Apps → Default apps, search for Kites Markdown and choose it for .md (and the other Markdown types). Or right-click a .md file → Open with → Choose another app → Kites Markdown → Always.";

  /// The name the installer registers under `RegisteredApplications`.
  const REGISTERED_NAME: &str = "Kites%20Markdown";

  pub fn make_default() -> DefaultAppResult {
    let uri = format!("ms-settings:defaultapps?registeredAppUser={REGISTERED_NAME}");
    match tauri_plugin_opener::open_url(&uri, None::<&str>) {
      Ok(()) => DefaultAppResult {
        ok: true,
        message: "Settings is open at Kites Markdown: choose it for .md and the other Markdown types. Windows asks you to confirm a default yourself.".into(),
        handler: None,
      },
      Err(e) => DefaultAppResult {
        ok: false,
        message: format!("Could not open Settings ({e}). {MANUAL_STEPS_WINDOWS}"),
        handler: None,
      },
    }
  }
}
