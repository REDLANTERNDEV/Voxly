//! One user-selected JSON export; no remote path or general download authority.
use super::trust::report_caller_matches;
use super::Shell;
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

static SAVING: AtomicBool = AtomicBool::new(false);
struct SaveLease;
impl Drop for SaveLease {
    fn drop(&mut self) {
        SAVING.store(false, Ordering::Release);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    version: u8,
    calls: Vec<Call>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Call {
    started_at: String,
    samples: Vec<Measurement>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Measurement {
    at_ms: f64,
    event: String,
    peer: Option<u64>,
    data: Value,
}

fn safe_data(value: &Value, depth: usize) -> bool {
    if depth > 6 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(text) => matches!(
            text.as_str(),
            "new"
                | "connecting"
                | "connected"
                | "disconnected"
                | "failed"
                | "closed"
                | "checking"
                | "completed"
                | "stable"
                | "have-local-offer"
                | "have-remote-offer"
                | "have-local-pranswer"
                | "have-remote-pranswer"
                | "running"
                | "suspended"
                | "interrupted"
                | "host"
                | "srflx"
                | "prflx"
                | "relay"
                | "frozen"
                | "waiting"
                | "in-progress"
                | "succeeded"
                | "inbound-rtp"
                | "outbound-rtp"
                | "remote-inbound-rtp"
                | "media-source"
                | "quality"
                | "transport"
        ),
        Value::Array(items) => {
            items.len() <= 100 && items.iter().all(|item| safe_data(item, depth + 1))
        }
        Value::Object(fields) => {
            fields.len() <= 64
                && fields.iter().all(|(key, value)| {
                    matches!(
                        key.as_str(),
                        "connection"
                            | "ice"
                            | "signaling"
                            | "expectingAudio"
                            | "transport"
                            | "audio"
                            | "rttMs"
                            | "candidateType"
                            | "candidatePairState"
                            | "type"
                            | "reason"
                            | "microphone"
                            | "output"
                            | "contextState"
                            | "sampleRate"
                            | "inputRms"
                            | "suppression"
                            | "worklet"
                            | "trackLive"
                            | "trackEnabled"
                            | "outputs"
                            | "paused"
                            | "muted"
                            | "volume"
                            | "readyState"
                            | "errorCode"
                            | "nativePlaybackBlocked"
                            | "blockedCount"
                            | "packetsReceived"
                            | "packetsSent"
                            | "packetsLost"
                            | "bytesReceived"
                            | "bytesSent"
                            | "jitter"
                            | "concealedSamples"
                            | "silentConcealedSamples"
                            | "concealmentEvents"
                            | "totalSamplesReceived"
                            | "jitterBufferDelay"
                            | "jitterBufferEmittedCount"
                            | "jitterBufferTargetDelay"
                            | "insertedSamplesForDeceleration"
                            | "removedSamplesForAcceleration"
                            | "audioLevel"
                            | "totalAudioEnergy"
                            | "totalSamplesDuration"
                            | "roundTripTime"
                    ) && safe_data(value, depth + 1)
                })
        }
    }
}

fn validate_report(report: &str) -> Result<(), &'static str> {
    if report.len() > 8 * 1024 * 1024 {
        return Err("invalid_report");
    }
    let parsed: Report = serde_json::from_str(report).map_err(|_| "invalid_report")?;
    if parsed.version != 1 || parsed.calls.len() > 3 {
        return Err("invalid_report");
    }
    for call in parsed.calls {
        if call.started_at.len() != 24
            || !call
                .started_at
                .bytes()
                .all(|c| c.is_ascii_digit() || b"-T:.Z".contains(&c))
            || call.samples.len() > 500
        {
            return Err("invalid_report");
        }
        for sample in call.samples {
            if !sample.at_ms.is_finite()
                || sample.at_ms < 0.0
                || sample.peer == Some(0)
                || !matches!(
                    sample.event.as_str(),
                    "sample" | "input-output" | "recovery" | "leave"
                )
                || !safe_data(&sample.data, 0)
            {
                return Err("invalid_report");
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn save_voice_diagnostics(
    app: tauri::AppHandle,
    window: WebviewWindow,
    shell: tauri::State<'_, Shell>,
    report: String,
) -> Result<&'static str, &'static str> {
    let generation = shell.voice_generation.load(Ordering::Acquire);
    let original_url = window.url().map_err(|_| "forbidden")?;
    {
        let inner = shell.inner.lock().await;
        let active = inner.active.as_ref().ok_or("forbidden")?;
        if !report_caller_matches(generation, window.label(), &active.origin, &original_url) {
            return Err("forbidden");
        }
    }
    validate_report(&report)?;
    if SAVING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("save_in_progress");
    }
    let _lease = SaveLease;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name("voxly-voice-diagnostics.json")
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let path = receiver.await.map_err(|_| "save_failed")?;
    let Some(path) = path else {
        return Ok("cancelled");
    };
    let path = path.into_path().map_err(|_| "save_failed")?;
    let inner = shell.inner.lock().await;
    let active = inner.active.as_ref().ok_or("forbidden")?;
    let current_generation = shell.voice_generation.load(Ordering::Acquire);
    let current_url = window.url().map_err(|_| "forbidden")?;
    if current_generation != generation
        || current_url != original_url
        || !report_caller_matches(
            current_generation,
            window.label(),
            &active.origin,
            &current_url,
        )
    {
        return Err("forbidden");
    }
    std::fs::write(path, report).map_err(|_| "save_failed")?;
    Ok("saved")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_anonymous_measurements_are_exportable() {
        let report = serde_json::json!({"version": 1, "calls": [{"startedAt": "2026-10-03T00:00:00.000Z", "samples": [{"atMs": 1, "event": "input-output", "data": {"microphone": {"contextState": "running", "inputRms": 0}, "output": {"blockedCount": 0}}}]}]});
        assert!(validate_report(&report.to_string()).is_ok());
        for bad in [
            serde_json::json!({"version": 2, "calls": []}),
            serde_json::json!({"version": 1, "calls": [], "path": "/tmp/file"}),
        ] {
            assert!(validate_report(&bad.to_string()).is_err());
        }
        for data in [
            serde_json::json!({"deviceId": "secret"}),
            serde_json::json!({"audio": "recording"}),
            serde_json::json!({"transport": {"address": "127.0.0.1"}}),
        ] {
            let mut bad = report.clone();
            bad["calls"][0]["samples"][0]["data"] = data;
            assert!(validate_report(&bad.to_string()).is_err());
        }
        assert!(validate_report(&" ".repeat(8 * 1024 * 1024 + 1)).is_err());
    }
}
