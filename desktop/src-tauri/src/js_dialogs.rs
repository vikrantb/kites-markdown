//! `alert()` and `confirm()` in the page, on macOS.
//!
//! WKWebView shows nothing for them unless its UI delegate implements the matching methods, and wry's
//! delegate does not: `alert()` returns at once and `confirm()` returns false, so "Delete this thread?"
//! could never be answered yes. This adds the two methods to the delegate's class (`class_addMethod`
//! leaves alone any method the class already has) and sets each window's delegate again, because WebKit
//! looks up which methods a delegate answers only when the delegate is set. Each shows a native alert.
//!
//! In self-test mode nobody is there to click: the answer is OK at once and the dialog is recorded for
//! the report, which is how CI proves the methods are installed.
//!
//! Windows needs none of this: WebView2 shows its own dialogs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use block2::Block;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;
use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use serde_json::{json, Value};
use tauri::WebviewWindow;

static ANSWER_WITHOUT_ASKING: AtomicBool = AtomicBool::new(false);
static ANSWERED: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// Self-test mode: answer OK at once and record each dialog instead of showing it.
pub fn answer_without_asking() {
  ANSWER_WITHOUT_ASKING.store(true, Ordering::SeqCst);
}

/// The dialogs answered in self-test mode, oldest first.
pub fn answered() -> Vec<Value> {
  ANSWERED.lock().map(|v| v.clone()).unwrap_or_default()
}

/// Lets the page in `window` show `alert()` and `confirm()`. Call it once the window is built.
pub fn install(window: &WebviewWindow) {
  let result = window.with_webview(|webview| unsafe {
    let wk = webview.inner() as *mut AnyObject;
    if wk.is_null() {
      return;
    }
    let delegate: *mut AnyObject = msg_send![wk, UIDelegate];
    let Some(current) = delegate.as_ref() else { return };
    add_methods(current.class());
    let _: () = msg_send![wk, setUIDelegate: delegate];
  });
  if let Err(e) = result {
    eprintln!("alert() and confirm() will not show in {}: {e}", window.label());
  }
}

type AlertImp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut NSString, *mut AnyObject, *mut Block<dyn Fn()>);
type ConfirmImp =
  unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut NSString, *mut AnyObject, *mut Block<dyn Fn(Bool)>);

unsafe fn add_methods(class: &AnyClass) {
  let class = class as *const AnyClass as *mut AnyClass;
  // void, self, _cmd, the web view, the message, the frame, the completion block.
  let types = c"v@:@@@@?";
  let alert: AlertImp = run_alert;
  let confirm: ConfirmImp = run_confirm;
  objc2::ffi::class_addMethod(
    class,
    sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:),
    std::mem::transmute::<AlertImp, Imp>(alert),
    types.as_ptr(),
  );
  objc2::ffi::class_addMethod(
    class,
    sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:),
    std::mem::transmute::<ConfirmImp, Imp>(confirm),
    types.as_ptr(),
  );
}

unsafe extern "C-unwind" fn run_alert(
  _this: *mut AnyObject,
  _cmd: Sel,
  _webview: *mut AnyObject,
  message: *mut NSString,
  _frame: *mut AnyObject,
  done: *mut Block<dyn Fn()>,
) {
  ask("alert", &text_of(message), false);
  if let Some(done) = done.as_ref() {
    done.call(());
  }
}

unsafe extern "C-unwind" fn run_confirm(
  _this: *mut AnyObject,
  _cmd: Sel,
  _webview: *mut AnyObject,
  message: *mut NSString,
  _frame: *mut AnyObject,
  done: *mut Block<dyn Fn(Bool)>,
) {
  let yes = ask("confirm", &text_of(message), true);
  if let Some(done) = done.as_ref() {
    done.call((Bool::new(yes),));
  }
}

unsafe fn text_of(message: *mut NSString) -> String {
  message.as_ref().map(|m| m.to_string()).unwrap_or_default()
}

/// Shows the message (WebKit calls the delegate on the main thread, where the alert must run) and
/// returns true for OK.
fn ask(kind: &str, message: &str, with_cancel: bool) -> bool {
  if ANSWER_WITHOUT_ASKING.load(Ordering::SeqCst) {
    if let Ok(mut answered) = ANSWERED.lock() {
      answered.push(json!({ "kind": kind, "message": message, "answer": true }));
    }
    return true;
  }
  let answer = MessageDialog::new()
    .set_level(MessageLevel::Info)
    .set_title("Kites Markdown")
    .set_description(message)
    .set_buttons(if with_cancel { MessageButtons::OkCancel } else { MessageButtons::Ok })
    .show();
  matches!(answer, MessageDialogResult::Ok | MessageDialogResult::Yes)
}
