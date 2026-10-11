//! A folder of documents: the Markdown files under a folder, for the viewer's file sidebar.
//!
//! The walk is breadth-first, so when a limit stops it the files nearest the top are the ones listed.
//! It never follows a link to a folder (a link to an ancestor would loop, and a link could lead out of
//! the folder), and it skips `.git`, `node_modules` and every folder whose name starts with a dot. A
//! link to a file is listed when it leads to a Markdown file, the same rule `paths::markdown_file`
//! applies when the file is read. The page reads each file through `mdv_read_document`, which checks it
//! again.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::HostError;
use crate::fsio;
use crate::paths;

/// How far a listing goes. The page's own walk (js/folder.js, in a browser) keeps the same numbers.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
  /// Markdown files listed.
  pub entries: usize,
  /// Folders below the root: a file in a folder 8 levels down is listed, one 9 levels down is not.
  pub depth: usize,
  /// Folder entries looked at, Markdown or not: keeps a walk of a huge tree (a home folder) short.
  pub visited: usize,
}

pub const LIMITS: Limits = Limits {
  entries: 5_000,
  depth: 8,
  visited: 100_000,
};

/// One Markdown file in the folder.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
  /// The absolute path, as `mdv_read_document` takes it.
  pub path: String,
  /// The path below the root, with `/` between folders.
  pub rel: String,
  pub name: String,
  /// Folders between the root and the file: 0 for a file in the root.
  pub depth: usize,
  pub size: u64,
  pub mtime_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
  pub root: String,
  pub name: String,
  pub entries: Vec<FolderEntry>,
  /// A limit stopped the walk, so some files are not listed.
  pub truncated: bool,
  /// Folders that could not be read (no permission, or gone while the walk ran).
  pub unreadable: usize,
}

/// Canonicalizes `raw` and checks that it is an existing folder: the folder counterpart of
/// `paths::markdown_file`.
pub fn folder(raw: &Path) -> Result<PathBuf, HostError> {
  if raw.as_os_str().is_empty() {
    return Err(HostError::new("not-found", "No folder was given."));
  }
  let canonical = dunce::canonicalize(raw)
    .map_err(|_| HostError::new("not-found", format!("{} does not exist.", raw.display())))?;
  let meta = fs::metadata(&canonical).map_err(|e| HostError::new("io", format!("{}: {e}", canonical.display())))?;
  if !meta.is_dir() {
    return Err(HostError::new(
      "not-a-directory",
      format!("{} is not a folder.", canonical.display()),
    ));
  }
  fs::read_dir(&canonical).map_err(|e| HostError::new("io", format!("{} cannot be read: {e}", canonical.display())))?;
  Ok(canonical)
}

/// Folders the listing never enters.
pub fn skipped_folder(name: &str) -> bool {
  name.starts_with('.') || name == "node_modules"
}

