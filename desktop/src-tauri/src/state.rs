//! The app's shared state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::registry::Registry;
use crate::selftest::SelfTest;
use crate::watch::DocWatcher;

pub struct AppState {
  registry: Mutex<Registry>,
  watchers: Mutex<HashMap<String, DocWatcher>>,
  /// Documents that arrived before the event loop was ready (macOS can deliver them first).
  pending: Mutex<Vec<PathBuf>>,
  ready: AtomicBool,
  next_window: AtomicU64,
  /// Saves are checked and written one at a time.
  save_lock: Mutex<()>,
  pub self_test: Option<SelfTest>,
}

impl AppState {
  pub fn new(self_test: Option<SelfTest>, initial: Vec<PathBuf>) -> Self {
    Self {
      registry: Mutex::new(Registry::default()),
      watchers: Mutex::new(HashMap::new()),
      pending: Mutex::new(initial),
      ready: AtomicBool::new(false),
      next_window: AtomicU64::new(0),
      save_lock: Mutex::new(()),
      self_test,
    }
  }

  pub fn registry(&self) -> MutexGuard<'_, Registry> {
    self.registry.lock().unwrap_or_else(|e| e.into_inner())
  }

  pub fn watchers(&self) -> MutexGuard<'_, HashMap<String, DocWatcher>> {
    self.watchers.lock().unwrap_or_else(|e| e.into_inner())
  }

  pub fn save_lock(&self) -> MutexGuard<'_, ()> {
    self.save_lock.lock().unwrap_or_else(|e| e.into_inner())
  }

  pub fn next_label(&self) -> String {
    format!("doc-{}", self.next_window.fetch_add(1, Ordering::SeqCst) + 1)
  }

  /// Marks the app ready and returns the documents that were waiting for it.
  pub fn become_ready(&self) -> Vec<PathBuf> {
    let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
    self.ready.store(true, Ordering::SeqCst);
    std::mem::take(&mut *pending)
  }

  /// Queues documents until the app is ready. Returns them back if it already is.
  pub fn queue_or_return(&self, paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
    if self.ready.load(Ordering::SeqCst) {
      paths
    } else {
      pending.extend(paths);
      Vec::new()
    }
  }
}
