use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use url::Url;

pub const INSTALLATION_LIMIT: usize = 32;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Installation {
    pub id: String,
    pub origin: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub installations: Vec<Installation>,
    pub language: Language,
    pub tray_acknowledged: bool,
    #[serde(default)]
    pub mute_shortcut: Option<String>,
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
    Ok(Installation { id, origin })
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
            return Ok(Preferences::default())
        }
        Err(_) => return Err("storage_failed"),
    };
    if bytes.len() > 128 * 1024 {
        return Err("storage_failed");
    }
    let preferences: Preferences = serde_json::from_slice(&bytes).map_err(|_| "storage_failed")?;
    if let Some(binding) = &preferences.mute_shortcut {
        crate::shortcuts::parse_binding(binding).map_err(|_| "storage_failed")?;
    }
    if preferences.installations.len() > INSTALLATION_LIMIT {
        return Err("storage_failed");
    }
    let mut seen = std::collections::HashSet::new();
    for saved in &preferences.installations {
        if installation(&saved.origin).as_ref() != Ok(saved) || !seen.insert(&saved.id) {
            return Err("storage_failed");
        }
    }
    Ok(preferences)
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
        };
        save(&path, &preferences).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.installations, preferences.installations);
        assert!(loaded.language == Language::Tr && loaded.tray_acknowledged);
        assert_eq!(loaded.mute_shortcut, preferences.mute_shortcut);
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
