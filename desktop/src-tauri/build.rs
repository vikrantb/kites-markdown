fn main() {
  // Each command gets a generated `allow-<command>` permission; capabilities/default.json grants them
  // to the viewer windows. A command not listed here cannot be called by the page.
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&[
      "mdv_initial_document",
      "mdv_read_document",
      "mdv_save_document",
      "mdv_open_dialog",
      "mdv_open_path",
      "mdv_open_external",
      "mdv_make_default",
      "mdv_self_test_requested",
      "mdv_self_test_options",
      "mdv_self_test_external_edit",
      "mdv_self_test_report",
    ]),
  ))
  .expect("tauri-build failed");
}
