use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::oneshot;

/// Advisory, finite state only. No identities, tracks, URLs or native actions.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallState {
    pub version: u8,
    pub in_voice: bool,
    pub microphone: bool,
    pub camera: bool,
    pub screen: bool,
    pub computer_audio: bool,
    pub capture: bool,
    pub pending_join: bool,
    pub pending_capture: bool,
    pub microphone_test: bool,
}

impl CallState {
    pub fn needs_confirmation(&self) -> bool {
        self.version != 1
            || self.in_voice
            || self.microphone
            || self.camera
            || self.screen
            || self.computer_audio
            || self.capture
            || self.pending_join
            || self.pending_capture
            || self.microphone_test
    }
}

#[derive(Default)]
pub struct Reports(Mutex<Inbox>);
#[derive(Default)]
struct Inbox {
    sequence: u32,
    revision: u64,
    pending: Option<(u64, u32, oneshot::Sender<CallState>)>,
}

impl Reports {
    pub fn request(&self, generation: u64) -> (u32, u64, oneshot::Receiver<CallState>) {
        let mut inbox = self.0.lock().unwrap();
        inbox.sequence = inbox
            .sequence
            .checked_add(1)
            .expect("report sequence exhausted");
        let request = inbox.sequence;
        inbox.revision += 1;
        let (send, receive) = oneshot::channel();
        inbox.pending = Some((generation, request, send));
        (request, inbox.revision, receive)
    }

    pub fn invalidate(&self) {
        let mut inbox = self.0.lock().unwrap();
        inbox.pending = None;
        inbox.revision += 1;
    }

    pub fn finish(&self, revision: u64) -> bool {
        let mut inbox = self.0.lock().unwrap();
        if inbox.revision != revision {
            return false;
        }
        inbox.pending = None;
        inbox.revision += 1;
        true
    }

    pub fn receive(
        &self,
        generation: u64,
        request: u32,
        report: CallState,
    ) -> Result<(), &'static str> {
        let mut inbox = self.0.lock().map_err(|_| "forbidden")?;
        if report.version != 1
            || !inbox
                .pending
                .as_ref()
                .is_some_and(|(g, r, _)| *g == generation && *r == request)
        {
            return Err("forbidden");
        }
        let (_, _, send) = inbox.pending.take().ok_or("forbidden")?;
        send.send(report).map_err(|_| "forbidden")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn idle() -> CallState {
        serde_json::from_str(r#"{"version":1,"inVoice":false,"microphone":false,"camera":false,"screen":false,"computerAudio":false,"capture":false,"pendingJoin":false,"pendingCapture":false,"microphoneTest":false}"#).unwrap()
    }
    #[test]
    fn every_call_capture_and_pending_flag_requires_confirmation() {
        assert!(!idle().needs_confirmation());
        for field in [
            "inVoice",
            "microphone",
            "camera",
            "screen",
            "computerAudio",
            "capture",
            "pendingJoin",
            "pendingCapture",
            "microphoneTest",
        ] {
            let mut value = serde_json::to_value(idle()).unwrap();
            value[field] = true.into();
            assert!(
                serde_json::from_value::<CallState>(value)
                    .unwrap()
                    .needs_confirmation(),
                "{field}"
            );
        }
        let mut unsupported = idle();
        unsupported.version = 2;
        assert!(unsupported.needs_confirmation());
    }
    #[test]
    fn reports_reject_old_generations_replays_and_navigation() {
        let reports = Reports::default();
        let (old, old_revision, mut old_reply) = reports.request(1);
        let (current, revision, mut reply) = reports.request(2);
        assert!(old_reply.try_recv().is_err());
        assert!(!reports.finish(old_revision));
        assert!(reports.receive(1, old, idle()).is_err());
        assert!(reports.receive(1, current, idle()).is_err());
        assert!(reports.receive(2, current, idle()).is_ok());
        assert_eq!(reply.try_recv().unwrap(), idle());
        assert!(reports.receive(2, current, idle()).is_err());
        // Navigation after delivery but before the query consumes it is stale too.
        reports.invalidate();
        assert!(!reports.finish(revision));
        let (request, _, _) = reports.request(2);
        reports.invalidate();
        assert!(reports.receive(2, request, idle()).is_err());
    }
    #[test]
    fn expired_request_cannot_supply_a_later_idle_report() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let reports = Reports::default();
            let (request, _, reply) = reports.request(2);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(1), reply)
                    .await
                    .is_err()
            );
            reports.invalidate();
            let (next, _, mut reply) = reports.request(2);
            assert!(reports.receive(2, request, idle()).is_err());
            assert!(reports.receive(2, next, idle()).is_ok());
            assert_eq!(reply.try_recv().unwrap(), idle());
        });
    }

    #[test]
    fn report_shape_is_required_and_finite() {
        let mut value = serde_json::to_value(idle()).unwrap();
        value["path"] = "/tmp".into();
        assert!(serde_json::from_value::<CallState>(value).is_err());
        let mut value = serde_json::to_value(idle()).unwrap();
        value.as_object_mut().unwrap().remove("capture");
        assert!(serde_json::from_value::<CallState>(value).is_err());
    }
}