/// Lists the Markdown files under `root` (already checked by `folder`).
pub fn list_markdown(root: &Path, limits: Limits) -> FolderListing {
  let mut entries = Vec::new();
  let mut truncated = false;
  let mut unreadable = 0;
  let mut visited = 0usize;
  let mut queue: VecDeque<(PathBuf, String, usize)> = VecDeque::new();
  queue.push_back((root.to_path_buf(), String::new(), 0));

  'walk: while let Some((dir, rel, depth)) = queue.pop_front() {
    let reader = match fs::read_dir(&dir) {
      Ok(r) => r,
      Err(_) => {
        unreadable += 1;
        continue;
      }
    };
    let mut items: Vec<fs::DirEntry> = Vec::new();
    for item in reader {
      if visited >= limits.visited {
        truncated = true;
        break;
      }
      visited += 1;
      if let Ok(item) = item {
        items.push(item);
      }
    }
    items.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for item in items {
      let name = item.file_name().to_string_lossy().into_owned();
      let Ok(kind) = item.file_type() else { continue };
      let path = item.path();
      if kind.is_dir() {
        if !skipped_folder(&name) && depth < limits.depth {
          queue.push_back((path, format!("{rel}{name}/"), depth + 1));
        }
        continue;
      }
      // A file, or a link: listed when it is (or leads to) a Markdown file. A link to a folder is never
      // followed, and `markdown_file` refuses it (not a file).
      if !paths::has_markdown_extension(&path) {
        continue;
      }
      if kind.is_symlink() && paths::markdown_file(&path).is_err() {
        continue;
      }
      let Ok(meta) = fs::metadata(&path) else { continue };
      if !meta.is_file() {
        continue;
      }
      entries.push(FolderEntry {
        path: paths::display_path(&path),
        rel: format!("{rel}{name}"),
        name,
        depth,
        size: meta.len(),
        mtime_ms: fsio::mtime_ms(&meta),
      });
      if entries.len() >= limits.entries {
        truncated = true;
        break 'walk;
      }
    }
    if truncated {
      break;
    }
  }

  FolderListing {
    root: paths::display_path(root),
    name: paths::display_name(root),
    entries,
    truncated,
    unreadable,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fsio::tests::Scratch;

  fn write(root: &Path, rel: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, format!("# {rel}\n")).unwrap();
  }

  fn rels(listing: &FolderListing) -> Vec<String> {
    let mut v: Vec<String> = listing.entries.iter().map(|e| e.rel.clone()).collect();
    v.sort();
    v
  }

  #[test]
  fn lists_markdown_files_and_skips_git_node_modules_and_dot_folders() {
    let dir = Scratch::new("folders", "skip");
    for rel in [
      "README.md",
      "notes/a.markdown",
      "notes/deeper/b.MD",
      "notes/c.txt",
      ".git/HEAD.md",
      ".hidden/secret.md",
      "node_modules/pkg/README.md",
      "src/node_modules/inner.md",
      ".draft.md",
    ] {
      write(&dir.0, rel);
    }
    let listing = list_markdown(&folder(&dir.0).unwrap(), LIMITS);
    assert_eq!(rels(&listing), vec![".draft.md", "README.md", "notes/a.markdown", "notes/deeper/b.MD"]);
    assert!(!listing.truncated);
    assert_eq!(listing.unreadable, 0);
    let b = listing.entries.iter().find(|e| e.name == "b.MD").unwrap();
    assert_eq!(b.depth, 2);
    assert!(b.path.ends_with("b.MD"));
    assert!(b.size > 0 && b.mtime_ms > 0.0);
  }

  #[test]
  fn stops_at_the_depth_limit() {
    let dir = Scratch::new("folders", "depth");
    write(&dir.0, "1/2/3/4/5/6/7/8/listed.md");
    write(&dir.0, "1/2/3/4/5/6/7/8/9/too-deep.md");
    let listing = list_markdown(&folder(&dir.0).unwrap(), LIMITS);
    assert_eq!(rels(&listing), vec!["1/2/3/4/5/6/7/8/listed.md"]);
    assert_eq!(listing.entries[0].depth, 8);
  }

  #[test]
  fn stops_at_the_entry_limit_keeping_the_files_nearest_the_top() {
    let dir = Scratch::new("folders", "entries");
    for i in 0..6 {
      write(&dir.0, &format!("deep/{i}.md"));
    }
    write(&dir.0, "top.md");
    let limits = Limits { entries: 4, ..LIMITS };
    let listing = list_markdown(&folder(&dir.0).unwrap(), limits);
    assert_eq!(listing.entries.len(), 4);
    assert!(listing.truncated);
    assert_eq!(listing.entries[0].rel, "top.md", "breadth-first: the root's files come first");
  }

  #[test]
  fn stops_after_looking_at_enough_entries() {
    let dir = Scratch::new("folders", "visited");
    for i in 0..30 {
      fs::write(dir.join(&format!("{i:02}.txt")), "x").unwrap();
    }
    write(&dir.0, "zz.md");
    let listing = list_markdown(&folder(&dir.0).unwrap(), Limits { visited: 10, ..LIMITS });
    assert!(listing.truncated);
    assert!(listing.entries.is_empty());
  }

  #[test]
  fn only_an_existing_folder_is_accepted() {
    let dir = Scratch::new("folders", "accept");
    write(&dir.0, "doc.md");
    assert_eq!(folder(&dir.join("doc.md")).unwrap_err().code, "not-a-directory");
    assert_eq!(folder(&dir.join("missing")).unwrap_err().code, "not-found");
    assert_eq!(folder(Path::new("")).unwrap_err().code, "not-found");
    let indirect = dir.0.join("sub").join("..");
    fs::create_dir_all(dir.join("sub")).unwrap();
    assert!(paths::same_file(&folder(&indirect).unwrap(), &folder(&dir.0).unwrap()));
  }

  #[cfg(unix)]
  #[test]
  fn links_to_folders_are_not_followed_and_links_to_files_only_when_markdown() {
    let dir = Scratch::new("folders", "links");
    write(&dir.0, "real/doc.md");
    fs::write(dir.join("secret.txt"), "x").unwrap();
    std::os::unix::fs::symlink(dir.join("real"), dir.join("loop")).unwrap();
    std::os::unix::fs::symlink(&dir.0, dir.join("real").join("up")).unwrap();
    std::os::unix::fs::symlink(dir.join("real/doc.md"), dir.join("alias.md")).unwrap();
    std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("innocent.md")).unwrap();
    let listing = list_markdown(&folder(&dir.0).unwrap(), LIMITS);
    assert_eq!(rels(&listing), vec!["alias.md", "real/doc.md"]);
  }
}
