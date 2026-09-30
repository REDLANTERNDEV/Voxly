use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Message,
    VoicePeerJoin,
    VoicePeerLeave,
    ScreenShareStart,
    ScreenShareStop,
    ConnectionLost,
    ConnectionRestored,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    Tr,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub kind: Kind,
    pub language: Language,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(not(windows), allow(dead_code))] // Native success/suppression are Windows-only.
pub enum Delivery {
    Shown,
    Fallback,
    Blocked,
}

#[cfg(any(windows, test))]
fn background_delivery(focused: bool, send: impl FnOnce() -> Delivery) -> Delivery {
    if focused {
        Delivery::Blocked
    } else {
        send()
    }
}

#[cfg(any(windows, test))]
fn foreground_matches(owner: Option<usize>, foreground: usize, foreground_owner: usize) -> bool {
    // An unavailable own handle cannot establish that delivery is in background.
    owner.is_none_or(|owner| owner == foreground || owner == foreground_owner)
}

#[cfg(windows)]
fn system_window_focused(owner: Option<usize>) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOTOWNER};
    unsafe {
        let foreground = GetForegroundWindow();
        let root = if foreground.0.is_null() {
            foreground
        } else {
            GetAncestor(foreground, GA_ROOTOWNER)
        };
        foreground_matches(owner, foreground.0 as usize, root.0 as usize)
    }
}

#[cfg(windows)]
fn window_focused(window: &WebviewWindow) -> bool {
    system_window_focused(window.hwnd().ok().map(|hwnd| hwnd.0 as usize))
}

