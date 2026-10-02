//! Tauri startup: plugins, managed state, and background tasks.
use super::installation::offer_desktop_link;
use super::tray::{self, show_current};
use super::trust::shell_navigation;
use super::voice::{handle_shortcut, start_delivery, VoiceEvent};
use super::{Inner, Shell};
use crate::{
    appearance, call_state, deep_links, installations, native_notifications, shortcuts,
    update_installer, updates,
};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64};
use tauri::Manager;
use tokio::sync::Mutex;

pub(super) fn run() {
    tauri::Builder::default()
        .manage(deep_links::PendingLink::default())
        .manage(super::update_commands::TrayUpdateRequest::default())
        // Register first, before any other plugin initializes a webview.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(target) = deep_links::from_args(&args) {
                offer_desktop_link(app, target);
            } else if args.len() == 1 {
                show_current(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        // Handle browser opening in Rust. The plugin's default injected click
        // listener would consume remote links and invoke its forbidden IPC API.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(handle_shortcut)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            super::notification_commands::activate_installation,
            super::notification_commands::reset_notification_permission,
            super::notification_commands::reset_microphone_permission,
            super::notification_commands::reset_camera_permission,
            super::notification_commands::set_installation_theme,
            super::notification_commands::show_desktop_notification,
            super::notification_commands::close_desktop_notification,
            super::installation::shell_state,
            super::settings::desktop_settings,
            super::installation::take_desktop_link,
            super::installation::transition_state,
            super::installation::report_call_state,
            super::installation::save_installation,
            super::installation::forget_installation,
            super::installation::connect_installation,
            super::installation::cancel_connection,
            super::installation::disconnect_installation,
            super::installation::open_installation_browser,
            super::installation::set_language,
            super::installation::acknowledge_tray,
            super::installation::quit_app,
            super::update_commands::shell_update_state,
            super::update_commands::take_tray_update_check,
            super::update_commands::read_desktop_update,
            super::update_commands::review_desktop_update,
            super::update_commands::check_shell_update,
            super::update_commands::download_shell_update,
            super::update_commands::cancel_shell_update,
            super::update_commands::install_shell_update,
            super::voice::set_mute_shortcut,
            super::voice::set_deafen_shortcut,
            super::voice::set_push_to_talk_shortcut,
            super::voice::set_push_to_mute_shortcut,
            super::voice::set_microphone_mode,
            super::voice::set_push_to_talk_release_delay
        ])
        .setup(|app| {
            crate::platform::configure_taskbar_identity(app.handle());
            if let Ok(cache) = app.path().app_cache_dir() {
                update_installer::cleanup(&cache.join("updates"));
            }
            let updates_enabled = cfg!(target_os = "windows") && updates::configured(app.handle());
            if updates_enabled {
                // No updater plugin ACL is granted to any webview, including the shell.
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            app.manage(updates::Updates::new(updates_enabled));
            let data = app.path().app_local_data_dir()?;
            let preferences = installations::load(&data.join("installations.json"))
                .map_err(std::io::Error::other)?;
            if !data.join("installations.json").exists() {
                installations::save(&data.join("installations.json"), &preferences)
                    .map_err(std::io::Error::other)?;
            }
            let tray_menu = tray::create(app, preferences.language)?;
            let mut registrations = std::array::from_fn(|_| shortcuts::Registration::default());
            let latches = std::array::from_fn(|_| shortcuts::ShortcutLatch::default());
            for action in shortcuts::Action::ALL {
                if cfg!(target_os = "windows") {
                    registrations[action.index()].restore(
                        preferences.binding(action),
                        &mut shortcuts::NativeRegistry {
                            app: app.handle(),
                            action,
                            current: None,
                        },
                    );
                }
                latches[action.index()].bind(registrations[action.index()].active.as_deref());
            }
            let (shortcut_events, events) = tokio::sync::mpsc::unbounded_channel::<VoiceEvent>();
            let release_delay_ms = preferences.push_to_talk_release_delay_ms;
            let quit_on_close = preferences.quit_on_close;
            app.manage(native_notifications::Notifications::default());
            app.manage(Shell {
                reports: call_state::Reports::default(),
                recording_shortcut: AtomicBool::new(false),
                quit_on_close: AtomicBool::new(quit_on_close),
                ready_generation: AtomicU64::new(0),
                home_requested: AtomicBool::new(false),
                launch_sequence: AtomicU64::new(0),
                inner: Mutex::new(Inner {
                    preferences,
                    active: None,
                    loading: false,
                    loading_attempt: 0,
                    shortcuts: registrations,
                }),
                data,
                menu: tray_menu,
                shortcut_latches: latches,
                shortcut_events,
                voice_generation: AtomicU64::new(0),
                voice_target: std::sync::RwLock::new(None),
                push_to_talk_release_delay_ms: AtomicU16::new(release_delay_ms),
            });
            if updates_enabled {
                let update_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let updates = update_app.state::<updates::Updates>();
                        if updates.check(&update_app).await.is_ok()
                            && updates.background_download_allowed()
                        {
                            let _ = updates.download(&update_app).await;
                        }
                        // Native scheduling also runs while every window is hidden.
                        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    }
                });
            }
            start_delivery(app.handle(), events);
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .background_color(tauri::window::Color(15, 19, 25, 255))
                    .on_navigation(shell_navigation)
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_download(|_, _| false)
                    .build()?;
            let _ = appearance::apply(&window, appearance::WindowTheme::Welcome);
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Focused(true)) {
                    let _ = appearance::apply(&close_window, appearance::WindowTheme::Welcome);
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    super::close_requested(&close_window);
                }
            });
            super::update_commands::initialize_tray_check(app.handle());
            // Validate the original, bounded URI rather than a plugin-normalized
            // URL. The same parser handles single-instance forwarded arguments.
            if cfg!(windows) {
                let args: Option<Vec<String>> = std::env::args_os()
                    .take(3)
                    .map(|arg| arg.into_string().ok())
                    .collect();
                if let Some(target) = args.as_deref().and_then(deep_links::from_args) {
                    offer_desktop_link(app.handle(), target);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start Voxly desktop");
}
