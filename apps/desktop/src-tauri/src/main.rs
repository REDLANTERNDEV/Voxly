#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod installations;
#[cfg(target_os = "windows")]
mod mouse_hook;
mod platform;
mod shortcuts;

use installations::{Installation, Language, Preferences};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

struct Shell {
    inner: Mutex<Inner>,
    data: PathBuf,
    menu: TrayMenu,
    shortcut_latches: [shortcuts::ShortcutLatch; 4],
    shortcut_events: tokio::sync::mpsc::UnboundedSender<VoiceEvent>,
    voice_generation: AtomicU64,
    voice_target: std::sync::RwLock<Option<Installation>>,
    push_to_talk_release_delay_ms: AtomicU16,
}

struct Inner {
    preferences: Preferences,
    active: Option<Installation>,
    shortcuts: [shortcuts::Registration; 4],
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct VoiceEvent {
    action: shortcuts::Action,
    pressed: bool,
    generation: u64,
    allow_release_delay: bool,
}

#[derive(Debug, PartialEq)]
enum VoiceDelivery {
    Input(VoiceEvent),
    TalkReleaseExpired(u64),
}

async fn next_voice_delivery(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<VoiceEvent>,
    release: &mut Option<(tokio::time::Instant, u64)>,
) -> Option<VoiceDelivery> {
    if let Some((deadline, generation)) = *release {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(event) => event.map(VoiceDelivery::Input),
            Err(_) => {
                *release = None;
                Some(VoiceDelivery::TalkReleaseExpired(generation))
            }
        }
    } else {
        events.recv().await.map(VoiceDelivery::Input)
    }
}

struct TrayMenu {
    show: tauri::menu::MenuItem<tauri::Wry>,
    installations: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSnapshot {
    preferences: Preferences,
    active: Option<Installation>,
    platform: &'static str,
    shell_version: &'static str,
    registered_mute_shortcut: Option<String>,
    shortcut_error: Option<&'static str>,
    registered_deafen_shortcut: Option<String>,
    deafen_shortcut_error: Option<&'static str>,
    registered_push_to_talk_shortcut: Option<String>,
    push_to_talk_shortcut_error: Option<&'static str>,
    registered_push_to_mute_shortcut: Option<String>,
    push_to_mute_shortcut_error: Option<&'static str>,
}

fn trusted_shell(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() != "shell" {
        return Err("forbidden");
    }
    let url = window.url().map_err(|_| "forbidden")?;
    if shell_navigation(&url) {
        Ok(())
    } else {
        Err("forbidden")
    }
}

fn shell_navigation(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let origin = url.origin().ascii_serialization();
    // `tauri:` is non-special in URL, so its Origin is opaque; compare host too.
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || origin == "https://tauri.localhost"
        || (cfg!(debug_assertions) && origin == "http://127.0.0.1:1420")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_talk_release_deadline_expires_without_waiting_for_web_timers() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (_send, mut events) = tokio::sync::mpsc::unbounded_channel();
            let mut release = Some((tokio::time::Instant::now(), 7));
            assert_eq!(
                next_voice_delivery(&mut events, &mut release).await,
                Some(VoiceDelivery::TalkReleaseExpired(7))
            );
            assert!(release.is_none());
        });
    }

    #[test]
    fn new_shortcut_input_interrupts_a_pending_native_release_deadline() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
            let event = VoiceEvent {
                action: shortcuts::Action::PushToTalk,
                pressed: true,
                generation: 9,
                allow_release_delay: true,
            };
            send.send(event).unwrap();
            let mut release = Some((
                tokio::time::Instant::now() + std::time::Duration::from_secs(60),
                9,
            ));
            assert_eq!(
                next_voice_delivery(&mut events, &mut release).await,
                Some(VoiceDelivery::Input(event))
            );
        });
    }

    #[test]
    fn local_shell_cannot_navigate_to_remote_content() {
        assert!(shell_navigation(&"tauri://localhost/".parse().unwrap()));
        assert!(shell_navigation(
            &"https://tauri.localhost/".parse().unwrap()
        ));
        for url in [
            "https://chat.example/",
            "file:///tmp/index.html",
            "https://tauri.localhost.evil/",
            "https://user@tauri.localhost/",
            "http://127.0.0.1:3000/",
        ] {
            assert!(!shell_navigation(&url.parse().unwrap()), "{url}");
        }
    }

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

