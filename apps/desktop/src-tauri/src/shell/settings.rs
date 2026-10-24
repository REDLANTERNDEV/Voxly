//! Finite local preferences exposed to the current Installation, never generic IPC.
use super::trust::{report_caller_matches, trusted_shell};
use super::{for_remote, persist, snapshot, Shell, ShellSnapshot};
use crate::installations::{self, Installation};
use serde::Deserialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewWindow};

pub(super) async fn trusted_settings(
    window: &WebviewWindow,
    shell: &Shell,
) -> Result<(), &'static str> {
    if trusted_shell(window).is_ok() {
        return Ok(());
    }
    let inner = shell.inner.lock().await;
    validate_settings_caller(window, shell, &inner)
}

pub(super) fn validate_settings_caller(
    window: &WebviewWindow,
    shell: &Shell,
    inner: &super::Inner,
) -> Result<(), &'static str> {
    if trusted_shell(window).is_ok() {
        return Ok(());
    }
    let active = inner.active.as_ref().ok_or("forbidden")?;
    if report_caller_matches(
        shell.voice_generation.load(Ordering::Acquire),
        window.label(),
        &active.origin,
        &window.url().map_err(|_| "forbidden")?,
    ) {
        Ok(())
    } else {
        Err("forbidden")
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Operation {
    Read {},
    Ready {},
    Recording {
        enabled: bool,
    },
    Home {},
    Default {
        id: Option<String>,
        enabled: bool,
    },
    Rename {
        id: String,
        name: String,
    },
    Display {
        display: installations::DisplayPreferences,
    },
    Shortcut {
        action: String,
        binding: Option<String>,
    },
    ResetShortcut {
        action: String,
    },
    Microphone {
        mode: installations::MicrophoneMode,
    },
    Delay {
        milliseconds: u16,
    },
    QuitOnClose {
        enabled: bool,
    },
    AuthenticationCompleted {},
}

/// A shortcut the remote Installation asked for, held to the chord the native
/// hook saw the person press while it recorded. The page may start and stop
/// recording but cannot name keys of its own (ADR-0020), or it could watch any
/// key system-wide. Clearing a binding needs no evidence.
fn authorize_remote_binding(
    binding: Option<String>,
    pressed: Option<std::collections::BTreeSet<u16>>,
) -> Result<Option<String>, &'static str> {
    let Some(binding) = binding else {
        return Ok(None);
    };
    let parsed = crate::input_bindings::parse_physical(&binding)?;
    match pressed {
        Some(chord) if crate::input_bindings::matches_observed(&parsed, &chord) => {
            Ok(Some(binding))
        }
        _ => Err("shortcut_unobserved"),
    }
}

/// The chord the native hook captured for the remote Installation's recording,
/// taken so it cannot be committed twice. Shortcuts exist only on Windows.
fn recorded_chord() -> Option<std::collections::BTreeSet<u16>> {
    #[cfg(target_os = "windows")]
    {
        crate::mouse_hook::take_capture()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Drops any capture in progress: the window it belonged to is gone or reset.
pub(super) fn discard_shortcut_capture() {
    #[cfg(target_os = "windows")]
    let _ = crate::mouse_hook::take_capture();
}

/// Drops the remote window's capture and any request it left for the member
/// to answer: neither may outlive the page that made it.
pub(super) fn discard_remote_shortcuts(shell: &Shell) {
    if let Ok(mut remote) = shell.remote_shortcuts.lock() {
        remote.discard();
    }
    discard_shortcut_capture();
}

/// Holds a remote shortcut change for the member to confirm in the Home shell.
/// The page asked; nothing is saved until the local Confirm (ADR-0020).
async fn request_remote_shortcut(
    app: &tauri::AppHandle,
    shell: &Shell,
    action: &str,
    binding: Option<String>,
) -> Result<ShellSnapshot, &'static str> {
    let action = super::remote_shortcuts::parse_action(action)?;
    let origin = {
        let inner = shell.inner.lock().await;
        inner.active.as_ref().ok_or("forbidden")?.origin.clone()
    };
    let request = shell
        .remote_shortcuts
        .lock()
        .map_err(|_| "shortcut_failed")?
        .propose(
            action,
            binding,
            origin,
            shell.voice_generation.load(Ordering::Acquire),
        );
    super::tray::show_shell(app);
    let _ = app.emit_to("shell", "shell:shortcut-request", &request);
    Err("shortcut_pending")
}

/// The Home shell's answer to a remote shortcut request. Only an accepted,
/// current request is saved, and with the binding native code held, not one
/// the answer names.
#[tauri::command]
pub(super) async fn answer_shortcut_request(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    id: u64,
    accept: bool,
) -> Result<ShellSnapshot, &'static str> {
    trusted_shell(&window)?;
    let request = shell
        .remote_shortcuts
        .lock()
        .map_err(|_| "shortcut_failed")?
        .answer(id, shell.voice_generation.load(Ordering::Acquire));
    let result = match request {
        Some(request) if accept => {
            super::voice::set_shortcut(app.clone(), window, shell, request.binding, request.action)
                .await
        }
        _ => Ok(snapshot(&*shell.inner.lock().await)),
    };
    // Back to the page that asked; it re-reads its settings when focused.
    if let Some(remote) = super::installation::remote_window(&app) {
        let _ = remote.show();
        let _ = remote.set_focus();
    }
    result
}

