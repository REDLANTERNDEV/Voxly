use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use url::Url;

pub const INSTALLATION_LIMIT: usize = 32;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Installation {
    pub id: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub installations: Vec<Installation>,
    #[serde(default)]
    pub default_installation_id: Option<String>,
    #[serde(default)]
    pub open_on_startup: bool,
    #[serde(default)]
    pub quit_on_close: bool,
    #[serde(default)]
    pub display: DisplayPreferences,
    pub language: Language,
    pub tray_acknowledged: bool,
    #[serde(default)]
    pub mute_shortcut: Option<String>,
    #[serde(default)]
    pub deafen_shortcut: Option<String>,
    #[serde(default)]
    pub push_to_talk_shortcut: Option<String>,
    #[serde(default)]
    pub push_to_mute_shortcut: Option<String>,
    #[serde(default)]
    pub microphone_mode: MicrophoneMode,
    #[serde(default)]
    pub push_to_talk_release_delay_ms: u16,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayPreferences {
    pub full_addresses: bool,
    pub compact_list: bool,
    pub installation_icons: bool,
}
impl Default for DisplayPreferences {
    fn default() -> Self {
        Self {
            full_addresses: true,
            compact_list: false,
            installation_icons: true,
        }
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MicrophoneMode {
    #[default]
    OpenMic,
    PushToTalk,
    PushToMute,
}

impl Preferences {
    pub fn remember_authenticated(&mut self, active: &Installation) -> Result<(), &'static str> {
        if !self.installations.iter().any(|entry| entry.id == active.id) {
            if self.installations.len() >= INSTALLATION_LIMIT {
                return Err("installation_limit");
            }
            self.installations.push(active.clone());
        }
        self.default_installation_id = Some(active.id.clone());
        self.open_on_startup = true;
        Ok(())
    }

    pub fn select_default(
        &mut self,
        id: Option<String>,
        enabled: bool,
    ) -> Result<(), &'static str> {
        if id
            .as_ref()
            .is_some_and(|id| !self.installations.iter().any(|entry| &entry.id == id))
        {
            return Err("installation_missing");
        }
        self.open_on_startup = enabled && id.is_some();
        self.default_installation_id = id;
        Ok(())
    }

    pub fn forget(&mut self, id: &str) {
        self.installations.retain(|entry| entry.id != id);
        if self.default_installation_id.as_deref() == Some(id) {
            self.default_installation_id = None;
            self.open_on_startup = false;
        }
    }

    pub fn set_microphone_mode(&mut self, mode: MicrophoneMode) {
        if mode == MicrophoneMode::PushToTalk
            && self.microphone_mode != mode
            && self.push_to_talk_release_delay_ms == 0
        {
            self.push_to_talk_release_delay_ms = 200;
        }
        self.microphone_mode = mode;
    }

    pub fn binding(&self, action: crate::shortcuts::Action) -> Option<&str> {
        use crate::shortcuts::Action;
        match action {
            Action::Mute => self.mute_shortcut.as_deref(),
            Action::Deafen => self.deafen_shortcut.as_deref(),
            Action::PushToTalk => self.push_to_talk_shortcut.as_deref(),
            Action::PushToMute => self.push_to_mute_shortcut.as_deref(),
        }
    }

    pub fn set_binding(&mut self, action: crate::shortcuts::Action, binding: Option<String>) {
        use crate::shortcuts::Action;
        match action {
            Action::Mute => self.mute_shortcut = binding,
            Action::Deafen => self.deafen_shortcut = binding,
            Action::PushToTalk => self.push_to_talk_shortcut = binding,
            Action::PushToMute => self.push_to_mute_shortcut = binding,
        }
    }

    pub fn reset_shortcut(&mut self, action: crate::shortcuts::Action) -> Result<(), &'static str> {
        use crate::shortcuts::Action;
        if matches!(
            (self.microphone_mode, action),
            (MicrophoneMode::PushToTalk, Action::PushToTalk)
                | (MicrophoneMode::PushToMute, Action::PushToMute)
        ) {
            return Err("shortcut_required");
        }
        self.set_binding(action, action.default_binding().map(str::to_owned));
        self.validate_shortcuts()
    }

    pub fn validate_shortcuts(&self) -> Result<(), &'static str> {
        if self.push_to_talk_release_delay_ms > 2000 {
            return Err("invalid_release_delay");
        }
        let bindings = crate::shortcuts::Action::ALL.map(|action| self.binding(action));
        for binding in bindings.into_iter().flatten() {
            crate::shortcuts::parse_binding(binding)?;
        }
        crate::shortcuts::distinct_shortcuts(bindings)
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    En,
    Tr,
}

