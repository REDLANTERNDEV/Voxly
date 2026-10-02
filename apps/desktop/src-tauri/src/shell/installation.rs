//! Installation preferences, window transitions, and local shell commands.
use super::tray::{show_current, show_shell, update_tray_language};
use super::trust::{report_caller_matches, trusted_shell};
use super::{persist, snapshot, Inner, Shell, ShellSnapshot};
use crate::installations::Language;
use crate::{call_state, deep_links, installations, native_notifications, platform};
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

pub(super) fn remote_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    let shell = app.try_state::<Shell>()?;
    app.get_webview_window(&platform::installation_label(
        shell.voice_generation.load(Ordering::Acquire),
    ))
}

pub(super) async fn query_call_state(
    app: &tauri::AppHandle,
    shell: &Shell,
) -> Option<call_state::CallState> {
    let remote = remote_window(app)?;
    let target = shell.voice_target.read().ok()?.clone()?;
    if !installations::same_origin(&target.origin, &remote.url().ok()?) {
        return None;
    }
    let generation = shell.voice_generation.load(Ordering::Acquire);
    let (request, revision, reply) = shell.reports.request(generation);
    if remote
        .eval(format!(
            "window.__VOXLY_DESKTOP_STATE_V1__?.request({request});"
        ))
        .is_err()
    {
        shell.reports.invalidate();
        return None;
    }
    let report = tokio::time::timeout(std::time::Duration::from_millis(750), reply)
        .await
        .ok()
        .and_then(Result::ok);
    if shell.reports.finish(revision) {
        report
    } else {
        None
    }
}

#[tauri::command]
pub(super) async fn report_call_state(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    request: u32,
    report: call_state::CallState,
) -> Result<(), &'static str> {
    let generation = shell.voice_generation.load(Ordering::Acquire);
    let target = shell.voice_target.read().map_err(|_| "forbidden")?;
    let active = target.as_ref().ok_or("forbidden")?;
    if !report_caller_matches(
        generation,
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        return Err("forbidden");
    }
    shell.reports.receive(generation, request, report)
}

#[tauri::command]
pub(super) async fn transition_state(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<Option<call_state::CallState>, &'static str> {
    trusted_shell(&window)?;
    let inner = shell.inner.lock().await;
    if inner.active.is_none() {
        return Ok(None);
    }
    Ok(query_call_state(&app, &shell).await)
}

async fn require_confirmation(
    app: &tauri::AppHandle,
    shell: &Shell,
    inner: &Inner,
    confirmed: bool,
) -> Result<(), &'static str> {
    if inner.active.is_some()
        && !confirmed
        && query_call_state(app, shell)
            .await
            .is_none_or(|state| state.needs_confirmation())
    {
        return Err("confirmation_required");
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn shell_state(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    Ok(snapshot(&*shell.inner.lock().await))
}

#[tauri::command]
pub(super) async fn take_desktop_link(
    window: WebviewWindow,
    pending: tauri::State<'_, deep_links::PendingLink>,
) -> Result<Option<deep_links::DesktopLink>, &'static str> {
    trusted_shell(&window)?;
    Ok(pending.take())
}

#[tauri::command]
pub(super) async fn save_installation(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    address: String,
    name: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let mut saved = installations::installation(&address)?;
    installations::validate_name(name.as_deref())?;
    saved.name = name
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.trim().to_string());
    let mut inner = shell.inner.lock().await;
    let mut next = inner.preferences.clone();
    if !next.installations.iter().any(|entry| entry.id == saved.id) {
        if next.installations.len() >= installations::INSTALLATION_LIMIT {
            return Err("installation_limit");
        }
        next.installations.push(saved);
        persist(&shell, &next)?;
        inner.preferences = next;
    }
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(super) async fn forget_installation(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    id: String,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let mut inner = shell.inner.lock().await;
    if inner.active.as_ref().is_some_and(|active| active.id == id) {
        return Err("disconnect_first");
    }
    let mut next = inner.preferences.clone();
    next.forget(&id);
    persist(&shell, &next)?;
    inner.preferences = next;
    // Forgetting an address doesn't sign out or delete a browser profile.
    Ok(snapshot(&inner))
}