/// Which operations the Installation in the remote window may ask for. Which
/// Installations exist, what they are called and which opens at startup are
/// the local shell's to change (ADR-0023); the page only reaches its own call
/// settings.
fn remote_permits(operation: &Operation) -> bool {
    !matches!(
        operation,
        Operation::Default { .. } | Operation::Rename { .. } | Operation::Display { .. }
    )
}

#[tauri::command]
pub(super) async fn desktop_settings(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    operation: Operation,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    let remote = trusted_shell(&window).is_err();
    if remote && !remote_permits(&operation) {
        return Err("forbidden");
    }
    let result = apply(app, window, shell, operation).await;
    if remote {
        result.map(for_remote)
    } else {
        result
    }
}

async fn apply(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    operation: Operation,
) -> Result<ShellSnapshot, &'static str> {
    match operation {
        Operation::Shortcut { action, binding } => {
            if trusted_shell(&window).is_err() {
                // The F(c) chord check stays: the member is only ever asked
                // about keys they actually pressed while recording.
                let binding = authorize_remote_binding(binding, recorded_chord())?;
                return request_remote_shortcut(&app, &shell, &action, binding).await;
            }
            return match action.as_str() {
                "mute" => super::voice::set_mute_shortcut(app, window, shell, binding).await,
                "deafen" => super::voice::set_deafen_shortcut(app, window, shell, binding).await,
                "pushToTalk" => {
                    super::voice::set_push_to_talk_shortcut(app, window, shell, binding).await
                }
                "pushToMute" => {
                    super::voice::set_push_to_mute_shortcut(app, window, shell, binding).await
                }
                _ => Err("shortcut_invalid"),
            };
        }
        Operation::ResetShortcut { action } => {
            let action = match action.as_str() {
                "mute" => crate::shortcuts::Action::Mute,
                "deafen" => crate::shortcuts::Action::Deafen,
                "pushToTalk" => crate::shortcuts::Action::PushToTalk,
                "pushToMute" => crate::shortcuts::Action::PushToMute,
                _ => return Err("shortcut_invalid"),
            };
            return super::voice::reset_shortcut(app, window, shell, action).await;
        }
        Operation::Microphone { mode } => {
            return super::voice::set_microphone_mode(app, window, shell, mode).await
        }
        Operation::Delay { milliseconds } => {
            return super::voice::set_push_to_talk_release_delay(app, window, shell, milliseconds)
                .await
        }
        _ => {}
    }
    let mut inner = shell.inner.lock().await;
    // Revalidate after acquiring the mutation lease: a window replacement may have raced it.
    if trusted_shell(&window).is_err() {
        let active = inner.active.as_ref().ok_or("forbidden")?;
        if !report_caller_matches(
            shell.voice_generation.load(Ordering::Acquire),
            window.label(),
            &active.origin,
            &window.url().map_err(|_| "forbidden")?,
        ) {
            return Err("forbidden");
        }
    }
    let mut next = inner.preferences.clone();
    match operation {
        Operation::Read {} => return Ok(snapshot(&inner)),
        Operation::Ready {} => {
            if trusted_shell(&window).is_ok() {
                return Err("forbidden");
            }
            if inner.loading
                && inner.loading_attempt != shell.launch_sequence.load(Ordering::Acquire)
            {
                return Err("connection_cancelled");
            }
            if shell.ready_generation.load(Ordering::Acquire)
                == shell.voice_generation.load(Ordering::Acquire)
            {
                return Ok(snapshot(&inner));
            }
            shell.recording_shortcut.store(false, Ordering::Release);
            discard_remote_shortcuts(&shell);
            shell.ready_generation.store(
                shell.voice_generation.load(Ordering::Acquire),
                Ordering::Release,
            );
            inner.loading = false;
            if !shell.home_requested.load(Ordering::Acquire) {
                window.show().map_err(|_| "window_failed")?;
                window.set_focus().map_err(|_| "window_failed")?;
                if let Some(home) = app.get_webview_window("shell") {
                    let _ = home.hide();
                }
            }
            let _ = app.emit_to("shell", "shell:ready", &snapshot(&inner));
            return Ok(snapshot(&inner));
        }
        Operation::Recording { enabled } => {
            shell.recording_shortcut.store(enabled, Ordering::Release);
            if enabled {
                super::voice::release_shortcut_holds(&app);
            }
            if trusted_shell(&window).is_err() {
                expire_remote_recording(&app, &shell, enabled)?;
            }
            // The page's own key events are its word; the hook's are the
            // person's. Recording from the remote page captures the latter.
            #[cfg(target_os = "windows")]
            if trusted_shell(&window).is_err() {
                if enabled {
                    crate::mouse_hook::begin_capture(&app)?;
                } else {
                    crate::mouse_hook::pause_capture();
                }
            }
            return Ok(snapshot(&inner));
        }
        Operation::Home {} => {
            super::tray::show_shell(&app);
            return Ok(snapshot(&inner));
        }
        Operation::Default { id, enabled } => {
            next.select_default(id, enabled)?;
        }
        Operation::Rename { id, name } => {
            installations::validate_name(Some(&name))?;
            let entry = next
                .installations
                .iter_mut()
                .find(|entry| entry.id == id)
                .ok_or("installation_missing")?;
            entry.name = if name.trim().is_empty() {
                None
            } else {
                Some(name.trim().to_string())
            };
        }
        Operation::Display { display } => next.display = display,
        Operation::QuitOnClose { enabled } => next.quit_on_close = enabled,
        Operation::AuthenticationCompleted {} => {
            // Origin comes exclusively from the locally selected, current window.
            if trusted_shell(&window).is_ok() {
                return Err("forbidden");
            }
            let active = authentication_target(inner.active.as_ref(), inner.active_chosen_locally)?;
            next.remember_authenticated(&active)?;
        }
        _ => return Err("forbidden"),
    }
    persist(&shell, &next)?;
    shell
        .quit_on_close
        .store(next.quit_on_close, Ordering::Release);
    inner.preferences = next;
    let _ = app.emit_to("shell", "shell:preferences", ());
    Ok(snapshot(&inner))
}

