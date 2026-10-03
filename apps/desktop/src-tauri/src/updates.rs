//! Distributor trust and downloaded installers never cross the Installation bridge.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;

const MAX_INSTALLER: usize = 256 * 1024 * 1024;

pub fn secure_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn decoded(value: &str) -> Result<String, &'static str> {
    String::from_utf8(STANDARD.decode(value).map_err(|_| "update_signature")?)
        .map_err(|_| "update_signature")
}

pub fn verify(bytes: &[u8], signature: &str, key: &str) -> Result<(), &'static str> {
    let key = minisign_verify::PublicKey::decode(&decoded(key)?).map_err(|_| "update_signature")?;
    let signature =
        minisign_verify::Signature::decode(&decoded(signature)?).map_err(|_| "update_signature")?;
    key.verify(bytes, &signature, true)
        .map_err(|_| "update_signature")
}

pub fn configured(app: &tauri::AppHandle) -> bool {
    app.config().plugins.0.get("updater").is_some_and(|config| {
        let Some(key) = config.get("pubkey").and_then(|v| v.as_str()) else {
            return false;
        };
        let Some(endpoints) = config.get("endpoints").and_then(|v| v.as_array()) else {
            return false;
        };
        !endpoints.is_empty()
            && endpoints.iter().all(|value| {
                value
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .is_some_and(|url| secure_url(&url))
            })
            && decoded(key)
                .ok()
                .is_some_and(|key| minisign_verify::PublicKey::decode(&key).is_ok())
            && ![
                "dangerousInsecureTransportProtocol",
                "dangerousAcceptInvalidCerts",
                "dangerousAcceptInvalidHostnames",
            ]
            .iter()
            .any(|field| config.get(field).and_then(|v| v.as_bool()) == Some(true))
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub current_version: &'static str,
    pub phase: &'static str,
    pub version: Option<String>,
    pub downloaded: usize,
    pub total: Option<u64>,
    pub error: Option<&'static str>,
}

struct Inner {
    snapshot: Snapshot,
    candidate: Option<Update>,
    bytes: Option<Vec<u8>>,
    cancel: Option<oneshot::Sender<()>>,
    cancelled_version: Option<String>,
}

pub struct Updates {
    // An operation lease prevents check/download/install races without blocking Cancel.
    pub operation: tokio::sync::Mutex<()>,
    inner: Mutex<Inner>,
}

impl Updates {
    pub fn new(enabled: bool) -> Self {
        Self {
            operation: tokio::sync::Mutex::new(()),
            inner: Mutex::new(Inner {
                snapshot: Snapshot {
                    current_version: env!("CARGO_PKG_VERSION"),
                    phase: if enabled { "idle" } else { "disabled" },
                    version: None,
                    downloaded: 0,
                    total: None,
                    error: None,
                },
                candidate: None,
                bytes: None,
                cancel: None,
                cancelled_version: None,
            }),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.inner.lock().unwrap().snapshot.clone()
    }

    pub fn background_download_allowed(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.snapshot.phase == "available"
            && inner.snapshot.error.is_none()
            && inner.cancelled_version != inner.snapshot.version
    }

    fn phase(&self, phase: &'static str, error: Option<&'static str>) {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.phase = phase;
        inner.snapshot.error = error;
    }

    pub async fn check(&self, app: &tauri::AppHandle) -> Result<Snapshot, &'static str> {
        let _lease = self.operation.try_lock().map_err(|_| "update_busy")?;
        if self.snapshot().phase == "disabled" {
            return Ok(self.snapshot());
        }
        // A verified download is retained until explicitly discarded or installed.
        if self.inner.lock().unwrap().bytes.is_some() {
            return Ok(self.snapshot());
        }
        self.phase("checking", None);
        crate::shell::publish_update_state(app);
        let result = async {
            let updater = app
                .updater_builder()
                .timeout(Duration::from_secs(10))
                .target(format!("windows-{}", std::env::consts::ARCH))
                .configure_client(|client| client.https_only(true))
                .build()
                .map_err(|_| "update_unavailable")?;
            let update = updater.check().await.map_err(manifest_error)?;
            if let Some(update) = &update {
                validate_candidate(
                    &update.version,
                    &update.current_version,
                    &update.target,
                    &update.download_url,
                )?;
            }
            Ok::<_, &'static str>(update)
        }
        .await;
        let mut inner = self.inner.lock().unwrap();
        match result {
            Ok(candidate) => {
                inner.snapshot.version = candidate.as_ref().map(|update| update.version.clone());
                inner.snapshot.phase = if candidate.is_some() {
                    "available"
                } else {
                    "current"
                };
                inner.snapshot.error = None;
                inner.candidate = candidate;
            }
            Err(error) => {
                inner.snapshot.phase = "error";
                inner.snapshot.error = Some(error);
            }
        }
        let snapshot = inner.snapshot.clone();
        drop(inner);
        crate::shell::publish_update_state(app);
        Ok(snapshot)
    }

    pub async fn download(&self, app: &tauri::AppHandle) -> Result<Snapshot, &'static str> {
        let _lease = self.operation.try_lock().map_err(|_| "update_busy")?;
        let (candidate, cancel) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.bytes.is_some() {
                return Ok(inner.snapshot.clone());
            }
            let candidate = inner.candidate.clone().ok_or("update_missing")?;
            inner.cancelled_version = None;
            let (send, receive) = oneshot::channel();
            inner.cancel = Some(send);
            inner.snapshot.phase = "downloading";
            inner.snapshot.error = None;
            inner.snapshot.downloaded = 0;
            inner.snapshot.total = None;
            (candidate, receive)
        };
        crate::shell::publish_update_state(app);
        let key = app.config().plugins.0["updater"]["pubkey"]
            .as_str()
            .ok_or("update_signature")?;
        // Bound memory and time, including chunked responses. No cookies or Installation headers.
        let result = tokio::select! {
            biased;
            _ = cancel => Err("update_cancelled"),
            result = tokio::time::timeout(Duration::from_secs(180), self.fetch(&candidate, key)) => result.unwrap_or(Err("update_unavailable")),
        };
        let mut inner = self.inner.lock().unwrap();
        inner.cancel = None;
        match result {
            Ok(bytes) => {
                inner.bytes = Some(bytes);
                inner.snapshot.phase = "ready";
            }
            Err(error) => {
                inner.bytes = None;
                inner.snapshot.phase = "available";
                inner.snapshot.error = Some(error);
            }
        }
        let snapshot = inner.snapshot.clone();
        drop(inner);
        crate::shell::publish_update_state(app);
        Ok(snapshot)
    }

    async fn fetch(&self, update: &Update, key: &str) -> Result<Vec<u8>, &'static str> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "update_unavailable")?;
        fetch_verified(
            &client,
            update.download_url.clone(),
            &update.signature,
            key,
            |downloaded, total| {
                let mut inner = self.inner.lock().unwrap();
                inner.snapshot.downloaded = downloaded;
                inner.snapshot.total = total;
            },
        )
        .await
    }

    pub fn cancel(&self) -> Result<Snapshot, &'static str> {
        let mut inner = self.inner.lock().unwrap();
        if inner.snapshot.phase == "installing" || inner.snapshot.phase == "checking" {
            return Err("update_busy");
        }
        inner.cancelled_version = inner.snapshot.version.clone();
        if let Some(cancel) = inner.cancel.take() {
            let _ = cancel.send(());
        } else {
            inner.bytes = None;
            inner.snapshot.phase = if inner.candidate.is_some() {
                "available"
            } else {
                inner.snapshot.phase
            };
            inner.snapshot.error = None;
        }
        Ok(inner.snapshot.clone())
    }

    pub fn installer(&self) -> Result<Vec<u8>, &'static str> {
        let mut inner = self.inner.lock().unwrap();
        if inner.candidate.is_none() {
            return Err("update_missing");
        }
        let bytes = inner.bytes.take().ok_or("update_missing")?;
        inner.snapshot.phase = "installing";
        Ok(bytes)
    }

    pub fn install_failed(&self, app: &tauri::AppHandle) {
        self.phase("available", Some("update_install_failed"));
        crate::shell::publish_update_state(app);
    }
}

