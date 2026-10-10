import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPendingMediaOperation } from "../src/lib/pendingMediaOperation.js";
import { createPendingCaptures, desktopCallState, subscribeDesktopCallState } from "../src/lib/desktopCallState.js";

const idle = () => desktopCallState({ inVoice: false, streams: {}, pendingJoin: false, pendingCapture: false });
const stream = (...tracks: { kind: string; readyState: string; enabled: boolean }[]) => ({
  getTracks: () => tracks as MediaStreamTrack[]
});

describe("desktop media state sampling", () => {
  it("reports effective publication separately from retained capture", () => {
    const muted = { kind: "audio", readyState: "live", enabled: false };
    const state = desktopCallState({
      inVoice: true,
      streams: {
        mic: stream(muted),
        camera: stream({ kind: "video", readyState: "ended", enabled: true }),
        screen: stream(
          { kind: "video", readyState: "live", enabled: true },
          { kind: "audio", readyState: "live", enabled: true }
        )
      },
      pendingJoin: false,
      pendingCapture: false
    });
    assert.equal(state.microphone, false);
    assert.equal(state.capture, true);
    assert.equal(state.camera, false);
    assert.equal(state.screen, true);
    assert.equal(state.computerAudio, true);
    muted.enabled = true;
    assert.equal(
      desktopCallState({ inVoice: true, streams: { mic: stream(muted) }, pendingJoin: false, pendingCapture: false })
        .microphone,
      true
    );
    assert.equal(idle().capture, false);
  });
  it("retains receive-only membership and pending join state with no tracks", () => {
    assert.equal(
      desktopCallState({ inVoice: true, streams: {}, pendingJoin: false, pendingCapture: false }).inVoice,
      true
    );
    assert.equal(
      desktopCallState({ inVoice: false, streams: {}, pendingJoin: true, pendingCapture: false }).pendingJoin,
      true
    );
  });
  it("counts concurrent captures until all settle, including rejected requests", async () => {
    const pending = createPendingCaptures();
    let resolve!: () => void;
    const first = pending.run(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    assert.equal(pending.isPending(), true);
    await assert.rejects(
      pending.run(async () => {
        throw new Error("permission");
      })
    );
    assert.equal(pending.isPending(), true);
    resolve();
    await first;
    assert.equal(pending.isPending(), false);
  });
  it("keeps cancelled joins busy until retained capture/acknowledgement work settles", async () => {
    const captures = createPendingCaptures();
    const join = createPendingMediaOperation(() => {});
    let finish!: () => void;
    const attempt = join.run(() =>
      captures.run(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      )
    );
    join.cancel();
    assert.equal(join.isPending(), false);
    assert.equal(captures.isPending(), true);
    finish();
    await attempt;
    assert.equal(captures.isPending(), false);
  });
  it("degrades older shells normally and samples the provider on demand", () => {
    subscribeDesktopCallState({}, idle)();
    let samples = 0;
    let provider!: () => ReturnType<typeof idle>;
    const release = subscribeDesktopCallState(
      {
        __VOXLY_DESKTOP_STATE_V1__: {
          version: 1,
          subscribe: (next) => {
            provider = next;
            return () => {
              samples = -1;
            };
          }
        }
      },
      () => {
        samples++;
        return idle();
      }
    );
    assert.equal(samples, 0);
    provider();
    assert.equal(samples, 1);
    release();
    assert.equal(samples, -1);
  });
});
