use crate::installations::Installation;
use std::path::Path;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(windows)]
use webview2_com::{
    take_pwstr,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    },
    PermissionRequestedEventHandler,
};

pub fn installation_label(generation: u64) -> String {
    format!("installation-{generation}")
}

// Each Windows installation owns an entire WebView2 profile, including cookies,
// local storage, IndexedDB, and permissions. The shell uses the default profile.
pub fn open_installation(
    app: &AppHandle,
    saved: &Installation,
    data: &Path,
    microphone_mode: crate::installations::MicrophoneMode,
    generation: u64,
    desktop_launch: Option<&str>,
) -> Result<WebviewWindow, &'static str> {
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    let mut url: url::Url = saved.origin.parse().map_err(|_| "invalid_address")?;
    if let Some(id) = desktop_launch {
        if !crate::deep_links::launch_id(id) {
            return Err("invalid_address");
        }
        url.set_path("/link-device");
        url.query_pairs_mut().append_pair("desktopLaunch", id);
    }
    let origin = saved.origin.clone();
    let mut bootstrap = format!(
        "{}({}, {});\n{}({});\n{}({});\n{}({});\n{}({});\n{}({});\n{}({});\n{}({});",
        include_str!("voice-bridge.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?,
        serde_json::to_string(&microphone_mode).map_err(|_| "invalid_address")?,
        include_str!("call-state.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?,
        include_str!("navigation.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?,
        include_str!("activation.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?,
        include_str!("appearance.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?,
        include_str!("native-notifications.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?,
        include_str!("notifications.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?,
        include_str!("update-bridge.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?
    );
    bootstrap.push_str(&format!(
        "\n{}({});",
        include_str!("settings-bridge.js"),
        serde_json::to_string(&saved.origin).map_err(|_| "invalid_address")?
    ));
    let opener_app = app.clone();
    let label = installation_label(generation);
    // Grants never accumulate on a label reused by another installation.
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new(format!("call-state-{generation}"))
            .local(false)
            .remote(format!("{}/*", saved.origin))
            .webview(&label)
            .permission("allow-report-call-state")
            .permission("allow-activate-installation")
            .permission("allow-reset-notification-permission")
            .permission("allow-set-installation-theme")
            .permission("allow-show-desktop-notification")
            .permission("allow-close-desktop-notification")
            .permission("allow-read-desktop-update")
            .permission("allow-desktop-settings")
            .permission("allow-review-desktop-update"),
    )
    .map_err(|_| "window_failed")?;
    let navigation_app = app.clone();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(format!("Voxly — {}", saved.origin))
        .visible(false)
        .background_color(tauri::window::Color(15, 19, 25, 255))
        .inner_size(1280.0, 800.0)
        .min_inner_size(380.0, 520.0)
        .data_directory(data.join("profiles").join(&saved.id))
        .disable_drag_drop_handler()
        // Voice intent stays one-way; the separate state bridge can only report.
        .initialization_script(&bootstrap)
        .on_navigation(move |url| {
            if let Some(alerts) =
                navigation_app.try_state::<crate::native_notifications::Notifications>()
            {
                alerts.clear(&installation_label(generation));
            }
            if let Some(shell) = navigation_app.try_state::<crate::shell::Shell>() {
                shell.reports.invalidate();
            }
            crate::installations::same_origin(&origin, url)
        })
        .on_new_window(move |url, _| {
            if crate::installations::browser_url(&url) {
                use tauri_plugin_opener::OpenerExt;
                let _ = opener_app.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        // Downloads are outside the feasibility client's authority.
        .on_download(|_, _| false)
        .build()
        .map_err(|_| "window_failed")?;
    #[cfg(windows)]
    {
        let notification_origin = saved.origin.clone();
        let notification_window = window.clone();
        window
            .with_webview(move |webview| unsafe {
                let Ok(core) = webview.controller().CoreWebView2() else {
                    return;
                };
                crate::native_notifications::suppress_focused_webview_notifications(
                    &notification_window,
                    &core,
                );
                let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = Default::default();
                    args.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                        return Ok(());
                    }
                    let mut uri = windows::core::PWSTR::null();
                    args.Uri(&mut uri)?;
                    let request_url = take_pwstr(uri);
                    let mut initiated = windows::core::BOOL(0);
                    args.IsUserInitiated(&mut initiated)?;
                    let same_installation = url::Url::parse(&request_url).is_ok_and(|url| {
                        crate::installations::same_origin(&notification_origin, &url)
                    });
                    if initiated.as_bool() && same_installation {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                    Ok(())
                }));
                let mut token = 0_i64;
                let _ = core.add_PermissionRequested(&handler, &mut token);
            })
            .map_err(|_| "window_failed")?;
    }
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            close_window
                .app_handle()
                .state::<crate::native_notifications::Notifications>()
                .clear(close_window.label());
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Keep the webview and all peer connections alive when hidden.
            if close_window.hide().is_ok() {
                api.prevent_close();
            }
        }
    });
    Ok(window)
}

pub async fn reset_notification_permission(
    window: &WebviewWindow,
    origin: String,
) -> Result<(), &'static str> {
    #[cfg(windows)]
    {
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::{
                ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
            },
            SetPermissionStateCompletedHandler,
        };
        use windows::core::{Interface, HSTRING, PWSTR};

        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                // Dropping the sender on any preflight/API error fails the request.
                let _ = (|| -> Result<(), &'static str> {
                    let core = unsafe { webview.controller().CoreWebView2() }
                        .map_err(|_| "permission_failed")?;
                    let mut source = PWSTR::null();
                    unsafe { core.Source(&mut source) }.map_err(|_| "permission_failed")?;
                    let source = take_pwstr(source);
                    if !url::Url::parse(&source)
                        .is_ok_and(|url| crate::installations::same_origin(&origin, &url))
                    {
                        return Err("forbidden");
                    }
                    let view: ICoreWebView2_13 = core.cast().map_err(|_| "unsupported_platform")?;
                    let profile: ICoreWebView2Profile4 = unsafe { view.Profile() }
                        .and_then(|profile| profile.cast())
                        .map_err(|_| "unsupported_platform")?;
                    let completion =
                        SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                            let _ = send.send(result.map_err(|_| "permission_failed"));
                            Ok(())
                        }));
                    unsafe {
                        profile.SetPermissionState(
                            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
                            &HSTRING::from(origin),
                            COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                            &completion,
                        )
                    }
                    .map_err(|_| "permission_failed")
                })();
            })
            .map_err(|_| "permission_failed")?;
        tokio::time::timeout(std::time::Duration::from_secs(3), receive)
            .await
            .map_err(|_| "permission_failed")?
            .map_err(|_| "permission_failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, origin);
        Err("unsupported_platform")
    }
}
