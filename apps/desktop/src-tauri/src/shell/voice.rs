//! Shortcut settings and ordered native voice-intent delivery.
use super::{persist, snapshot, Inner, Shell, ShellSnapshot};
use super::installation::remote_window;
use super::settings::{trusted_settings, validate_settings_caller};
use crate::{installations, shortcuts};
use crate::installations::Installation;
use std::sync::atomic::Ordering;
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct VoiceEvent {
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

#[tauri::command]
pub(super) async fn set_mute_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    set_shortcut(app, window, shell, binding, shortcuts::Action::Mute).await
}

#[tauri::command]
pub(super) async fn set_deafen_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    set_shortcut(app, window, shell, binding, shortcuts::Action::Deafen).await
}

#[tauri::command]
pub(super) async fn set_push_to_talk_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    set_shortcut(app, window, shell, binding, shortcuts::Action::PushToTalk).await
}

#[tauri::command]
pub(super) async fn set_push_to_mute_shortcut(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    set_shortcut(app, window, shell, binding, shortcuts::Action::PushToMute).await
}

#[tauri::command]
pub(super) async fn set_microphone_mode(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    mode: installations::MicrophoneMode,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    let mut inner = shell.inner.lock().await;
    validate_settings_caller(&window, &shell, &inner)?;
    let needed = match mode {
        installations::MicrophoneMode::OpenMic => None,
        installations::MicrophoneMode::PushToTalk => Some(shortcuts::Action::PushToTalk),
        installations::MicrophoneMode::PushToMute => Some(shortcuts::Action::PushToMute),
    };
    if needed.is_some_and(|action| inner.shortcuts[action.index()].active.is_none()) {
        return Err("shortcut_required");
    }
    let mut next = inner.preferences.clone();
    next.set_microphone_mode(mode);
    persist(&shell, &next)?;
    shell
        .push_to_talk_release_delay_ms
        .store(next.push_to_talk_release_delay_ms, Ordering::Release);
    inner.preferences = next;
    deliver_microphone_mode(&app, &inner);
    Ok(snapshot(&inner))
}

#[tauri::command]
pub(super) async fn set_push_to_talk_release_delay(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    delay_ms: u16,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    if delay_ms > 2000 {
        return Err("invalid_release_delay");
    }
    let mut inner = shell.inner.lock().await;
    validate_settings_caller(&window, &shell, &inner)?;
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
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    binding: Option<String>,
    action: shortcuts::Action,
) -> Result<ShellSnapshot, &'static str> {
    if !cfg!(target_os = "windows") {
        return Err("unsupported_platform");
    }
    let mut inner = shell.inner.lock().await;
    validate_settings_caller(&window, &shell, &inner)?;
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

pub(super) fn handle_shortcut(
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

pub(crate) fn queue_voice_action(app: &tauri::AppHandle, action: shortcuts::Action, pressed: bool) {
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
    let remote = remote_window(app)?;
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
    let Some(remote) = remote_window(app) else {
        return;
    };
    let Ok(url) = remote.url() else {
        return;
    };
    if !installations::same_origin(&target.origin, &url) {
        return;
    }
    if pressed && remote.is_focused().unwrap_or(false)
        && app.state::<Shell>().recording_shortcut.load(Ordering::Acquire) { return; }
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
    if let Some(remote) = remote_window(app) {
        if remote
            .url()
            .is_ok_and(|url| installations::same_origin(&target.origin, &url))
        {
            let _ = remote.eval("window.__VOXLY_DESKTOP_V1__?.dispatchPushToTalkRelease?.();");
        }
    }
}

pub(super) fn start_delivery(
    app: &tauri::AppHandle,
    mut events: tokio::sync::mpsc::UnboundedReceiver<VoiceEvent>,
) {
    let event_app = app.clone();
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
}