pub fn normalize_origin(input: &str) -> Result<String, &'static str> {
    let input = input.trim();
    if input.len() > 2048 || input.contains('\\') || input.chars().any(char::is_control) {
        return Err("invalid_address");
    }
    let url = Url::parse(input).map_err(|_| "invalid_address")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("invalid_address");
    }
    let host = url.host_str().unwrap_or_default();
    if matches!(host, "tauri.localhost" | "ipc.localhost") {
        return Err("invalid_address");
    }
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("https_required");
    }
    Ok(url.origin().ascii_serialization())
}

pub fn installation(input: &str) -> Result<Installation, &'static str> {
    let origin = normalize_origin(input)?;
    let id = format!("{:x}", Sha256::digest(origin.as_bytes()));
    Ok(Installation {
        id,
        origin,
        name: None,
    })
}

pub fn same_origin(origin: &str, candidate: &Url) -> bool {
    candidate.username().is_empty()
        && candidate.password().is_none()
        && candidate.origin().ascii_serialization() == origin
}

// The OS opener must never receive a file, custom protocol, or credential URL.
pub fn browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && !matches!(url.host_str(), Some("tauri.localhost" | "ipc.localhost"))
}

pub fn load(path: &Path) -> Result<Preferences, &'static str> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut preferences = Preferences::default();
            for action in crate::shortcuts::Action::ALL {
                preferences.set_binding(action, action.default_binding().map(str::to_owned));
            }
            return Ok(preferences);
        }
        Err(_) => return Err("storage_failed"),
    };
    if bytes.len() > 128 * 1024 {
        return Err("storage_failed");
    }
    let preferences: Preferences = serde_json::from_slice(&bytes).map_err(|_| "storage_failed")?;
    preferences
        .validate_shortcuts()
        .map_err(|_| "storage_failed")?;
    if preferences.installations.len() > INSTALLATION_LIMIT {
        return Err("storage_failed");
    }
    let mut seen = std::collections::HashSet::new();
    for saved in &preferences.installations {
        let canonical = installation(&saved.origin).map_err(|_| "storage_failed")?;
        if canonical.id != saved.id
            || canonical.origin != saved.origin
            || validate_name(saved.name.as_deref()).is_err()
            || !seen.insert(&saved.id)
        {
            return Err("storage_failed");
        }
    }
    if preferences
        .default_installation_id
        .as_ref()
        .is_some_and(|id| !seen.contains(id))
    {
        return Err("storage_failed");
    }
    Ok(preferences)
}

pub fn validate_name(name: Option<&str>) -> Result<(), &'static str> {
    if name.is_some_and(|name| name.chars().count() > 80 || name.chars().any(char::is_control)) {
        return Err("invalid_name");
    }
    Ok(())
}

