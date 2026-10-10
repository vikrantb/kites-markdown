//! The error shape every bridge command returns to the page: `{ code, message }`.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HostError {
  /// A stable, machine-readable reason: `not-found`, `not-a-file`, `not-markdown`, `too-large`,
  /// `not-allowed`, `io`.
  pub code: &'static str,
  /// A sentence a person can read.
  pub message: String,
}

impl HostError {
  pub fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for HostError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}: {}", self.code, self.message)
  }
}

impl std::error::Error for HostError {}