#[cfg(windows)]
pub fn suppress_focused_webview_notifications(
    window: &WebviewWindow,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::ICoreWebView2_24, NotificationReceivedEventHandler,
    };
    use windows::core::Interface;

    // Older runtimes retain the existing document gate and default background UI.
    let Ok(view) = core.cast::<ICoreWebView2_24>() else {
        return;
    };
    let owner = window.hwnd().ok().map(|hwnd| hwnd.0 as usize);
    let handler = NotificationReceivedEventHandler::create(Box::new(move |_, args| {
        if system_window_focused(owner) {
            if let Some(args) = args {
                // Only suppress this event. Background notifications keep WebView2's
                // default delivery/click handling; no custom UI or fake ReportShown.
                unsafe { args.SetHandled(true)? };
            }
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { view.add_NotificationReceived(&handler, &mut token) };
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
enum Stage {
    CreateNotifier,
    ReadSetting,
    CreateXml,
    LoadXml,
    CreateToast,
    SetTag,
    SetGroup,
    RegisterActivation,
    RegisterDismissal,
    RegisterFailure,
    Show,
    AsyncDelivery,
}

#[cfg(any(windows, test))]
#[derive(Serialize)]
struct Diagnostic {
    stage: Stage,
    hresult: String,
}

#[cfg(any(windows, test))]
impl Diagnostic {
    fn new(stage: Stage, hresult: i32) -> Self {
        Self {
            stage,
            hresult: format!("0x{:08X}", hresult as u32),
        }
    }
}

#[cfg(any(windows, test))]
fn write_diagnostic(path: &std::path::Path, diagnostic: &Diagnostic) {
    // One bounded local snapshot, never routes, IDs, content or raw error messages.
    // A diagnostic write failure must not affect notification fallback or calls.
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Ok(_guard) = WRITE_LOCK.lock() else {
        return;
    };
    if let Ok(json) = serde_json::to_vec(diagnostic) {
        let _ = std::fs::write(path, json);
    }
}

#[cfg(windows)]
fn record_diagnostic(window: &WebviewWindow, diagnostic: &Diagnostic) {
    use tauri::Manager;
    let app = window.app_handle();
    let shell = app.state::<crate::Shell>();
    write_diagnostic(
        &shell.data.join("native-notification-diagnostic.json"),
        diagnostic,
    );
}

#[cfg(windows)]
fn checked<T>(stage: Stage, result: windows::core::Result<T>) -> Result<T, Diagnostic> {
    result.map_err(|error| Diagnostic::new(stage, error.code().0))
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

#[cfg(any(windows, test))]
fn body(kind: Kind, language: Language) -> &'static str {
    use Kind::*;
    match (language, kind) {
        (Language::En, Message) => "You have a new message.",
        (Language::En, VoicePeerJoin) => "Someone joined your voice room.",
        (Language::En, VoicePeerLeave) => "Someone left your voice room.",
        (Language::En, ScreenShareStart) => "Screen sharing started in your voice room.",
        (Language::En, ScreenShareStop) => "Screen sharing stopped in your voice room.",
        (Language::En, ConnectionLost) => "Your connection was interrupted.",
        (Language::En, ConnectionRestored) => "Your connection was restored.",
        (Language::Tr, Message) => "Yeni bir mesajınız var.",
        (Language::Tr, VoicePeerJoin) => "Ses odanıza biri katıldı.",
        (Language::Tr, VoicePeerLeave) => "Ses odanızdan biri ayrıldı.",
        (Language::Tr, ScreenShareStart) => "Ses odanızda ekran paylaşımı başladı.",
        (Language::Tr, ScreenShareStop) => "Ses odanızda ekran paylaşımı sona erdi.",
        (Language::Tr, ConnectionLost) => "Bağlantınız kesintiye uğradı.",
        (Language::Tr, ConnectionRestored) => "Bağlantınız yeniden kuruldu.",
    }
}
#[cfg(any(windows, test))]
fn xml(request: &Request) -> String {
    // Native-owned copy only. No routes, origins, names, messages or launch arguments.
    format!("<toast><visual><binding template=\"ToastGeneric\"><text>Voxly</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>", body(request.kind, request.language))
}

#[derive(Default)]
pub struct Notifications {
    #[cfg(windows)]
    entries: std::sync::Mutex<std::collections::HashMap<(String, String), Entry>>,
    #[cfg(windows)]
    last: std::sync::Mutex<std::collections::HashMap<(String, Kind), std::time::Instant>>,
}

impl Notifications {
    pub fn show(&self, window: &WebviewWindow, request: Request) -> Delivery {
        #[cfg(windows)]
        {
            background_delivery(window_focused(window), || {
                match self.show_windows(window, request) {
                    Ok(delivery) => delivery,
                    Err(diagnostic) => {
                        record_diagnostic(window, &diagnostic);
                        Delivery::Fallback
                    }
                }
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (window, request.id, request.kind, request.language);
            Delivery::Fallback
        }
    }
    pub fn close(&self, label: &str, id: &str) {
        #[cfg(windows)]
        {
            let entry = self
                .entries
                .lock()
                .unwrap()
                .remove(&(label.to_owned(), id.to_owned()));
            drop(entry);
        }
        #[cfg(not(windows))]
        {
            let _ = (label, id);
        }
    }
    pub fn clear(&self, label: &str) {
        #[cfg(windows)]
        {
            let removed = {
                let mut entries = self.entries.lock().unwrap();
                let keys: Vec<_> = entries
                    .keys()
                    .filter(|(owner, _)| owner == label)
                    .cloned()
                    .collect();
                keys.into_iter()
                    .filter_map(|key| entries.remove(&key))
                    .collect::<Vec<_>>()
            };
            drop(removed);
            self.last
                .lock()
                .unwrap()
                .retain(|(owner, _), _| owner != label);
        }
        #[cfg(not(windows))]
        {
            let _ = label;
        }
    }
}

#[cfg(windows)]
use windows::{
    core::{IInspectable, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{
        NotificationSetting, ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs,
        ToastNotification, ToastNotificationManager, ToastNotifier,
    },
};
#[cfg(windows)]
struct Entry {
    toast: ToastNotification,
    notifier: ToastNotifier,
    app_id: HSTRING,
    activated: Option<i64>,
    dismissed: Option<i64>,
    failed: Option<i64>,
}
#[cfg(windows)]
impl Drop for Entry {
    fn drop(&mut self) {
        if let Some(token) = self.activated {
            let _ = self.toast.RemoveActivated(token);
        }
        if let Some(token) = self.dismissed {
            let _ = self.toast.RemoveDismissed(token);
        }
        if let Some(token) = self.failed {
            let _ = self.toast.RemoveFailed(token);
        }
        let _ = self.notifier.Hide(&self.toast);
        if let (Ok(history), Ok(tag), Ok(group)) = (
            ToastNotificationManager::History(),
            self.toast.Tag(),
            self.toast.Group(),
        ) {
            let _ = history.RemoveGroupedTagWithId(&tag, &group, &self.app_id);
        }
    }
}
#[cfg(windows)]
fn event(window: &WebviewWindow, id: &str, event: &'static str) {
    use tauri::Manager;
    let window = window.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn(async move {
        let app = window.app_handle();
        app.state::<Notifications>().close(window.label(), &id);
        let shell = app.state::<crate::Shell>();
        let inner = shell.inner.lock().await;
        let Some(active) = &inner.active else { return };
        let Ok(url) = window.url() else { return };
        if !crate::report_caller_matches(
            shell
                .voice_generation
                .load(std::sync::atomic::Ordering::Acquire),
            window.label(),
            &active.origin,
            &url,
        ) {
            return;
        }
        // A send failure queued in background must not become a Compatibility
        // popup after the member has returned to the Installation window.
        let event = if event == "failed" && window_focused(&window) {
            "close"
        } else {
            event
        };
        let detail = serde_json::json!({ "id": id, "event": event });
        let _ = window.eval(&format!("window.dispatchEvent(new CustomEvent('voxly:native-notification', {{detail:{detail}}}));"));
    });
}
#[cfg(windows)]
impl Notifications {
    fn show_windows(
        &self,
        window: &WebviewWindow,
        request: Request,
    ) -> Result<Delivery, Diagnostic> {
        use tauri::Manager;

        let app_id = HSTRING::from(&window.app_handle().config().identifier);
        let notifier = checked(
            Stage::CreateNotifier,
            ToastNotificationManager::CreateToastNotifierWithId(&app_id),
        )?;
        if checked(Stage::ReadSetting, notifier.Setting())? != NotificationSetting::Enabled {
            return Ok(Delivery::Blocked);
        }
        let now = std::time::Instant::now();
        let key = (window.label().to_owned(), request.kind);
        {
            let mut last = self.last.lock().unwrap();
            if last
                .get(&key)
                .is_some_and(|time| now.duration_since(*time).as_secs() < 1)
            {
                return Ok(Delivery::Blocked);
            }
            last.insert(key, now);
        }
        let document = checked(Stage::CreateXml, XmlDocument::new())?;
        checked(
            Stage::LoadXml,
            document.LoadXml(&HSTRING::from(xml(&request))),
        )?;
        let toast = checked(
            Stage::CreateToast,
            ToastNotification::CreateToastNotification(&document),
        )?;
        checked(
            Stage::SetTag,
            toast.SetTag(&HSTRING::from(&request.id[..16])),
        )?;
        checked(
            Stage::SetGroup,
            toast.SetGroup(&HSTRING::from(window.label())),
        )?;
        let mut entry = Entry {
            toast: toast.clone(),
            notifier: notifier.clone(),
            app_id,
            activated: None,
            dismissed: None,
            failed: None,
        };
        let target = window.clone();
        let id = request.id.clone();
        entry.activated = Some(checked(
            Stage::RegisterActivation,
            toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
                move |_, _| {
                    event(&target, &id, "click");
                    Ok(())
                },
            )),
        )?);
        let target = window.clone();
        let id = request.id.clone();
        entry.dismissed = Some(checked(
            Stage::RegisterDismissal,
            toast.Dismissed(&TypedEventHandler::<
                ToastNotification,
                ToastDismissedEventArgs,
            >::new(move |_, args| {
                // A timed-out banner remains clickable in Windows notification history.
                if let Some(args) = args.as_ref() {
                    if args.Reason()? != ToastDismissalReason::TimedOut {
                        event(&target, &id, "close");
                    }
                }
                Ok(())
            })),
        )?);
        let target = window.clone();
        let id = request.id.clone();
        let settings = notifier.clone();
        entry.failed = Some(checked(
            Stage::RegisterFailure,
            toast.Failed(
                &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(
                    move |_, args| {
                        if let Some(code) = args.as_ref().and_then(|args| args.ErrorCode().ok()) {
                            record_diagnostic(
                                &target,
                                &Diagnostic::new(Stage::AsyncDelivery, code.0),
                            );
                        }
                        event(
                            &target,
                            &id,
                            if settings
                                .Setting()
                                .is_ok_and(|s| s == NotificationSetting::Enabled)
                            {
                                "failed"
                            } else {
                                "close"
                            },
                        );
                        Ok(())
                    },
                ),
            ),
        )?);
        if window_focused(window) {
            return Ok(Delivery::Blocked);
        }
        let key = (window.label().to_owned(), request.id);
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= 16 || entries.contains_key(&key) {
            return Ok(Delivery::Blocked);
        }
        entries.insert(key.clone(), entry);
        if let Err(error) = notifier.Show(&toast) {
            let entry = entries.remove(&key);
            drop(entries);
            drop(entry);
            return Err(Diagnostic::new(Stage::Show, error.code().0));
        }
        Ok(Delivery::Shown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focused_window_never_calls_the_sender_or_requests_fallback() {
        let mut calls = 0;
        let result = background_delivery(true, || {
            calls += 1;
            Delivery::Fallback
        });
        assert!(matches!(result, Delivery::Blocked));
        assert_eq!(calls, 0);
        let result = background_delivery(false, || {
            calls += 1;
            Delivery::Shown
        });
        assert!(matches!(result, Delivery::Shown));
        assert_eq!(calls, 1);
    }
    #[test]
    fn foreground_window_matching_includes_owned_dialogs_and_allows_other_apps() {
        assert!(foreground_matches(Some(10), 10, 10));
        assert!(foreground_matches(Some(10), 20, 10));
        assert!(!foreground_matches(Some(10), 20, 20));
        assert!(!foreground_matches(Some(10), 0, 0));
        assert!(foreground_matches(None, 20, 20));
    }
    #[test]
    fn diagnostic_keeps_only_finite_stage_and_hresult_and_replaces_the_previous_failure() {
        let path = std::env::temp_dir().join(format!(
            "voxly-notification-diagnostic-{}.json",
            std::process::id()
        ));
        let first = Diagnostic::new(Stage::CreateNotifier, 0x80040154_u32 as i32);
        write_diagnostic(&path, &first);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
            serde_json::json!({"stage": "createNotifier", "hresult": "0x80040154"})
        );
        write_diagnostic(
            &path,
            &Diagnostic::new(Stage::AsyncDelivery, 0x80070005_u32 as i32),
        );
        let contents = std::fs::read(&path).unwrap();
        assert!(contents.len() < 128);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&contents).unwrap(),
            serde_json::json!({"stage": "asyncDelivery", "hresult": "0x80070005"})
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn request_contract_is_finite_and_contains_no_content_or_routes() {
        let id = "a".repeat(32);
        assert!(valid_id(&id));
        for invalid in [
            "",
            "A00000000000000000000000000000000",
            "<script>",
            "https://example.com",
        ] {
            assert!(!valid_id(invalid));
        }
        let valid = format!("{{\"id\":\"{id}\",\"kind\":\"message\",\"language\":\"en\"}}");
        let request: Request = serde_json::from_str(&valid).unwrap();
        assert!(xml(&request).contains("<audio silent=\"true\"/>"));
        assert!(!xml(&request).contains(&id));
        assert!(!xml(&request).contains("launch="));
        assert!(serde_json::from_str::<Request>(&valid.replace("message", "arbitrary")).is_err());
        assert!(serde_json::from_str::<Request>(&valid.replace("\"en\"", "\"de\"")).is_err());
        assert!(
            serde_json::from_str::<Request>(&valid.replace("}", ",\"body\":\"private\"}")).is_err()
        );
        assert_eq!(body(Kind::Message, Language::Tr), "Yeni bir mesajınız var.");
    }
}