/// A recording the page started ends by itself, without saving, once
/// `RECORDING_LIMIT` passes: the page cannot leave capture running behind the
/// member's typing.
fn expire_remote_recording(
    app: &tauri::AppHandle,
    shell: &Shell,
    enabled: bool,
) -> Result<(), &'static str> {
    let mut remote = shell
        .remote_shortcuts
        .lock()
        .map_err(|_| "shortcut_failed")?;
    if !enabled {
        remote.end_recording();
        return Ok(());
    }
    let recording = remote.begin_recording();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(super::remote_shortcuts::RECORDING_LIMIT).await;
        let shell = app.state::<Shell>();
        let expired = shell
            .remote_shortcuts
            .lock()
            .map(|mut remote| remote.expire_recording(recording))
            .unwrap_or(false);
        if expired {
            shell.recording_shortcut.store(false, Ordering::Release);
            discard_shortcut_capture();
        }
    });
    Ok(())
}

/// The Installation a completed sign-in may remember: the active one, and only
/// when the member opened it themselves. A `voxly://` link to an unsaved
/// address can come from any web page, so the page it loads may not save
/// itself as the startup Installation (ADR-0027).
fn authentication_target(
    active: Option<&Installation>,
    chosen_locally: bool,
) -> Result<Installation, &'static str> {
    match active {
        Some(active) if chosen_locally => Ok(active.clone()),
        _ => Err("forbidden"),
    }
}

#[cfg(test)]
mod tests {
    use super::{authentication_target, authorize_remote_binding, remote_permits, Operation};

    #[test]
    fn an_installation_can_bind_only_keys_the_person_pressed_while_recording() {
        let pressed = |keys: &[u16]| {
            Some(
                keys.iter()
                    .copied()
                    .collect::<std::collections::BTreeSet<u16>>(),
            )
        };
        assert_eq!(
            authorize_remote_binding(Some("ControlLeft+KeyM".into()), pressed(&[0x1d, 0x32])),
            Ok(Some("ControlLeft+KeyM".into()))
        );
        // Named by the page with no recording, or not what was pressed.
        assert_eq!(
            authorize_remote_binding(Some("KeyA".into()), None),
            Err("shortcut_unobserved")
        );
        assert_eq!(
            authorize_remote_binding(Some("Control+KeyC".into()), pressed(&[0x1d, 0x32])),
            Err("shortcut_unobserved")
        );
        // Clearing a binding takes nothing away from the person.
        assert_eq!(authorize_remote_binding(None, None), Ok(None));
        assert_eq!(
            authorize_remote_binding(Some("NotAKey".into()), pressed(&[0x1d])),
            Err("shortcut_invalid")
        );
    }
    use crate::installations::{installation, Preferences};

