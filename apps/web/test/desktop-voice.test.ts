import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesktopMuteReceiver, desktopMuteAllowed, subscribeDesktopMute, type DesktopVoiceBridge } from "../src/lib/desktopVoice.js";

const ready = { inVoice: true, connected: true, liveMicrophone: true, deafened: false, ownerMuted: false, ownerDeafened: false, roomLocked: false };

describe("desktop microphone intent", () => {
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