fn snapshot(inner: &Inner) -> ShellSnapshot {
    ShellSnapshot {
        preferences: inner.preferences.clone(),
        active: inner.active.clone(),
        platform: std::env::consts::OS,
        shell_version: env!("CARGO_PKG_VERSION"),
        registered_mute_shortcut: inner.shortcuts[0].active.clone(),
        shortcut_error: inner.shortcuts[0].error,
        registered_deafen_shortcut: inner.shortcuts[1].active.clone(),
        deafen_shortcut_error: inner.shortcuts[1].error,
        registered_push_to_talk_shortcut: inner.shortcuts[2].active.clone(),
        push_to_talk_shortcut_error: inner.shortcuts[2].error,
        registered_push_to_mute_shortcut: inner.shortcuts[3].active.clone(),
        push_to_mute_shortcut_error: inner.shortcuts[3].error,
    }
}

fn persist(shell: &Shell, preferences: &Preferences) -> Result<(), &'static str> {
    installations::save(&shell.data.join("installations.json"), preferences)
}

#[tauri::command]
async fn set_mute_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    set_shortcut(app, shell, binding, shortcuts::Action::Mute).await
}

#[tauri::command]
async fn set_deafen_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    set_shortcut(app, shell, binding, shortcuts::Action::Deafen).await
}

#[tauri::command]
async fn set_push_to_talk_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    set_shortcut(app, shell, binding, shortcuts::Action::PushToTalk).await
}

#[tauri::command]
async fn set_push_to_mute_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    set_shortcut(app, shell, binding, shortcuts::Action::PushToMute).await
}

#[tauri::command]
async fn set_microphone_mode(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    mode: installations::MicrophoneMode,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    let mut inner = shell.inner.lock().await;
    let needed = match mode {
        installations::MicrophoneMode::OpenMic => None,
        installations::MicrophoneMode::PushToTalk => Some(shortcuts::Action::PushToTalk),
        installations::MicrophoneMode::PushToMute => Some(shortcuts::Action::PushToMute),
    };
    if needed.is_some_and(|action| inner.shortcuts[action.index()].active.is_none()) {
        return Err("shortcut_required");
    }
    let mut next = inner.preferences.clone();
    next.microphone_mode = mode;
    persist(&shell, &next)?;
    inner.preferences = next;
    deliver_microphone_mode(&app, &inner);
    Ok(snapshot(&inner))
}

#[tauri::command]
async fn set_push_to_talk_release_delay(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    delay_ms: u16,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    if delay_ms > 2000 {
        return Err("invalid_release_delay");
    }
    let mut inner = shell.inner.lock().await;
    let mut next = inner.preferences.clone();
    next.push_to_talk_release_delay_ms = delay_ms;
    persist(&shell, &next)?;
    inner.preferences = next;
    shell
        .push_to_talk_release_delay_ms
        .store(delay_ms, Ordering::Release);
    if let Some(target) = inner.active.as_ref() {
        expire_talk_release(&app, target);
    }
    Ok(snapshot(&inner))
}

async fn set_shortcut(
    app: tauri::AppHandle,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
    action: shortcuts::Action,
) -> Result<ShellSnapshot, &'static str> {
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    let mut inner = shell.inner.lock().await;
    let mut next = inner.preferences.clone();
    next.set_binding(action, binding);
    next.validate_shortcuts()?;
    let mut registration = inner.shortcuts[action.index()].clone();
    let current = registration.active.clone();
    let saved = next.clone();
    let path = shell.data.join("installations.json");
    let native_app = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    // The plugin locks its registry while dispatching to the main thread.
    // Perform the entire change there to avoid competing hotkey callbacks.
    app.run_on_main_thread(move || {
        let result = registration.change(
            saved.binding(action),
            &mut shortcuts::NativeRegistry {
                app: &native_app,
                action,
                current,
            },
            || installations::save(&path, &saved),
        );
        let _ = send.send((registration, result));
    })
    .map_err(|_| "shortcut_failed")?;
    let (registration, result) = receive.await.map_err(|_| "shortcut_failed")?;
    shell.shortcut_latches[action.index()].bind(registration.active.as_deref());
    inner.shortcuts[action.index()] = registration;
    // A changed/cleared binding must end its hold even if no key-up follows.
    queue_voice_event(&app, action, false, false);
    result?;
    inner.preferences = next;
    Ok(snapshot(&inner))
}

