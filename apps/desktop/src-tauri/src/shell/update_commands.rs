//! Local update authority and read-only Installation update presentation.
use super::Shell;
use super::installation::{query_call_state, remote_window};
use super::tray::show_shell;
use super::trust::{report_caller_matches, trusted_shell};
use crate::{native_notifications, update_installer, updates};
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewWindow};

#[tauri::command]
pub(super) async fn shell_update_state(
    window: WebviewWindow,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<updates::Snapshot, &'static str> {
    trusted_shell(&window)?;
    Ok(updates.snapshot())
}

// Installation content may read presentation and open local review, never install.
#[tauri::command]
pub(super) async fn read_desktop_update(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<updates::Snapshot, &'static str> {
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
    Ok(updates.snapshot())
}

#[tauri::command]
pub(super) async fn review_desktop_update(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<(), &'static str> {
    read_desktop_update(window, shell, updates).await?;
    review_update(&app);
    Ok(())
}

pub(super) fn review_update(app: &tauri::AppHandle) {
    show_shell(app);
    let _ = app.emit_to("shell", "shell:review-update", ());
}

pub(crate) fn publish_update_state(app: &tauri::AppHandle) {
    let state = app.state::<updates::Updates>().snapshot();
    let _ = app.emit_to("shell", "shell:updates", &state);
    if let Ok(json) = serde_json::to_string(&state) {
        for (label, window) in app.webview_windows() {
            if label.starts_with("installation-") {
                let _ = window.eval(format!(
                    "window.__VOXLY_DESKTOP_UPDATES_V1__?.dispatch({json});"
                ));
            }
        }
    }
    let native = app.clone();
    let _ = app.run_on_main_thread(move || {
        let shell = native.state::<Shell>();
        let ready = native.state::<updates::Updates>().snapshot().phase == "ready";
        let present = shell.menu.root.get("update").is_some();
        if ready && !present {
            let _ = shell.menu.root.insert(&shell.menu.update, 2);
        }
        if !ready && present {
            let _ = shell.menu.root.remove(&shell.menu.update);
        }
    });
}

#[tauri::command]
pub(super) async fn check_shell_update(
    app: tauri::AppHandle,
    window: WebviewWindow,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<updates::Snapshot, &'static str> {
    trusted_shell(&window)?;
    updates.check(&app).await
}

#[tauri::command]
pub(super) async fn download_shell_update(
    app: tauri::AppHandle,
    window: WebviewWindow,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<updates::Snapshot, &'static str> {
    trusted_shell(&window)?;
    updates.download(&app).await
}

#[tauri::command]
pub(super) async fn cancel_shell_update(
    app: tauri::AppHandle,
    window: WebviewWindow,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<updates::Snapshot, &'static str> {
    trusted_shell(&window)?;
    let result = updates.cancel();
    publish_update_state(&app);
    result
}

#[tauri::command]
pub(super) async fn install_shell_update(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    updates: tauri::State<'_, updates::Updates>,
    confirmed: bool,
) -> Result<(), &'static str> {
    trusted_shell(&window)?;
    // Always require local consent, even when both windows are idle.
    if !confirmed {
        return Err("confirmation_required");
    }
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    let _lease = updates.operation.try_lock().map_err(|_| "update_busy")?;
    let mut inner = shell.inner.lock().await;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "update_install_failed")?
        .join("updates");
    let bytes = updates.installer()?;
    publish_update_state(&app);
    let prepared = match update_installer::Prepared::new(&root, &bytes) {
        Ok(prepared) => prepared,
        Err(error) => {
            updates.install_failed(&app);
            return Err(error);
        }
    };
    // A current report remains advisory; explicit consent includes unknown and pending media.
    let _report = query_call_state(&app, &shell).await;
    if let Some(remote) = remote_window(&app) {
        app.state::<native_notifications::Notifications>()
            .clear(remote.label());
        if remote.destroy().is_err() {
            updates.install_failed(&app);
            return Err("window_failed");
        }
    }
    shell.voice_generation.fetch_add(1, Ordering::AcqRel);
    shell.reports.invalidate();
    *shell.voice_target.write().map_err(|_| "window_failed")? = None;
    inner.active = None;
    // No await between teardown and install: no new Installation can open under this lease.
    if prepared.launch().is_err() {
        updates.install_failed(&app);
        return Err("update_install_failed");
    }
    app.exit(0);
    Ok(())
}
