//! Desktop shell orchestration. Platform adapters remain at the crate root.
mod installation;
mod settings;
mod notification_commands;
mod runtime;
mod tray;
pub(crate) mod trust;
mod update_commands;
mod voice;

pub(crate) use update_commands::publish_update_state;
#[cfg(target_os = "windows")]
pub(crate) use voice::queue_voice_action;
use crate::{call_state, installations, shortcuts};
use crate::installations::{Installation, Preferences};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64};
use tokio::sync::Mutex;
use tray::TrayMenu;
use voice::VoiceEvent;

pub(crate) struct Shell {
    pub(crate) inner: Mutex<Inner>,
    recording_shortcut: AtomicBool,
    ready_generation: AtomicU64,
    pub(crate) reports: call_state::Reports,
    pub(crate) data: PathBuf,
    menu: TrayMenu,
    shortcut_latches: [shortcuts::ShortcutLatch; 4],
    shortcut_events: tokio::sync::mpsc::UnboundedSender<VoiceEvent>,
    pub(crate) voice_generation: AtomicU64,
    voice_target: std::sync::RwLock<Option<Installation>>,
    push_to_talk_release_delay_ms: AtomicU16,
}

pub(crate) struct Inner {
    preferences: Preferences,
    pub(crate) active: Option<Installation>,
    shortcuts: [shortcuts::Registration; 4],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShellSnapshot {
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

pub(crate) fn run() {
    runtime::run();
}
