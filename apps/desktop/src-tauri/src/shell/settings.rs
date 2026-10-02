//! Finite local preferences exposed to the current Installation, never generic IPC.
use super::trust::{report_caller_matches, trusted_shell};
use super::{persist, snapshot, Shell, ShellSnapshot};
use crate::installations;
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
    AuthenticationCompleted {},
}

#[tauri::command]
pub(super) async fn desktop_settings(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    operation: Operation,
) -> Result<ShellSnapshot, &'static str> {
    trusted_settings(&window, &shell).await?;
    match operation {
        Operation::Shortcut { action, binding } => {
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
            }
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
        Operation::AuthenticationCompleted {} => {
            // Origin comes exclusively from the locally selected, current window.
            if trusted_shell(&window).is_ok() {
                return Err("forbidden");
            }
            let active = inner.active.as_ref().ok_or("forbidden")?.clone();
            next.remember_authenticated(&active)?;
        }
        _ => return Err("forbidden"),
    }
    persist(&shell, &next)?;
    inner.preferences = next;
    let _ = app.emit_to("shell", "shell:preferences", ());
    Ok(snapshot(&inner))
}

#[cfg(test)]
mod tests {
    use super::Operation;

    #[test]
    fn settings_accept_only_finite_intents_and_never_caller_supplied_authentication_origins() {
        for value in [
            r#"{"kind":"read"}"#,
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
            r#"{"kind":"resetShortcut","action":"mute","binding":"Alt+KeyK"}"#,
            r#"{"kind":"update","endpoint":"https://evil.example"}"#,
            r#"{"kind":"rename","id":"saved","name":"Name","path":"../profile"}"#,
        ] {
            assert!(serde_json::from_str::<Operation>(value).is_err());
        }
    }
}
