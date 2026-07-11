import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RtcConfigResponse } from "../src/types.js";
import * as appModule from "../src/App.js";

describe("RTC configuration recovery", () => {
  it("uses public STUN only before a successful authenticated configuration", () => {
    const recover = (appModule as unknown as {
      rtcConfigAfterFetchFailure?: (current: RtcConfigResponse, hasSuccessfulConfig: boolean) => RtcConfigResponse;
    }).rtcConfigAfterFetchFailure;
    const empty: RtcConfigResponse = { iceServers: [], expiresAt: null };
    const workingTurn: RtcConfigResponse = {
      iceServers: [{ urls: "turn:turn.voxly.example:3478", username: "user", credential: "credential" }],
      expiresAt: 1_700_003_600
    };

    assert.equal(typeof recover, "function");
    assert.deepEqual(recover?.(empty, false), {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      expiresAt: null
    });
    assert.equal(recover?.(workingTurn, true), workingTurn);
  });
});
