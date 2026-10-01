use crate::installations::{self, Installation};

// OS URLs and process arguments are untrusted. Only an Installation origin is
// accepted, plus an optional public sign-in correlation id. Never a credential.
#[derive(Clone, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLink {
    #[serde(flatten)]
    pub installation: Installation,
    pub launch_id: Option<String>,
}

pub fn launch_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, byte)| {
            if [8, 13, 18, 23].contains(&i) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

pub fn parse(input: &str) -> Option<DesktopLink> {
    if input.len() > 4096
        // Browsers may add a root slash to the protocol URL. Check the raw
        // envelope too, so URL normalization cannot hide dot paths.
        || !(input.starts_with("voxly://open?origin=")
            || input.starts_with("voxly://open/?origin="))
        || input.contains('\\')
        || input.chars().any(char::is_control)
    {
        return None;
    }
    let url = url::Url::parse(input).ok()?;
    if url.scheme() != "voxly"
        || url.host_str() != Some("open")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !matches!(url.path(), "" | "/")
        || url.fragment().is_some()
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, origin) = pairs.next()?;
    if key != "origin" {
        return None;
    }
    let launch_id = match pairs.next() {
        None => None,
        Some((key, id)) if key == "launch" && launch_id(&id) => Some(id.into_owned()),
        _ => return None,
    };
    if pairs.next().is_some() {
        return None;
    }
    let saved = installations::installation(&origin).ok()?;
    (saved.origin == origin).then_some(DesktopLink {
        installation: saved,
        launch_id,
    })
}

pub fn from_args(args: &[String]) -> Option<DesktopLink> {
    if args.len() != 2 {
        return None;
    }
    parse(&args[1])
}

pub fn restores_active(
    target: &Installation,
    active: Option<&Installation>,
    window_url: Option<&url::Url>,
) -> bool {
    active.is_some_and(|active| active.origin == target.origin)
        && window_url.is_some_and(|url| installations::same_origin(&target.origin, url))
}

#[derive(Default)]
pub struct PendingLink(std::sync::Mutex<Option<DesktopLink>>);

impl PendingLink {
    pub fn offer(&self, target: DesktopLink) {
        // Keep one bounded, validated request, even before the chooser is ready.
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(target);
        }
    }

    pub fn take(&self) -> Option<DesktopLink> {
        self.0.lock().ok()?.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_canonical_installation_origins() {
        let target = parse("voxly://open?origin=https%3A%2F%2Fchat.example").unwrap();
        assert_eq!(
            target.installation,
            installations::installation("https://chat.example").unwrap()
        );
        assert!(parse("voxly://open?origin=http%3A%2F%2Flocalhost%3A3000").is_some());
        assert!(parse("voxly://open?origin=http%3A%2F%2F%5B%3A%3A1%5D%3A3000").is_some());
    }

    #[test]
    fn rejects_credentials_routes_extra_parameters_and_unrelated_protocols() {
        for origin in [
            "http://chat.example",
            "file:///tmp/local",
            "tauri://localhost",
            "https://tauri.localhost",
            "https://ipc.localhost",
            "https://user:secret@chat.example",
            "https://chat.example/invite/secret",
            "https://chat.example?token=secret",
            "https://chat.example#token=secret",
            "https://chat.example/",
            "https://CHAT.example",
        ] {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("origin", origin)
                .finish();
            assert!(
                parse(&format!("voxly://open?{query}")).is_none(),
                "{origin}"
            );
        }
        for input in [
            "https://open?origin=https://chat.example",
            "voxly://quit?origin=https://chat.example",
            "voxly://open/path?origin=https://chat.example",
            "voxly://open/path/../?origin=https://chat.example",
            "voxly://open/.?origin=https://chat.example",
            "voxly://open/%2e/?origin=https://chat.example",
            "voxly://open//?origin=https://chat.example",
            "voxly://open/?origin=https://chat.example&token=secret",
            "voxly://open/?origin=http%3A%2F%2F127.0.0.1%3A5173”",
            "voxly://open:123?origin=https://chat.example",
            "voxly://user@open?origin=https://chat.example",
            "voxly://open?origin=https://chat.example&origin=https://evil.example",
            "voxly://open?origin=https://chat.example&token=secret",
            "voxly://open?origin=https://chat.example#token=secret",
            "voxly://open?origin=https://chat.example\n",
            "voxly://open?origin=https:\\chat.example",
            "voxly://open?origin=%FF",
            "voxly://open?origin=",
            "voxly://open?origin=%",
        ] {
            assert!(parse(input).is_none(), "{input}");
        }
        assert!(parse(&format!("voxly://open?origin={}", "a".repeat(4096))).is_none());
    }

    #[test]
    fn cold_and_running_processes_accept_exactly_one_uri_argument() {
        let args = vec![
            "Voxly.exe".into(),
            "voxly://open?origin=https://chat.example".into(),
        ];
        assert!(from_args(&args).is_some());
        assert!(from_args(&args[..1]).is_none());
        assert!(from_args(&[args[0].clone(), "--open".into(), args[1].clone()]).is_none());
        let pending = PendingLink::default();
        pending.offer(from_args(&args).unwrap());
        pending.offer(parse("voxly://open?origin=https://other.example").unwrap());
        assert_eq!(
            pending.take().unwrap().installation.origin,
            "https://other.example"
        );
        assert!(pending.take().is_none());
    }

    #[test]
    fn browser_root_slash_reaches_the_installation_offer() {
        for origin in [
            "https://chat.example",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ] {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("origin", origin)
                .finish();
            for envelope in ["voxly://open?", "voxly://open/?"] {
                let args = vec!["Voxly.exe".into(), format!("{envelope}{query}")];
                let target =
                    from_args(&args).expect("browser URI must reach cold and running handlers");
                let pending = PendingLink::default();
                pending.offer(target);
                assert_eq!(pending.take().unwrap().installation.origin, origin);
            }
        }
    }

    #[test]
    fn accepts_only_a_single_public_launch_identifier() {
        let id = "12345678-1234-1234-1234-123456789abc";
        let input = format!("voxly://open/?origin=https%3A%2F%2Fchat.example&launch={id}");
        assert_eq!(parse(&input).unwrap().launch_id.as_deref(), Some(id));
        for suffix in ["&launch=bad", "&token=secret", "&launch=12345678-1234-1234-1234-123456789abc&launch=12345678-1234-1234-1234-123456789abc"] {
            assert!(parse(&format!("voxly://open?origin=https://chat.example{suffix}")).is_none());
        }
    }

    #[test]
    fn restores_only_a_matching_active_installation_and_current_window() {
        let target = installations::installation("https://chat.example").unwrap();
        let other = installations::installation("https://other.example").unwrap();
        let room = "https://chat.example/app/server/a/voice/b".parse().unwrap();
        assert!(restores_active(&target, Some(&target), Some(&room)));
        assert!(!restores_active(&target, Some(&other), Some(&room)));
        assert!(!restores_active(&target, None, Some(&room)));
        assert!(!restores_active(&target, Some(&target), None));
        for url in [
            "https://evil.example/",
            "https://chat.example.evil/",
            "https://user@chat.example/",
            "tauri://localhost/",
        ] {
            assert!(!restores_active(
                &target,
                Some(&target),
                Some(&url.parse().unwrap())
            ));
        }
    }
}