async fn fetch_verified(
    client: &reqwest::Client,
    url: url::Url,
    signature: &str,
    key: &str,
    mut progress: impl FnMut(usize, Option<u64>),
) -> Result<Vec<u8>, &'static str> {
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|_| "update_unavailable")?;
    let total = response.content_length();
    if total.is_some_and(|size| size > MAX_INSTALLER as u64) {
        return Err("update_invalid");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "update_unavailable")? {
        if bytes.len().saturating_add(chunk.len()) > MAX_INSTALLER {
            return Err("update_invalid");
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len(), total);
    }
    verify(&bytes, signature, key)?;
    Ok(bytes)
}

fn manifest_error(error: tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error;
    match error {
        Error::TargetNotFound(_)
        | Error::TargetsNotFound(_)
        | Error::Semver(_)
        | Error::Serialization(_) => "update_invalid",
        _ => "update_unavailable",
    }
}

fn validate_candidate(
    version: &str,
    current: &str,
    target: &str,
    url: &url::Url,
) -> Result<(), &'static str> {
    let latest = semver::Version::parse(version).map_err(|_| "update_invalid")?;
    let current = semver::Version::parse(current).map_err(|_| "update_invalid")?;
    if latest <= current
        || !latest.pre.is_empty()
        || target != format!("windows-{}", std::env::consts::ARCH)
        || !secure_url(url)
    {
        return Err("update_invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // Public minisign-verify test vector, not a release key. No private key exists here.
    const KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    #[test]
    fn only_authentic_bytes_pass_verification() {
        let key = STANDARD.encode(KEY);
        let signature = STANDARD.encode(SIGNATURE);
        assert!(verify(b"test", &signature, &key).is_ok());
        assert_eq!(verify(b"Test", &signature, &key), Err("update_signature"));
        assert_eq!(verify(b"test", "invalid", &key), Err("update_signature"));
        assert_eq!(
            verify(b"test", &signature, "invalid"),
            Err("update_signature")
        );
        let other_key = KEY.replace("RWQf6LRCGA9i53", "RWQf6LRCGA9i54");
        assert!(verify(b"test", &signature, &STANDARD.encode(other_key)).is_err());
    }

    #[test]
    fn refuses_downgrades_prereleases_wrong_platform_and_insecure_artifacts() {
        let target = format!("windows-{}", std::env::consts::ARCH);
        let url = "https://downloads.example/app.exe".parse().unwrap();
        assert!(validate_candidate("0.2.0", "0.1.0", &target, &url).is_ok());
        for version in ["0.1.0", "0.0.9", "invalid", "0.2.0-beta.1"] {
            assert!(validate_candidate(version, "0.1.0", &target, &url).is_err());
        }
        assert!(validate_candidate("0.2.0", "0.1.0", "darwin-aarch64", &url).is_err());
        for url in [
            "http://downloads.example/app.exe",
            "https://user@downloads.example/app.exe",
            "file:///tmp/update",
            "https://downloads.example/app.exe#fragment",
        ] {
            assert!(!secure_url(&url.parse().unwrap()));
        }
    }

    #[test]
    fn downloads_reject_unavailable_interrupted_oversized_and_invalid_signatures() {
        use std::io::{Read, Write};
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let key = STANDARD.encode(KEY);
            let signature = STANDARD.encode(SIGNATURE);
            for (response, expected) in [
                (
                    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest",
                    Ok(b"test".to_vec()),
                ),
                (
                    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nTest",
                    Err("update_signature"),
                ),
                (
                    "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    Err("update_unavailable"),
                ),
                (
                    "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nte",
                    Err("update_unavailable"),
                ),
                (
                    "HTTP/1.1 200 OK\r\nContent-Length: 268435457\r\nConnection: close\r\n\r\n",
                    Err("update_invalid"),
                ),
            ] {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let url = format!("http://{}/installer.exe", listener.local_addr().unwrap())
                    .parse()
                    .unwrap();
                let server = std::thread::spawn(move || {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = [0u8; 2048];
                    let len = socket.read(&mut request).unwrap();
                    assert!(!String::from_utf8_lossy(&request[..len])
                        .to_lowercase()
                        .contains("cookie:"));
                    socket.write_all(response.as_bytes()).unwrap();
                });
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap();
                assert_eq!(
                    fetch_verified(&client, url, &signature, &key, |_, _| {}).await,
                    expected
                );
                server.join().unwrap();
            }
        });
    }

    #[test]
    fn cancelled_download_signals_the_operation_and_cannot_be_installed() {
        let updates = Updates::new(true);
        let (send, mut receive) = oneshot::channel();
        {
            let mut inner = updates.inner.lock().unwrap();
            inner.cancel = Some(send);
            inner.snapshot.phase = "downloading";
        }
        updates.cancel().unwrap();
        assert!(receive.try_recv().is_ok());
        assert!(updates.installer().is_err());
        let disabled = Updates::new(false);
        assert_eq!(disabled.snapshot().phase, "disabled");
        assert!(disabled.installer().is_err());
    }

    #[test]
    fn background_download_respects_cancellation_until_a_new_release() {
        let updates = Updates::new(true);
        {
            let mut inner = updates.inner.lock().unwrap();
            inner.snapshot.phase = "available";
            inner.snapshot.version = Some("0.2.0".into());
        }
        assert!(updates.background_download_allowed());
        updates.cancel().unwrap();
        assert!(!updates.background_download_allowed());
        updates.inner.lock().unwrap().snapshot.version = Some("0.3.0".into());
        assert!(updates.background_download_allowed());
        updates.phase("available", Some("update_signature"));
        assert!(!updates.background_download_allowed());
    }
}
