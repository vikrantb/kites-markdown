//! Which paths the app accepts as documents: existing Markdown files, canonicalized.
//!
//! Every path that reaches the shell (a double-click, a command-line argument, a link in a document,
//! a dropped file, a save) goes through `markdown_file` first.

use std::path::{Path, PathBuf};

use crate::error::HostError;

/// Extensions the app opens, compared case-insensitively. They match the bundle's file associations.
pub const MARKDOWN_EXTENSIONS: &[&str] = &[
  "md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt", "mdtext",
];

pub fn has_markdown_extension(path: &Path) -> bool {
  path
    .extension()
    .and_then(|e| e.to_str())
    .map(|e| MARKDOWN_EXTENSIONS.iter().any(|m| m.eq_ignore_ascii_case(e)))
    .unwrap_or(false)
}

/// Canonicalizes `raw` and checks that it is an existing, regular Markdown file.
///
/// The extension is checked on the canonical path, so a link named `notes.md` that points at
/// `secret.txt` is refused.
pub fn markdown_file(raw: &Path) -> Result<PathBuf, HostError> {
  if raw.as_os_str().is_empty() {
    return Err(HostError::new("not-found", "No file was given."));
  }
  let canonical = dunce::canonicalize(raw).map_err(|_| {
    HostError::new(
      "not-found",
      format!("{} does not exist.", raw.display()),
    )
  })?;
  let meta = std::fs::metadata(&canonical)
    .map_err(|e| HostError::new("io", format!("{}: {e}", canonical.display())))?;
  if !meta.is_file() {
    return Err(HostError::new(
      "not-a-file",
      format!("{} is not a file.", canonical.display()),
    ));
  }
  if !has_markdown_extension(&canonical) {
    return Err(HostError::new(
      "not-markdown",
      format!(
        "{} is not a Markdown file. Kites Markdown opens only Markdown files.",
        display_name(&canonical)
      ),
    ));
  }
  Ok(canonical)
}

pub fn display_name(path: &Path) -> String {
  path
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_else(|| path.display().to_string())
}

pub fn display_path(path: &Path) -> String {
  path.display().to_string()
}

/// A comparison key for "the same file". macOS and Windows volumes are case-insensitive by
/// default, and a canonical path keeps the spelling it was given, so the key ignores case there.
pub fn path_key(path: &Path) -> String {
  let s = path.to_string_lossy();
  if cfg!(any(target_os = "macos", windows)) {
    s.to_lowercase()
  } else {
    s.into_owned()
  }
}

pub fn same_file(a: &Path, b: &Path) -> bool {
  path_key(a) == path_key(b)
}

/// The command-line arguments that name documents, resolved against `cwd` and validated.
///
/// Flags are skipped, as are the values of the self-test flags. Invalid or non-Markdown paths are
/// dropped. Duplicates are removed, keeping the first.
pub fn documents_from_args(args: &[String], cwd: Option<&Path>) -> Vec<PathBuf> {
  let mut out: Vec<PathBuf> = Vec::new();
  let mut skip_value = false;
  for arg in args {
    if skip_value {
      skip_value = false;
      continue;
    }
    if crate::selftest::FLAGS_WITH_VALUE.contains(&arg.as_str()) {
      skip_value = true;
      continue;
    }
    if arg.starts_with('-') {
      // A flag, including the `-psn_…` argument older macOS versions pass.
      continue;
    }
    let candidate = if arg.starts_with("file://") {
      match tauri::Url::parse(arg).ok().and_then(|u| u.to_file_path().ok()) {
        Some(p) => p,
        None => continue,
      }
    } else {
      PathBuf::from(arg)
    };
    let candidate = match (candidate.is_relative(), cwd) {
      (true, Some(dir)) => dir.join(candidate),
      _ => candidate,
    };
    if let Ok(path) = markdown_file(&candidate) {
      if !out.iter().any(|p| same_file(p, &path)) {
        out.push(path);
      }
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kites-paths-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn extensions_are_matched_case_insensitively() {
    for ok in ["a.md", "b.MD", "c.Markdown", "d.mdown", "e.mkd", "f.mkdn", "g.mdwn", "h.mdtxt", "i.mdtext"] {
      assert!(has_markdown_extension(Path::new(ok)), "{ok}");
    }
    for bad in ["a.txt", "b.mdx", "c", "d.md.exe", ".md", "e.html"] {
      assert!(!has_markdown_extension(Path::new(bad)), "{bad}");
    }
  }

  #[test]
  fn only_existing_markdown_files_are_accepted() {
    let dir = scratch("accept");
    let md = dir.join("Notes.md");
    let txt = dir.join("notes.txt");
    fs::write(&md, "# hi\n").unwrap();
    fs::write(&txt, "hi\n").unwrap();
    assert!(markdown_file(&md).is_ok());
    assert_eq!(markdown_file(&txt).unwrap_err().code, "not-markdown");
    assert_eq!(markdown_file(&dir.join("missing.md")).unwrap_err().code, "not-found");
    assert_eq!(markdown_file(&dir).unwrap_err().code, "not-a-file");
    // `..` is resolved away, so the returned path names the real file.
    let indirect = dir.join("sub").join("..").join("Notes.md");
    fs::create_dir_all(dir.join("sub")).unwrap();
    assert!(same_file(&markdown_file(&indirect).unwrap(), &markdown_file(&md).unwrap()));
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_markdown_named_directory_is_not_a_document() {
    let dir = scratch("dir");
    let sub = dir.join("folder.md");
    fs::create_dir_all(&sub).unwrap();
    assert_eq!(markdown_file(&sub).unwrap_err().code, "not-a-file");
    let _ = fs::remove_dir_all(&dir);
  }

  #[cfg(unix)]
  #[test]
  fn a_markdown_named_link_to_another_file_type_is_refused() {
    let dir = scratch("link");
    let secret = dir.join("secret.txt");
    fs::write(&secret, "x").unwrap();
    let link = dir.join("innocent.md");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    assert_eq!(markdown_file(&link).unwrap_err().code, "not-markdown");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn arguments_become_documents() {
    let dir = scratch("args");
    fs::write(dir.join("a.md"), "a").unwrap();
    fs::write(dir.join("b.markdown"), "b").unwrap();
    fs::write(dir.join("c.txt"), "c").unwrap();
    let url = tauri::Url::from_file_path(dir.join("b.markdown")).unwrap().to_string();
    let args: Vec<String> = vec![
      "a.md".into(),
      "--self-test-out".into(),
      "out.md".into(),
      "-psn_0_1234".into(),
      url,
      "c.txt".into(),
      "a.md".into(),
      "missing.md".into(),
    ];
    let docs = documents_from_args(&args, Some(&dir));
    let names: Vec<String> = docs.iter().map(|p| display_name(p)).collect();
    assert_eq!(names, vec!["a.md", "b.markdown"]);
    let _ = fs::remove_dir_all(&dir);
  }
}