pub fn save(path: &Path, preferences: &Preferences) -> Result<(), &'static str> {
    let parent = path.parent().ok_or("storage_failed")?;
    fs::create_dir_all(parent).map_err(|_| "storage_failed")?;
    let bytes = serde_json::to_vec_pretty(preferences).map_err(|_| "storage_failed")?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|_| "storage_failed")?;
    fs::rename(temporary, path).map_err(|_| "storage_failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_preference_defaults_off_and_persists_both_choices() {
        let old: Preferences =
            serde_json::from_str(r#"{"installations":[],"language":"en","trayAcknowledged":true}"#)
                .unwrap();
        assert!(!old.quit_on_close);
        let directory = TestDirectory::new();
        let path = directory.0.join("installations.json");
        fs::create_dir_all(&directory.0).unwrap();
        fs::write(
            &path,
            r#"{"installations":[],"language":"en","trayAcknowledged":true}"#,
        )
        .unwrap();
        assert!(!load(&path).unwrap().quit_on_close);
        for enabled in [true, false] {
            let preferences = Preferences {
                quit_on_close: enabled,
                ..old.clone()
            };
            save(&path, &preferences).unwrap();
            assert_eq!(load(&path).unwrap().quit_on_close, enabled);
        }
    }

    #[test]
    fn removing_default_preserves_saved_address_and_profile() {
        let mut preferences = Preferences::default();
        let active = installation("https://chat.example").unwrap();
        preferences.remember_authenticated(&active).unwrap();
        let before = preferences.installations.clone();
        preferences.select_default(None, true).unwrap();
        assert!(preferences.default_installation_id.is_none());
        assert!(!preferences.open_on_startup);
        assert_eq!(preferences.installations[0].id, before[0].id);
        assert_eq!(preferences.installations[0].origin, before[0].origin);
        assert_eq!(
            preferences.select_default(Some("missing".into()), true),
            Err("installation_missing")
        );
    }

    #[test]
    fn resets_use_native_defaults_and_preserve_required_hold_modes() {
        use crate::shortcuts::Action;
        let mut preferences = Preferences {
            mute_shortcut: Some("Alt+KeyK".into()),
            ..Preferences::default()
        };
        preferences.reset_shortcut(Action::Mute).unwrap();
        assert_eq!(
            preferences.mute_shortcut.as_deref(),
            Some("Control+Shift+KeyM")
        );
        preferences.reset_shortcut(Action::Deafen).unwrap();
        assert_eq!(
            preferences.deafen_shortcut.as_deref(),
            Some("Control+Shift+KeyD")
        );
        preferences.push_to_talk_shortcut = Some("Mouse4".into());
        preferences.microphone_mode = MicrophoneMode::PushToTalk;
        assert_eq!(
            preferences.reset_shortcut(Action::PushToTalk),
            Err("shortcut_required")
        );
        assert_eq!(preferences.push_to_talk_shortcut.as_deref(), Some("Mouse4"));
        assert!(preferences.microphone_mode == MicrophoneMode::PushToTalk);
        preferences.microphone_mode = MicrophoneMode::OpenMic;
        preferences.reset_shortcut(Action::PushToTalk).unwrap();
        assert!(preferences.push_to_talk_shortcut.is_none());
        preferences.push_to_mute_shortcut = Some("Mouse5".into());
        preferences.microphone_mode = MicrophoneMode::PushToMute;
        assert_eq!(
            preferences.reset_shortcut(Action::PushToMute),
            Err("shortcut_required")
        );
        assert_eq!(preferences.push_to_mute_shortcut.as_deref(), Some("Mouse5"));
        preferences.microphone_mode = MicrophoneMode::OpenMic;
        preferences.reset_shortcut(Action::PushToMute).unwrap();
        assert!(preferences.push_to_mute_shortcut.is_none());
    }

    #[test]
    fn fresh_profiles_receive_discord_defaults_but_existing_cleared_bindings_stay_cleared() {
        let directory = TestDirectory::new();
        let path = directory.0.join("installations.json");
        let fresh = load(&path).unwrap();
        assert_eq!(fresh.mute_shortcut.as_deref(), Some("Control+Shift+KeyM"));
        assert_eq!(fresh.deafen_shortcut.as_deref(), Some("Control+Shift+KeyD"));
        assert!(fresh.push_to_talk_shortcut.is_none() && fresh.push_to_mute_shortcut.is_none());
        save(&path, &Preferences::default()).unwrap();
        let existing = load(&path).unwrap();
        assert!(existing.mute_shortcut.is_none() && existing.deafen_shortcut.is_none());
        assert!(
            existing.display.full_addresses
                && existing.display.installation_icons
                && !existing.display.compact_list
        );
    }

    #[test]
    fn latest_authentication_selects_default_and_forgetting_it_disables_startup() {
        let mut preferences = Preferences::default();
        let first = installation("https://first.example").unwrap();
        let last = installation("https://last.example").unwrap();
        preferences.remember_authenticated(&first).unwrap();
        preferences.remember_authenticated(&last).unwrap();
        preferences.remember_authenticated(&last).unwrap();
        assert_eq!(preferences.installations.len(), 2);
        assert_eq!(
            preferences.default_installation_id.as_deref(),
            Some(last.id.as_str())
        );
        assert!(preferences.open_on_startup);
        preferences.forget(&first.id);
        assert!(preferences.open_on_startup);
        preferences.forget(&last.id);
        assert!(preferences.default_installation_id.is_none() && !preferences.open_on_startup);
    }

    #[test]
    fn names_and_display_preferences_preserve_origin_profile_identity_and_validate_saved_defaults()
    {
        let directory = TestDirectory::new();
        let path = directory.0.join("installations.json");
        let original = installation("https://chat.example").unwrap();
        let mut named = original.clone();
        named.name = Some("Arkadaşlar".into());
        let mut preferences = Preferences::default();
        preferences.remember_authenticated(&named).unwrap();
        preferences.display.full_addresses = false;
        preferences.display.compact_list = true;
        save(&path, &preferences).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.installations[0].id, original.id);
        assert_eq!(loaded.installations[0].name.as_deref(), Some("Arkadaşlar"));
        assert!(!loaded.display.full_addresses && loaded.display.compact_list);
        preferences.default_installation_id = Some("missing".into());
        save(&path, &preferences).unwrap();
        assert!(load(&path).is_err());
        preferences.default_installation_id = None;
        preferences.installations.push(named);
        save(&path, &preferences).unwrap();
        assert!(load(&path).is_err());
        assert!(validate_name(Some(&"a".repeat(81))).is_err());
        assert!(validate_name(Some("bad\nname")).is_err());
    }

    #[test]
    fn selecting_push_to_talk_enables_release_delay() {
        let mut preferences = Preferences::default();
        preferences.set_microphone_mode(MicrophoneMode::PushToTalk);
        assert_eq!(preferences.push_to_talk_release_delay_ms, 200);
        preferences.push_to_talk_release_delay_ms = 500;
        preferences.set_microphone_mode(MicrophoneMode::OpenMic);
        preferences.set_microphone_mode(MicrophoneMode::PushToTalk);
        assert_eq!(preferences.push_to_talk_release_delay_ms, 500);
        preferences.push_to_talk_release_delay_ms = 0;
        preferences.set_microphone_mode(MicrophoneMode::PushToTalk);
        assert_eq!(preferences.push_to_talk_release_delay_ms, 0);
        preferences.set_microphone_mode(MicrophoneMode::PushToMute);
        preferences.set_microphone_mode(MicrophoneMode::PushToTalk);
        assert_eq!(preferences.push_to_talk_release_delay_ms, 200);
    }

    struct TestDirectory(std::path::PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(std::env::temp_dir().join(format!(
                "voxly-desktop-preferences-{}-{nonce}",
                std::process::id()
            )))
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn preferences_persist_and_corrupt_or_tampered_data_is_not_replaced() {
        let directory = TestDirectory::new();
        let path = directory.0.join("installations.json");
        assert!(load(&path).unwrap().installations.is_empty());
        let mut preferences = Preferences {
            installations: vec![installation("https://chat.example").unwrap()],
            language: Language::Tr,
            tray_acknowledged: true,
            mute_shortcut: Some("Control+Shift+KeyM".into()),
            deafen_shortcut: Some("Control+Shift+KeyD".into()),
            push_to_talk_shortcut: Some("Mouse4".into()),
            push_to_mute_shortcut: Some("Mouse5".into()),
            microphone_mode: MicrophoneMode::PushToTalk,
            push_to_talk_release_delay_ms: 200,
            ..Preferences::default()
        };
        save(&path, &preferences).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.installations, preferences.installations);
        assert!(loaded.language == Language::Tr && loaded.tray_acknowledged);
        assert_eq!(loaded.mute_shortcut, preferences.mute_shortcut);
        assert_eq!(loaded.deafen_shortcut, preferences.deafen_shortcut);
        assert_eq!(
            loaded.push_to_talk_shortcut,
            preferences.push_to_talk_shortcut
        );
        assert_eq!(
            loaded.push_to_mute_shortcut,
            preferences.push_to_mute_shortcut
        );
        assert_eq!(loaded.microphone_mode, preferences.microphone_mode);
        assert_eq!(loaded.push_to_talk_release_delay_ms, 200);
        preferences
            .installations
            .push(installation("https://other.example").unwrap());
        save(&path, &preferences).unwrap();
        assert_eq!(load(&path).unwrap().installations.len(), 2);
        preferences.installations[0].id = "../shell".into();
        save(&path, &preferences).unwrap();
        assert!(load(&path).is_err());
        fs::write(&path, b"invalid-json").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid-json");
    }

    #[test]
    fn old_preferences_load_without_enabling_a_shortcut() {
        let preferences: Preferences =
            serde_json::from_str(r#"{"installations":[],"language":"en","trayAcknowledged":true}"#)
                .unwrap();
        assert!(preferences.mute_shortcut.is_none());
        assert!(preferences.deafen_shortcut.is_none());
        assert!(preferences.push_to_talk_shortcut.is_none());
        assert!(preferences.push_to_mute_shortcut.is_none());
        assert_eq!(preferences.microphone_mode, MicrophoneMode::OpenMic);
        let preferences: Preferences = serde_json::from_str(
            r#"{"installations":[],"language":"en","trayAcknowledged":true,"muteShortcut":"Mouse5"}"#
        ).unwrap();
        assert_eq!(preferences.mute_shortcut.as_deref(), Some("Mouse5"));
        assert!(preferences.deafen_shortcut.is_none());
        assert!(preferences.push_to_talk_shortcut.is_none());
        assert!(preferences.push_to_mute_shortcut.is_none());
        assert_eq!(preferences.microphone_mode, MicrophoneMode::OpenMic);
        assert_eq!(preferences.push_to_talk_release_delay_ms, 0);
    }

    #[test]
    fn release_delay_is_bounded_to_two_seconds() {
        for delay in [0, 200, 2000] {
            let preferences = Preferences {
                push_to_talk_release_delay_ms: delay,
                ..Preferences::default()
            };
            assert!(preferences.validate_shortcuts().is_ok());
        }
        let preferences = Preferences {
            push_to_talk_release_delay_ms: 2001,
            ..Preferences::default()
        };
        assert_eq!(
            preferences.validate_shortcuts(),
            Err("invalid_release_delay")
        );
    }

    #[test]
    fn accepts_canonical_https_and_only_loopback_http() {
        assert_eq!(
            normalize_origin(" HTTPS://Voxly.Example:443/ "),
            Ok("https://voxly.example".into())
        );
        for origin in [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(normalize_origin(origin).is_ok(), "{origin}");
        }
        for origin in [
            "http://192.168.1.1",
            "http://localhost.example",
            "http://127.0.0.2",
            "file:///tmp/a",
            "javascript:alert(1)",
        ] {
            assert!(normalize_origin(origin).is_err(), "{origin}");
        }
    }

    #[test]
    fn refuses_credentials_routes_tokens_and_local_shell_aliases() {
        for origin in [
            "https://a:b@voxly.example",
            "https://voxly.example/invite/token",
            "https://voxly.example/?token=a",
            "https://voxly.example/#token",
            "https://tauri.localhost",
            "https://ipc.localhost",
            "https://voxly.example\\evil",
            "https://voxly.ex\nample/",
        ] {
            assert!(normalize_origin(origin).is_err(), "{origin}");
        }
    }

    #[test]
    fn profiles_are_stable_and_ports_and_schemes_are_distinct() {
        assert_eq!(
            installation("https://VOXLY.example:443/").unwrap(),
            installation("https://voxly.example").unwrap()
        );
        assert_ne!(
            installation("http://localhost:3000").unwrap().id,
            installation("http://localhost:3001").unwrap().id
        );
        assert_ne!(
            installation("http://localhost").unwrap().id,
            installation("https://localhost").unwrap().id
        );
        assert!(installation("https://voxly.example")
            .unwrap()
            .id
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn navigation_never_admits_a_lookalike_origin_or_unsafe_opener() {
        assert!(same_origin(
            "https://voxly.example",
            &Url::parse("https://voxly.example/app/room").unwrap()
        ));
        for candidate in [
            "https://voxly.example.evil/",
            "http://voxly.example/",
            "https://voxly.example:444/",
            "https://user@voxly.example/",
            "file:///etc/passwd",
        ] {
            assert!(!same_origin(
                "https://voxly.example",
                &Url::parse(candidate).unwrap()
            ));
        }
        for candidate in [
            "file:///etc/passwd",
            "voxly://open",
            "javascript:alert(1)",
            "https://user@voxly.example",
            "https://tauri.localhost",
        ] {
            assert!(!browser_url(&Url::parse(candidate).unwrap()));
        }
    }
}
