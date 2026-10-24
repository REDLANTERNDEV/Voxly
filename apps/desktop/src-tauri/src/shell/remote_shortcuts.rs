//! What a remote Installation may do to global shortcuts: ask. The page can
//! record a chord and name it, but only the local Home shell's Confirm saves it,
//! and a recording the page leaves running ends by itself (ADR-0020).
use crate::shortcuts::Action;
use serde::Serialize;

/// How long a recording the page started may watch the person's keys.
pub(super) const RECORDING_LIMIT: std::time::Duration = std::time::Duration::from_secs(15);

/// One remote request waiting for the member's answer in the Home shell.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShortcutRequest {
    pub id: u64,
    #[serde(serialize_with = "action_name")]
    pub action: Action,
    pub binding: Option<String>,
    pub origin: String,
    #[serde(skip)]
    pub generation: u64,
}

fn action_name<S: serde::Serializer>(action: &Action, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(match action {
        Action::Mute => "mute",
        Action::Deafen => "deafen",
        Action::PushToTalk => "pushToTalk",
        Action::PushToMute => "pushToMute",
    })
}

pub(super) fn parse_action(action: &str) -> Result<Action, &'static str> {
    match action {
        "mute" => Ok(Action::Mute),
        "deafen" => Ok(Action::Deafen),
        "pushToTalk" => Ok(Action::PushToTalk),
        "pushToMute" => Ok(Action::PushToMute),
        _ => Err("shortcut_invalid"),
    }
}

/// At most one pending request and one remote recording at a time.
#[derive(Default)]
pub(super) struct RemoteShortcuts {
    next_request: u64,
    pending: Option<ShortcutRequest>,
    recording: u64,
    recording_active: bool,
}

impl RemoteShortcuts {
    /// Replaces any earlier request: the member answers only the latest.
    pub fn propose(
        &mut self,
        action: Action,
        binding: Option<String>,
        origin: String,
        generation: u64,
    ) -> ShortcutRequest {
        self.next_request += 1;
        let request = ShortcutRequest {
            id: self.next_request,
            action,
            binding,
            origin,
            generation,
        };
        self.pending = Some(request.clone());
        request
    }

    /// The pending request the member answered, once. An answer to an older
    /// dialog leaves the newer request waiting; a request whose window has
    /// since been replaced is dropped.
    pub fn answer(&mut self, id: u64, generation: u64) -> Option<ShortcutRequest> {
        if self.pending.as_ref()?.id != id {
            return None;
        }
        let request = self.pending.take()?;
        (request.generation == generation).then_some(request)
    }

    pub fn discard(&mut self) {
        self.pending = None;
        self.recording_active = false;
    }

    /// Starts a remote recording and names it for its expiry.
    pub fn begin_recording(&mut self) -> u64 {
        self.recording += 1;
        self.recording_active = true;
        self.recording
    }

    pub fn end_recording(&mut self) {
        self.recording_active = false;
    }

    /// True once, when this recording is still the one running at its limit.
    pub fn expire_recording(&mut self, recording: u64) -> bool {
        let expired = self.recording_active && self.recording == recording;
        if expired {
            self.recording_active = false;
        }
        expired
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_latest_request_from_the_current_window_can_be_answered() {
        let mut requests = RemoteShortcuts::default();
        let first = requests.propose(Action::Mute, Some("KeyH".into()), "https://a".into(), 1);
        let second = requests.propose(Action::Mute, Some("KeyJ".into()), "https://a".into(), 1);
        // The dialog for the replaced request answers nothing.
        assert_eq!(requests.answer(first.id, 1), None);
        assert_eq!(requests.answer(second.id, 1), Some(second.clone()));
        // Answered once.
        assert_eq!(requests.answer(second.id, 1), None);
    }

    #[test]
    fn a_replaced_window_loses_its_pending_request() {
        let mut requests = RemoteShortcuts::default();
        let request = requests.propose(Action::Deafen, None, "https://a".into(), 1);
        assert_eq!(requests.answer(request.id, 2), None);
        let request = requests.propose(Action::Deafen, None, "https://a".into(), 2);
        requests.discard();
        assert_eq!(requests.answer(request.id, 2), None);
    }

    #[test]
    fn a_recording_expires_only_while_it_is_still_the_one_running() {
        let mut recordings = RemoteShortcuts::default();
        let first = recordings.begin_recording();
        recordings.end_recording();
        assert!(!recordings.expire_recording(first));
        let second = recordings.begin_recording();
        assert!(!recordings.expire_recording(first));
        assert!(recordings.expire_recording(second));
        assert!(!recordings.expire_recording(second));
        let third = recordings.begin_recording();
        recordings.discard();
        assert!(!recordings.expire_recording(third));
        assert_eq!(RECORDING_LIMIT.as_secs(), 15);
    }

    #[test]
    fn the_home_shell_receives_the_request_by_name_without_its_generation() {
        let mut requests = RemoteShortcuts::default();
        let request = requests.propose(
            Action::PushToTalk,
            Some("KeyV".into()),
            "https://chat.example.com".into(),
            7,
        );
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({
                "id": 1,
                "action": "pushToTalk",
                "binding": "KeyV",
                "origin": "https://chat.example.com"
            })
        );
        assert_eq!(parse_action("pushToMute"), Ok(Action::PushToMute));
        assert_eq!(parse_action("anything"), Err("shortcut_invalid"));
    }
}
