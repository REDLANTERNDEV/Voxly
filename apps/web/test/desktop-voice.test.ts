import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesktopDeafenReceiver, createDesktopMuteReceiver, desktopDeafenAllowed, desktopMuteAllowed, readDesktopMicrophoneState, subscribeDesktopDeafen, subscribeDesktopMicrophone, subscribeDesktopMute, type DesktopVoiceBridge } from "../src/lib/desktopVoice.js";

const ready = { inVoice: true, connected: true, liveMicrophone: true, deafened: false, ownerMuted: false, ownerDeafened: false, roomLocked: false };

describe("desktop microphone intent", () => {
  it("defaults old shells and browsers to open mic and validates microphone mode events", () => {
    const fallback = { mode: "openMic", talkHeld: false, muteHeld: false };
    assert.deepEqual(readDesktopMicrophoneState({}), fallback);
    subscribeDesktopMicrophone({}, () => assert.fail("browser has no native shortcut"))();
    const state = { mode: "pushToTalk" as const, talkHeld: false, muteHeld: false };
    const shell = { __VOXLY_DESKTOP_V1__: {
      version: 1, subscribeMute: () => () => {}, getMicrophoneState: () => state,
      subscribeMicrophone(handler) {
        handler({ ...state, mode: "bad" } as unknown as typeof state);
        handler(state);
        return () => {};
      }
    } satisfies DesktopVoiceBridge };
    assert.deepEqual(readDesktopMicrophoneState(shell), state);
    let calls = 0;
    subscribeDesktopMicrophone(shell, () => { calls++; })();
    assert.equal(calls, 1);
  });
  it("allows receive-only deafen but preserves owner and microphone-test locks", () => {
    const available = { inVoice: true, connected: true, ownerDeafened: false, microphoneTest: false };
    assert.equal(desktopDeafenAllowed(available), true);
    for (const key of ["inVoice", "connected"] as const) assert.equal(desktopDeafenAllowed({ ...available, [key]: false }), false);
    for (const key of ["ownerDeafened", "microphoneTest"] as const) assert.equal(desktopDeafenAllowed({ ...available, [key]: true }), false);
    let calls = 0;
    let state = available;
    const receive = createDesktopDeafenReceiver(() => state, async () => { calls++; return true; });
    receive(); receive();
    assert.equal(calls, 2, "rapid presses must read the existing live control, not wait for an ACK");
    state = { ...available, microphoneTest: true };
    receive();
    assert.equal(calls, 2);
  });

  it("keeps mute working on old shells without the additive deafen subscription", () => {
    let muteCalls = 0;
    const oldShell = { __VOXLY_DESKTOP_V1__: { version: 1, subscribeMute(handler) { handler(); return () => {}; } } satisfies DesktopVoiceBridge };
    subscribeDesktopDeafen(oldShell, () => assert.fail("old shell cannot deafen"))();
    subscribeDesktopMute(oldShell, () => { muteCalls++; })();
    assert.equal(muteCalls, 1);
    let handler: (() => void) | null = null;
    const newShell = { __VOXLY_DESKTOP_V1__: { ...oldShell.__VOXLY_DESKTOP_V1__, subscribeDeafen(next: () => void) {
      handler = next; return () => { handler = null; };
    } } };
    const stop = subscribeDesktopDeafen(newShell, () => { muteCalls++; });
    const send = () => handler?.();
    send(); stop(); send();
    assert.equal(muteCalls, 2);
  });

  it("uses a live call and preserves deafen, moderation, and room locks", () => {
    assert.equal(desktopMuteAllowed(ready), true);
    for (const key of ["inVoice", "connected", "liveMicrophone"] as const) {
      assert.equal(desktopMuteAllowed({ ...ready, [key]: false }), false, key);
    }
    for (const key of ["deafened", "ownerMuted", "ownerDeafened", "roomLocked"] as const) {
      assert.equal(desktopMuteAllowed({ ...ready, [key]: true }), false, key);
    }
  });

  it("does nothing in ordinary browsers and rejects incompatible bridge versions", () => {
    subscribeDesktopMute({}, () => assert.fail("browser cannot trigger"))();
    const incompatible = { version: 2, subscribeMute: () => assert.fail("unsupported bridge cannot subscribe") } as unknown as DesktopVoiceBridge;
    subscribeDesktopMute({ __VOXLY_DESKTOP_V1__: incompatible }, () => {})();
  });

  it("keeps a second quick press while the first server ack is pending", async () => {
    let state = { ...ready };
    let actions = 0;
    const releases: Array<() => void> = [];
    const receive = createDesktopMuteReceiver(() => state, () => {
      actions += 1;
      return new Promise<void>((resolve) => { releases.push(resolve); });
    });
    receive(); receive();
    await Promise.resolve();
    assert.equal(actions, 2, "each physical press must toggle without waiting for server replies");
    releases.splice(0).forEach((release) => release());
    state = { ...ready, inVoice: false };
    receive();
    await Promise.resolve();
    assert.equal(actions, 2);
    state = { ...ready };
    receive();
    await Promise.resolve();
    assert.equal(actions, 3);
    releases.shift()?.();
  });

  it("unsubscribes the receiver when the voice integration is disposed", () => {
    let receiver: (() => void) | null = null;
    const target = { __VOXLY_DESKTOP_V1__: { version: 1, subscribeMute(handler) {
      receiver = handler;
      return () => { receiver = null; };
    } } satisfies DesktopVoiceBridge };
    let calls = 0;
    const unsubscribe = subscribeDesktopMute(target, () => { calls += 1; });
    const dispatch = () => receiver?.();
    dispatch(); unsubscribe(); dispatch();
    assert.equal(calls, 1);
  });
});
