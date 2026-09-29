fn main() {
    // App commands otherwise bypass capability ACLs by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "shell_state",
            "save_installation",
            "forget_installation",
            "connect_installation",
            "disconnect_installation",
            "open_installation_browser",
            "set_language",
            "acknowledge_tray",
            "quit_app",
        ]),
    ))
    .expect("could not build the desktop command permissions");
}
