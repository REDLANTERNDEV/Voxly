fn main() {
    // App commands otherwise bypass capability ACLs by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "shell_state",
            "take_desktop_link",
            "transition_state",
            "report_call_state",
            "activate_installation",
            "reset_notification_permission",
            "set_installation_theme",
            "show_desktop_notification",
            "close_desktop_notification",
            "save_installation",
            "forget_installation",
            "connect_installation",
            "disconnect_installation",
            "open_installation_browser",
            "set_language",
            "acknowledge_tray",
            "quit_app",
            "set_mute_shortcut",
            "set_deafen_shortcut",
            "set_push_to_talk_shortcut",
            "set_push_to_mute_shortcut",
            "set_microphone_mode",
            "set_push_to_talk_release_delay",
        ]),
    ))
    .expect("could not build the desktop command permissions");
}
