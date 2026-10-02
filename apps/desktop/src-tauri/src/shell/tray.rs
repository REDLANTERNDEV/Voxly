//! Tray menu, localized labels, and window reveal behavior.
use super::installation::remote_window;
use super::update_commands::check_from_tray;
use crate::installations::Language;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{Emitter, Manager};

pub(super) struct TrayMenu {
    pub(super) update: tauri::menu::MenuItem<tauri::Wry>,
    pub(super) show: tauri::menu::MenuItem<tauri::Wry>,
    pub(super) installations: tauri::menu::MenuItem<tauri::Wry>,
    pub(super) quit: tauri::menu::MenuItem<tauri::Wry>,
}

pub(super) fn show_shell(app: &tauri::AppHandle) {
    if let Some(shell) = app.try_state::<super::Shell>() {
        shell
            .home_requested
            .store(true, std::sync::atomic::Ordering::Release);
    }
    let _ = app.emit_to("shell", "shell:show-home", ());
    if let Some(window) = app.get_webview_window("shell") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(super) fn show_current(app: &tauri::AppHandle) {
    if let Some(shell) = app.try_state::<super::Shell>() {
        if shell
            .ready_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != shell
                .voice_generation
                .load(std::sync::atomic::Ordering::Acquire)
        {
            if let Some(window) = app.get_webview_window("shell") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            return;
        }
    }
    if let Some(window) = remote_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        show_shell(app);
    }
}

pub(super) fn update_tray_language(menu: &TrayMenu, language: Language) -> tauri::Result<()> {
    let tr = language == Language::Tr;
    menu.show
        .set_text(if tr { "Voxly’yi aç" } else { "Show Voxly" })?;
    menu.installations
        .set_text(if tr { "Ana sayfa" } else { "Home" })?;
    menu.update.set_text(if tr {
        "Güncellemeleri kontrol et"
    } else {
        "Check for updates"
    })?;
    menu.quit.set_text(if tr { "Çık…" } else { "Quit…" })
}

pub(super) fn create(
    app: &tauri::App,
    language: Language,
) -> Result<TrayMenu, Box<dyn std::error::Error>> {
    let show = tauri::menu::MenuItem::with_id(app, "show", "Show Voxly", true, None::<&str>)?;
    let installations =
        tauri::menu::MenuItem::with_id(app, "installations", "Home", true, None::<&str>)?;
    let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit…", true, None::<&str>)?;
    let update =
        tauri::menu::MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let menu =
        tauri::menu::Menu::with_items(app, &[&show, &installations, &update, &separator, &quit])?;
    let tray_menu = TrayMenu {
        update,
        show,
        installations,
        quit,
    };
    update_tray_language(&tray_menu, language)?;
    tauri::tray::TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .ok_or("missing tray icon")?
                .clone(),
        )
        .tooltip("Voxly")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_current(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_current(app),
            "installations" => show_shell(app),
            "update" => check_from_tray(app),
            "quit" => {
                show_shell(app);
                let _ = app.emit_to("shell", "shell:quit-requested", ());
            }
            _ => {}
        })
        .build(app)?;
    Ok(tray_menu)
}
