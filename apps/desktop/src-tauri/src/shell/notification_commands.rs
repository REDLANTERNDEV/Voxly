//! Finite commands available to the active Installation window.
use super::trust::report_caller_matches;
use super::Shell;
use crate::{appearance, native_notifications, platform};
use std::sync::atomic::Ordering;
use tauri::{Manager, WebviewWindow};

#[tauri::command]
pub(super) async fn activate_installation(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<(), &'static str> {
    // Serialize against replacement; an old toast cannot focus a new installation.
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    if inner.loading {
        return Err("window_loading");
    }
    window.show().map_err(|_| "window_failed")?;
    window.unminimize().map_err(|_| "window_failed")?;
    window.set_focus().map_err(|_| "window_failed")
}

#[tauri::command]
pub(super) async fn reset_notification_permission(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<(), &'static str> {
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    platform::reset_permission(
        &window,
        active.origin.clone(),
        platform::PermissionToReset::Notification,
    )
    .await
}

#[tauri::command]
pub(super) async fn reset_microphone_permission(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<(), &'static str> {
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    platform::reset_permission(
        &window,
        active.origin.clone(),
        platform::PermissionToReset::Microphone,
    )
    .await
}

#[tauri::command]
pub(super) async fn reset_camera_permission(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<(), &'static str> {
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    platform::reset_permission(
        &window,
        active.origin.clone(),
        platform::PermissionToReset::Camera,
    )
    .await
}

#[tauri::command]
pub(super) async fn set_installation_theme(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    theme: appearance::WindowTheme,
) -> Result<(), &'static str> {
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    appearance::apply(&window, theme)
}

#[tauri::command]
pub(super) async fn show_desktop_notification(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    request: native_notifications::Request,
) -> Result<native_notifications::Delivery, &'static str> {
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    if !native_notifications::valid_id(&request.id) {
        return Err("invalid_notification");
    }
    Ok(window
        .app_handle()
        .state::<native_notifications::Notifications>()
        .show(&window, request))
}

#[tauri::command]
pub(super) async fn close_desktop_notification(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    id: String,
) -> Result<(), &'static str> {
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    if !native_notifications::valid_id(&id) {
        return Err("invalid_notification");
    }
    window
        .app_handle()
        .state::<native_notifications::Notifications>()
        .close(window.label(), &id);
    Ok(())
}
