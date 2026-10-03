//! Caller validation for the local shell and the active Installation.
use crate::{installations, platform};
use tauri::WebviewWindow;

pub(super) fn trusted_shell(window: &WebviewWindow) -> Result<(), &'static str> {
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

pub(super) fn shell_navigation(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let origin = url.origin().ascii_serialization();
    // `tauri:` is non-special in URL, so its Origin is opaque; compare host too.
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || origin == "https://tauri.localhost"
        || (cfg!(debug_assertions) && origin == "http://127.0.0.1:1420")
}

pub(crate) fn report_caller_matches(
    generation: u64,
    label: &str,
    origin: &str,
    url: &url::Url,
) -> bool {
    label == platform::installation_label(generation) && installations::same_origin(origin, url)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn reports_only_accept_the_active_window_generation_and_exact_origin() {
        let origin = "https://chat.example";
        assert!(report_caller_matches(
            2,
            "installation-2",
            origin,
            &"https://chat.example/app/".parse().unwrap()
        ));
        for (label, url) in [
            ("shell", "https://chat.example/app/"),
            ("installation-1", "https://chat.example/app/"),
            ("installation-2", "https://chat.example.evil/app/"),
            ("installation-2", "https://chat.example:444/app/"),
            ("installation-2", "http://chat.example/app/"),
        ] {
            assert!(!report_caller_matches(
                2,
                label,
                origin,
                &url.parse().unwrap()
            ));
        }
    }
}