    #[test]
    fn an_installation_sees_only_its_own_call_settings() {
        // The member's other Installations are other operators' servers; the
        // page loaded in this window has no business knowing or renaming them.
        let mut preferences = Preferences::default();
        preferences.installations = vec![
            installation("https://chat.example.com").unwrap(),
            installation("https://other.example.org").unwrap(),
        ];
        preferences.default_installation_id = Some(preferences.installations[1].id.clone());
        preferences.open_on_startup = true;
        preferences.quit_on_close = true;
        preferences.mute_shortcut = Some("ControlLeft+KeyM".into());
        let remote = super::super::for_remote(super::super::ShellSnapshot::for_test(preferences));
        let json = serde_json::to_value(&remote).unwrap();
        assert_eq!(json["preferences"]["installations"], serde_json::json!([]));
        assert_eq!(
            json["preferences"]["defaultInstallationId"],
            serde_json::Value::Null
        );
        assert_eq!(
            json["preferences"]["openOnStartup"],
            serde_json::json!(false)
        );
        assert_eq!(json["preferences"]["quitOnClose"], serde_json::json!(true));
        assert_eq!(
            json["preferences"]["muteShortcut"],
            serde_json::json!("ControlLeft+KeyM")
        );
    }

    #[test]
    fn an_installation_cannot_change_which_installations_exist_or_open() {
        for value in [
            r#"{"kind":"default","id":null,"enabled":false}"#,
            r#"{"kind":"rename","id":"saved","name":"Name"}"#,
        ] {
            assert!(!remote_permits(
                &serde_json::from_str::<Operation>(value).unwrap()
            ));
        }
        for value in [
            r#"{"kind":"read"}"#,
            r#"{"kind":"ready"}"#,
            r#"{"kind":"recording","enabled":true}"#,
            r#"{"kind":"home"}"#,
            r#"{"kind":"quitOnClose","enabled":true}"#,
            r#"{"kind":"microphone","mode":"pushToTalk"}"#,
            r#"{"kind":"delay","milliseconds":200}"#,
            r#"{"kind":"shortcut","action":"mute","binding":null}"#,
            r#"{"kind":"resetShortcut","action":"mute"}"#,
            r#"{"kind":"authenticationCompleted"}"#,
        ] {
            assert!(
                remote_permits(&serde_json::from_str::<Operation>(value).unwrap()),
                "{value}"
            );
        }
    }

    #[test]
    fn authentication_is_remembered_only_for_an_address_chosen_locally() {
        let active = installation("https://chat.example.com").unwrap();
        assert_eq!(
            authentication_target(Some(&active), true).map(|entry| entry.origin),
            Ok(active.origin.clone())
        );
        // A deep link opened without the local Open action.
        assert_eq!(
            authentication_target(Some(&active), false),
            Err("forbidden")
        );
        assert_eq!(authentication_target(None, true), Err("forbidden"));
    }

    #[test]
    fn settings_accept_only_finite_intents_and_never_caller_supplied_authentication_origins() {
        for value in [
            r#"{"kind":"read"}"#,
            r#"{"kind":"quitOnClose","enabled":true}"#,
            r#"{"kind":"resetShortcut","action":"mute"}"#,
            r#"{"kind":"home"}"#,
            r#"{"kind":"authenticationCompleted"}"#,
            r#"{"kind":"microphone","mode":"pushToTalk"}"#,
            r#"{"kind":"default","id":null,"enabled":false}"#,
        ] {
            assert!(serde_json::from_str::<Operation>(value).is_ok());
        }
        for value in [
            r#"{"kind":"authenticationCompleted","origin":"https://evil.example"}"#,
            r#"{"kind":"microphone","mode":"anything"}"#,
            r#"{"kind":"execute","command":"anything"}"#,
            r#"{"kind":"quitOnClose","enabled":"true"}"#,
            r#"{"kind":"quitOnClose","enabled":true,"origin":"https://evil.example"}"#,
            r#"{"kind":"resetShortcut","action":"mute","binding":"Alt+KeyK"}"#,
            r#"{"kind":"update","endpoint":"https://evil.example"}"#,
            r#"{"kind":"rename","id":"saved","name":"Name","path":"../profile"}"#,
        ] {
            assert!(serde_json::from_str::<Operation>(value).is_err());
        }
    }
}