fn handle_shortcut(
    app: &tauri::AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    use tauri_plugin_global_shortcut::ShortcutState;
    let Some(shell) = app.try_state::<Shell>() else {
        return;
    };
    for action in shortcuts::Action::ALL {
        let latch = &shell.shortcut_latches[action.index()];
        let pressed = event.state() == ShortcutState::Pressed;
        let changed = if pressed {
            latch.keyboard_pressed(shortcut)
        } else {
            latch.keyboard_released(shortcut)
        };
        if changed {
            queue_voice_action(app, action, pressed);
        }
    }
}

fn queue_voice_action(app: &tauri::AppHandle, action: shortcuts::Action, pressed: bool) {
    queue_voice_event(app, action, pressed, true);
}

fn queue_voice_event(
    app: &tauri::AppHandle,
    action: shortcuts::Action,
    pressed: bool,
    allow_release_delay: bool,
) {
    if let Some(shell) = app.try_state::<Shell>() {
        let _ = shell.shortcut_events.send(VoiceEvent {
            action,
            pressed,
            generation: shell.voice_generation.load(Ordering::Acquire),
            allow_release_delay,
        });
    }
}

fn active_remote(app: &tauri::AppHandle, inner: &Inner) -> Option<WebviewWindow> {
    let active = inner.active.as_ref()?;
    let remote = app.get_webview_window(platform::INSTALLATION_WINDOW)?;
    let url = remote.url().ok()?;
    installations::same_origin(&active.origin, &url).then_some(remote)
}

fn deliver_microphone_mode(app: &tauri::AppHandle, inner: &Inner) {
    if let Some(remote) = active_remote(app, inner) {
        let mode = serde_json::to_string(&inner.preferences.microphone_mode).unwrap();
        let _ = remote.eval(format!(
            "window.__VOXLY_DESKTOP_V1__?.dispatchMicrophoneMode?.({mode});"
        ));
    }
}

fn deliver_voice_action(
    app: &tauri::AppHandle,
    target: &Installation,
    action: shortcuts::Action,
    pressed: bool,
    release_delay_ms: u16,
) {
    // Releases must reach the call even when settings have since taken focus.
    if pressed
        && (app
            .get_webview_window("shell")
            .is_some_and(|window| window.is_focused().unwrap_or(true)))
    {
        return;
    }
    let Some(remote) = app.get_webview_window(platform::INSTALLATION_WINDOW) else {
        return;
    };
    let Ok(url) = remote.url() else {
        return;
    };
    if !installations::same_origin(&target.origin, &url) {
        return;
    }
    // Fixed actions and booleans, never script supplied by the installation.
    let talk_release =
        format!("window.__VOXLY_DESKTOP_V1__?.dispatchPushToTalk?.(false, {release_delay_ms});");
    let script = match (action, pressed) {
        (shortcuts::Action::Mute, true) => "window.__VOXLY_DESKTOP_V1__?.dispatchMute();",
        (shortcuts::Action::Deafen, true) => "window.__VOXLY_DESKTOP_V1__?.dispatchDeafen?.();",
        (shortcuts::Action::PushToTalk, true) => {
            "window.__VOXLY_DESKTOP_V1__?.dispatchPushToTalk?.(true);"
        }
        (shortcuts::Action::PushToTalk, false) => &talk_release,
        (shortcuts::Action::PushToMute, true) => {
            "window.__VOXLY_DESKTOP_V1__?.dispatchPushToMute?.(true);"
        }
        (shortcuts::Action::PushToMute, false) => {
            "window.__VOXLY_DESKTOP_V1__?.dispatchPushToMute?.(false);"
        }
        _ => return,
    };
    let _ = remote.eval(script);
}

