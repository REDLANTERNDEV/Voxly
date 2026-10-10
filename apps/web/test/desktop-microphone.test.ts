import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DesktopMicrophoneGate } from "../src/lib/desktopMicrophone.js";

describe("desktop microphone hold modes", () => {
  it("keeps a granted talk tail audible until native expiry and never grants one from idle", () => {
    const gate = new DesktopMicrophoneGate("pushToTalk");
    const track = { enabled: false, readyState: "live" as const };
    const state = { mode: "pushToTalk" as const, talkHeld: false, muteHeld: false, talkReleasing: true };
    gate.apply([track], true);
    gate.update(state, true);
    assert.equal(track.enabled, false);
    gate.update({ ...state, talkHeld: true, talkReleasing: false }, true);
    assert.equal(track.enabled, true);
    gate.update(state, true);
    assert.equal(track.enabled, true);
    gate.update({ ...state, talkReleasing: false }, true);
    assert.equal(track.enabled, false);
  });

  it("cancels delayed talk on mute/locks/leave and never restores a cancelled tail", () => {
    for (const cancel of ["lock", "suspend", "reset"] as const) {
      const gate = new DesktopMicrophoneGate("pushToTalk");
      const track = { enabled: false, readyState: "live" as const };
      const state = { mode: "pushToTalk" as const, talkHeld: false, muteHeld: false, talkReleasing: true };
      gate.apply([track], true);
      gate.update({ ...state, talkHeld: true, talkReleasing: false }, true);
      gate.update(state, true);
      if (cancel === "lock") gate.update(state, false);
      else if (cancel === "suspend") gate.suspend();
      else {
        gate.resetHolds();
        gate.apply([track], true);
      }
      assert.equal(track.enabled, false);
      gate.update(state, true);
      gate.apply([track], true);
      assert.equal(track.enabled, false, "a cancelled tail cannot become a fresh press");
    }
  });
  it("cuts push-to-talk immediately on release without waiting for an acknowledgement", () => {
    const gate = new DesktopMicrophoneGate("pushToTalk");
    const track = { enabled: true, readyState: "live" as MediaStreamTrackState };
    gate.apply([track], true);
    assert.equal(track.enabled, false);
    gate.update({ mode: "pushToTalk", talkHeld: true, muteHeld: false }, true);
    gate.apply([track], true);
    assert.equal(track.enabled, true);
    gate.update({ mode: "pushToTalk", talkHeld: false, muteHeld: false }, true);
    gate.apply([track], true);
    assert.equal(track.enabled, false);
    gate.apply([track], true); // A stale unmute acknowledgement cannot open the gate.
    assert.equal(track.enabled, false);
  });

  it("push-to-mute restores an enabled microphone but preserves manual mute and ended tracks", () => {
    const gate = new DesktopMicrophoneGate("pushToMute");
    const live = { enabled: false, readyState: "live" as MediaStreamTrackState };
    const ended = { enabled: false, readyState: "ended" as MediaStreamTrackState };
    gate.apply([live, ended], true);
    assert.equal(live.enabled, true);
    assert.equal(ended.enabled, false);
    gate.update({ mode: "pushToMute", talkHeld: false, muteHeld: true }, true);
    gate.apply([live], true);
    assert.equal(live.enabled, false);
    gate.resetHolds();
    gate.apply([live], true);
    assert.equal(live.enabled, false, "a room/reconnect transition cannot cancel held mute");
    gate.update({ mode: "pushToMute", talkHeld: false, muteHeld: false }, true);
    gate.apply([live], false);
    assert.equal(live.enabled, false, "self mute remains off after release");
    gate.apply([live], true);
    assert.equal(live.enabled, true);
  });

  it("requires a new press after a lock, room change, or disconnected session", () => {
    const gate = new DesktopMicrophoneGate("pushToTalk");
    const state = { mode: "pushToTalk" as const, talkHeld: true, muteHeld: false };
    gate.update(state, false);
    assert.equal(gate.allows(), false);
    gate.update(state, true);
    assert.equal(gate.allows(), false, "held key cannot become a new press after unlock");
    gate.update({ ...state, talkHeld: false }, true);
    gate.update(state, true);
    assert.equal(gate.allows(), true);
    gate.resetHolds();
    assert.equal(gate.allows(), false);
    gate.update(state, true);
    assert.equal(gate.allows(), false);
  });

  it("preserves microphone intent while the hold gate is closed and never opens a capture", () => {
    const gate = new DesktopMicrophoneGate("pushToTalk");
    assert.equal(gate.acceptedControl(false, true), true);
    assert.equal(gate.acceptedControl(false, false), false);
    gate.update({ mode: "pushToTalk", talkHeld: true, muteHeld: false }, true);
    assert.equal(gate.acceptedControl(false, true), true, "a delayed idle reply cannot mute a new hold");
    gate.apply([], true);
    gate.update({ mode: "openMic", talkHeld: false, muteHeld: false }, true);
    assert.equal(gate.acceptedControl(false, true), false, "open mic still honors server normalization");
  });

  it("closes both old and replacement publication tracks when release races a device switch", () => {
    const gate = new DesktopMicrophoneGate("pushToTalk");
    const oldTrack = { enabled: false, readyState: "live" as MediaStreamTrackState };
    const replacement = { ...oldTrack };
    gate.update({ mode: "pushToTalk", talkHeld: true, muteHeld: false }, true);
    gate.apply([oldTrack, replacement], true);
    assert.equal(replacement.enabled, true);
    gate.update({ mode: "pushToTalk", talkHeld: false, muteHeld: false }, true);
    assert.equal(oldTrack.enabled, false);
    assert.equal(replacement.enabled, false);
    gate.forget([oldTrack]);
    gate.update({ mode: "pushToTalk", talkHeld: true, muteHeld: false }, true);
    assert.equal(oldTrack.enabled, false);
    assert.equal(replacement.enabled, true);
    gate.suspend();
    assert.equal(replacement.enabled, false);
  });
});