async fn check_health(origin: &str) -> Result<(), &'static str> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "unreachable")?;
    let mut response = client
        .get(format!("{origin}/api/health"))
        .send()
        .await
        .map_err(|_| "unreachable")?;
    if !response.status().is_success() {
        return Err("unreachable");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "unreachable")? {
        if body.len() + chunk.len() > 4096 {
            return Err("unreachable");
        }
        body.extend_from_slice(&chunk);
    }
    let json: serde_json::Value = serde_json::from_slice(&body).map_err(|_| "unreachable")?;
    if json.get("status").and_then(|value| value.as_str()) == Some("ok") {
        Ok(())
    } else {
        Err("unreachable")
    }
}

#[tauri::command]
pub(super) async fn connect_installation(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    id: String,
    confirm_leave: bool,
    reload: bool,
    desktop_launch: Option<String>,
    address: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    if desktop_launch
        .as_deref()
        .is_some_and(|id| !deep_links::launch_id(id))
    {
        return Err("invalid_address");
    }
    let attempt = shell.launch_sequence.fetch_add(1, Ordering::AcqRel) + 1;
    shell.home_requested.store(false, Ordering::Release);
    // Serialize changes across the await: two clicks cannot create two windows.
    let mut inner = shell.inner.lock().await;
    let saved = if let Some(address) = address.as_deref() {
        let canonical = installations::installation(address)?;
        if !id.is_empty() && canonical.id != id {
            return Err("invalid_address");
        }
        inner
            .preferences
            .installations
            .iter()
            .find(|entry| entry.id == canonical.id)
            .cloned()
            .unwrap_or(canonical)
    } else {
        inner
            .preferences
            .installations
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
            .ok_or("installation_missing")?
    };
    if !reload
        && !(inner.loading && desktop_launch.is_some())
        && inner
            .active
            .as_ref()
            .is_some_and(|active| active.id == saved.id)
    {
        if let Some(remote) = remote_window(&app) {
            if inner.loading {
                inner.loading_attempt = attempt;
            }
            if !inner.loading {
                remote.show().map_err(|_| "window_failed")?;
                remote.set_focus().map_err(|_| "window_failed")?;
                let _ = window.hide();
            }

            return Ok(snapshot(&inner));
        }
    }
    // Keep the old installation/call intact if the replacement is unreachable.
    check_health(&saved.origin).await?;
    if shell.launch_sequence.load(Ordering::Acquire) != attempt {
        return Err("connection_cancelled");
    }
    require_confirmation(&app, &shell, &inner, confirm_leave).await?;
    if shell.launch_sequence.load(Ordering::Acquire) != attempt {
        return Err("connection_cancelled");
    }
    if let Some(remote) = remote_window(&app) {
        remote.destroy().map_err(|_| "window_failed")?;
    }
    let generation = shell.voice_generation.fetch_add(1, Ordering::AcqRel) + 1;
    shell.reports.invalidate();
    *shell.voice_target.write().map_err(|_| "window_failed")? = None;
    inner.active = None;
    platform::open_installation(
        &app,
        &saved,
        &shell.data,
        inner.preferences.microphone_mode,
        generation,
        desktop_launch.as_deref(),
    )?;
    *shell.voice_target.write().map_err(|_| "window_failed")? = Some(saved.clone());
    inner.active = Some(saved.clone());
    inner.loading = true;
    inner.loading_attempt = attempt;
    shell.recording_shortcut.store(false, Ordering::Release);
    let loading_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let shell = loading_app.state::<Shell>();
        let mut inner = shell.inner.lock().await;
        if shell.voice_generation.load(Ordering::Acquire) == generation
            && shell.ready_generation.load(Ordering::Acquire) != generation
            && inner.loading
        {
            inner.loading = false;
            show_shell(&loading_app);
            let _ = loading_app.emit_to("shell", "shell:load-failed", saved);
        }
    });
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(super) async fn cancel_connection(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    // Invalidate before waiting for health/window creation so late work cannot reveal a window.
    shell.launch_sequence.fetch_add(1, Ordering::AcqRel);
    let mut inner = shell.inner.lock().await;
    if inner.loading {
        if let Some(remote) = remote_window(&app) {
            remote.destroy().map_err(|_| "window_failed")?;
        }
        shell.voice_generation.fetch_add(1, Ordering::AcqRel);
        shell.reports.invalidate();
        *shell.voice_target.write().map_err(|_| "window_failed")? = None;
        inner.active = None;
        inner.loading = false;
    }
    show_shell(&app);
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(super) async fn disconnect_installation(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    confirm_leave: bool,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let mut inner = shell.inner.lock().await;
    require_confirmation(&app, &shell, &inner, confirm_leave).await?;
    if let Some(remote) = remote_window(&app) {
        // Destroying the webview ends its tracks, rather than hiding them.
        remote.destroy().map_err(|_| "window_failed")?;
    }
    shell.voice_generation.fetch_add(1, Ordering::AcqRel);
    shell.reports.invalidate();
    *shell.voice_target.write().map_err(|_| "window_failed")? = None;
    inner.active = None;
    inner.loading = false;
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(super) async fn open_installation_browser(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    id: String,
) -> Result<(), &'static str> {
    trusted_shell(&window)?;
    let inner = shell.inner.lock().await;
    let saved = inner
        .preferences
        .installations
        .iter()
        .find(|entry| entry.id == id)
        .ok_or("installation_missing")?;
    app.opener()
        .open_url(&saved.origin, None::<&str>)
        .map_err(|_| "browser_failed")
}

#[tauri::command]
pub(super) async fn set_language(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    language: Language,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let mut inner = shell.inner.lock().await;
    let mut next = inner.preferences.clone();
    next.language = language;
    persist(&shell, &next)?;
    update_tray_language(&shell.menu, language).map_err(|_| "window_failed")?;
    inner.preferences = next;
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(super) async fn acknowledge_tray(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let mut inner = shell.inner.lock().await;
    let mut next = inner.preferences.clone();
    next.tray_acknowledged = true;
    persist(&shell, &next)?;
    inner.preferences = next;
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(super) async fn quit_app(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    confirm_leave: bool,
) -> Result<(), &'static str> {
    trusted_shell(&window)?;
    let inner = shell.inner.lock().await;
    require_confirmation(&app, &shell, &inner, confirm_leave).await?;
    if let Some(remote) = remote_window(&app) {
        app.state::<native_notifications::Notifications>()
            .clear(remote.label());
        remote.destroy().map_err(|_| "window_failed")?;
    }
    app.exit(0);
    Ok(())
}

pub(super) fn offer_desktop_link(app: &tauri::AppHandle, target: deep_links::DesktopLink) {
    // Restoring the active Installation leaves its route and media untouched.
    let active = app.try_state::<Shell>().and_then(|shell| {
        shell
            .voice_target
            .read()
            .ok()
            .and_then(|active| active.clone())
    });
    let window_url = remote_window(app).and_then(|window| window.url().ok());
    let ready = app.try_state::<Shell>().is_some_and(|shell| {
        shell.ready_generation.load(Ordering::Acquire)
            == shell.voice_generation.load(Ordering::Acquire)
    });
    if ready
        && deep_links::restores_active(&target.installation, active.as_ref(), window_url.as_ref())
    {
        if let (Some(id), Some(remote)) = (target.launch_id.as_ref(), remote_window(app)) {
            // A finite public signal: the web UI ignores it if already signed in.
            // No cookies, credentials, paths, or native permission travel here.
            if let Ok(id) = serde_json::to_string(id) {
                let _ = remote.eval(format!("window.dispatchEvent(new CustomEvent('voxly:desktop-launch', {{ detail: {id} }}));"));
            }
        }
        show_current(app);
        return;
    }
    app.state::<deep_links::PendingLink>().offer(target);
    show_shell(app);
    let _ = app.emit_to("shell", "shell:desktop-link", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health_fixture(response: String) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0u8; 2048];
            let length = socket.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..length]);
            assert!(request.starts_with("GET /api/health HTTP/1.1"));
            assert!(!request.to_lowercase().contains("cookie:"));
            socket.write_all(response.as_bytes()).unwrap();
        });
        (origin, task)
    }

    #[test]
    fn health_checks_are_bounded_unauthenticated_and_do_not_follow_redirects() {
        let cases = [
            ("200 OK", r#"{"status":"ok"}"#.to_string(), "", true),
            ("200 OK", r#"{"status":"broken"}"#.to_string(), "", false),
            ("200 OK", "x".repeat(4097), "", false),
            (
                "302 Found",
                String::new(),
                "Location: http://127.0.0.1:1/\r\n",
                false,
            ),
            (
                "503 Unavailable",
                r#"{"status":"ok"}"#.to_string(),
                "",
                false,
            ),
        ];
        for (status, body, headers, expected) in cases {
            let response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}", body.len());
            let (origin, task) = health_fixture(response);
            assert_eq!(
                tauri::async_runtime::block_on(check_health(&origin)).is_ok(),
                expected,
                "{status}"
            );
            task.join().unwrap();
        }
    }
}