fn expire_talk_release(app: &tauri::AppHandle, target: &Installation) {
    if let Some(remote) = app.get_webview_window(platform::INSTALLATION_WINDOW) {
        if remote
            .url()
            .is_ok_and(|url| installations::same_origin(&target.origin, &url))
        {
            let _ = remote.eval("window.__VOXLY_DESKTOP_V1__?.dispatchPushToTalkRelease?.();");
        }
    }
}

#[tauri::command]
async fn shell_state(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    Ok(snapshot(&*shell.inner.lock().await))
}

#[tauri::command]
async fn save_installation(
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    address: String,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let saved = installations::installation(&address)?;
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
async fn forget_installation(
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
    next.installations.retain(|entry| entry.id != id);
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
async fn connect_installation(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    id: String,
    confirm_leave: bool,
    reload: bool,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    // Serialize changes across the await: two clicks cannot create two windows.
    let mut inner = shell.inner.lock().await;
    let saved = inner
        .preferences
        .installations
        .iter()
        .find(|entry| entry.id == id)
        .cloned()
        .ok_or("installation_missing")?;
    if !reload
        && inner
            .active
            .as_ref()
            .is_some_and(|active| active.id == saved.id)
    {
        if let Some(remote) = app.get_webview_window(platform::INSTALLATION_WINDOW) {
            remote.show().map_err(|_| "window_failed")?;
            remote.set_focus().map_err(|_| "window_failed")?;
            return Ok(snapshot(&inner));
        }
    }
    if inner.active.is_some() && !confirm_leave {
        return Err("confirmation_required");
    }
    // Keep the old installation/call intact if the replacement is unreachable.
    check_health(&saved.origin).await?;
    if let Some(remote) = app.get_webview_window(platform::INSTALLATION_WINDOW) {
        remote.destroy().map_err(|_| "window_failed")?;
    }
    shell.voice_generation.fetch_add(1, Ordering::AcqRel);
    inner.active = None;
    platform::open_installation(&app, &saved, &shell.data, inner.preferences.microphone_mode)?;
    *shell.voice_target.write().map_err(|_| "window_failed")? = Some(saved.clone());
    inner.active = Some(saved);
    Ok(snapshot(&inner))
}

#[tauri::command]
async fn disconnect_installation(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    confirm_leave: bool,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let mut inner = shell.inner.lock().await;
    if inner.active.is_some() && !confirm_leave {
        return Err("confirmation_required");
    }
    if let Some(remote) = app.get_webview_window(platform::INSTALLATION_WINDOW) {
        // Destroying the webview ends its tracks, rather than hiding them.
        remote.destroy().map_err(|_| "window_failed")?;
    }
    shell.voice_generation.fetch_add(1, Ordering::AcqRel);
    *shell.voice_target.write().map_err(|_| "window_failed")? = None;
    inner.active = None;
    Ok(snapshot(&inner))
}

#[tauri::command]
async fn open_installation_browser(
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
async fn set_language(
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
async fn acknowledge_tray(
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
async fn quit_app(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    confirm_leave: bool,
) -> Result<(), &'static str> {
    trusted_shell(&window)?;
    let inner = shell.inner.lock().await;
    if inner.active.is_some() && !confirm_leave {
        return Err("confirmation_required");
    }
    if let Some(remote) = app.get_webview_window(platform::INSTALLATION_WINDOW) {
        remote.destroy().map_err(|_| "window_failed")?;
    }
    app.exit(0);
    Ok(())
}

fn show_shell(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("shell") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_current(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(platform::INSTALLATION_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        show_shell(app);
    }
}

fn update_tray_language(menu: &TrayMenu, language: Language) -> tauri::Result<()> {
    let tr = language == Language::Tr;
    menu.show
        .set_text(if tr { "Voxly’yi aç" } else { "Show Voxly" })?;
    menu.installations
        .set_text(if tr { "Kurulumlar" } else { "Installations" })?;
    menu.quit.set_text(if tr { "Çık…" } else { "Quit…" })
}

fn main() {
    tauri::Builder::default()
        // Register first, before any other plugin initializes a webview.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_current(app)
        }))
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
            shell_state,
            save_installation,
            forget_installation,
            connect_installation,
            disconnect_installation,
            open_installation_browser,
            set_language,
            acknowledge_tray,
            quit_app,
            set_mute_shortcut,
            set_deafen_shortcut,
            set_push_to_talk_shortcut,
            set_push_to_mute_shortcut,
            set_microphone_mode,
            set_push_to_talk_release_delay
        ])
        .setup(|app| {
            let data = app.path().app_local_data_dir()?;
            let preferences = installations::load(&data.join("installations.json"))
                .map_err(std::io::Error::other)?;
            let show =
                tauri::menu::MenuItem::with_id(app, "show", "Show Voxly", true, None::<&str>)?;
            let installations = tauri::menu::MenuItem::with_id(
                app,
                "installations",
                "Installations",
                true,
                None::<&str>,
            )?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit…", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &installations, &quit])?;
            let tray_menu = TrayMenu {
                show,
                installations,
                quit,
            };
            update_tray_language(&tray_menu, preferences.language)?;
            tauri::tray::TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("missing tray icon")?
                        .clone(),
                )
                .tooltip("Voxly")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_current(app),
                    "installations" => show_shell(app),
                    "quit" => {
                        show_shell(app);
                        let _ = app.emit_to("shell", "shell:quit-requested", ());
                    }
                    _ => {}
                })
                .build(app)?;
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
            let (shortcut_events, mut events) =
                tokio::sync::mpsc::unbounded_channel::<VoiceEvent>();
            let release_delay_ms = preferences.push_to_talk_release_delay_ms;
            app.manage(Shell {
                inner: Mutex::new(Inner {
                    preferences,
                    active: None,
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
            let event_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut release = None;
                while let Some(delivery) = next_voice_delivery(&mut events, &mut release).await {
                    let shell = event_app.state::<Shell>();
                    // Settings and health checks may own inner for seconds.
                    // Release delivery must never wait on that async lock.
                    let target = shell
                        .voice_target
                        .read()
                        .ok()
                        .and_then(|target| target.clone());
                    let generation = match &delivery {
                        VoiceDelivery::Input(event) => event.generation,
                        VoiceDelivery::TalkReleaseExpired(generation) => *generation,
                    };
                    if generation != shell.voice_generation.load(Ordering::Acquire) {
                        continue;
                    }
                    let Some(target) = target else {
                        continue;
                    };
                    match delivery {
                        VoiceDelivery::TalkReleaseExpired(_) => {
                            expire_talk_release(&event_app, &target)
                        }
                        VoiceDelivery::Input(event) => {
                            let mut delay_ms = 0;
                            if event.action == shortcuts::Action::PushToTalk {
                                // A fresh press replaces any pending cutoff. Binding resets bypass delay.
                                release = None;
                                if !event.pressed && event.allow_release_delay {
                                    delay_ms =
                                        shell.push_to_talk_release_delay_ms.load(Ordering::Acquire);
                                }
                            } else if event.pressed
                                && matches!(
                                    event.action,
                                    shortcuts::Action::Mute | shortcuts::Action::Deafen
                                )
                                && release.take().is_some()
                            {
                                expire_talk_release(&event_app, &target);
                            }
                            deliver_voice_action(
                                &event_app,
                                &target,
                                event.action,
                                event.pressed,
                                delay_ms,
                            );
                            if delay_ms > 0 {
                                release = Some((
                                    tokio::time::Instant::now()
                                        + std::time::Duration::from_millis(delay_ms.into()),
                                    event.generation,
                                ));
                            }
                        }
                    }
                }
            });
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .on_navigation(shell_navigation)
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_download(|_, _| false)
                    .build()?;
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if close_window.hide().is_ok() {
                        api.prevent_close();
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start Voxly desktop");
}
