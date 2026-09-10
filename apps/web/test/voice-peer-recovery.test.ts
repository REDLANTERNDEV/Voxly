import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advancePeerRecovery,
  initialPeerRecoveryState,
  type PeerRecoveryState
} from "../src/lib/voicePeerRecovery.js";

describe("peer recovery state", () => {
  it("waits through a transient disconnected state", () => {
    const next = advancePeerRecovery(initialPeerRecoveryState(), { type: "disconnected" }, 1_000);
    assert.equal(next.state.phase, "grace");
    assert.equal(next.action, "wait");
  });

  it("requests one ICE restart after the grace deadline", () => {
    let current: PeerRecoveryState = advancePeerRecovery(initialPeerRecoveryState(), { type: "disconnected" }, 1_000).state;
    const next = advancePeerRecovery(current, { type: "grace_elapsed" }, 4_100);
    assert.equal(next.state.phase, "restarting");
    assert.equal(next.action, "restart_ice");
  });

  it("rebuilds a failed peer and backs off repeated failures starting at 0ms", () => {
    const next = advancePeerRecovery(initialPeerRecoveryState(), { type: "failed" }, 1_000);
    assert.equal(next.state.phase, "rebuilding");
    assert.equal(next.action, "rebuild_peer");
    assert.equal(next.state.nextRetryAt, 1_000); // 0ms delay on attempt 0

    const second = advancePeerRecovery(next.state, { type: "failed" }, 1_000);
    assert.equal(second.state.phase, "rebuilding");
    assert.equal(second.action, "rebuild_peer");
    assert.equal(second.state.nextRetryAt, 2_000); // 1000ms delay on attempt 1

    const third = advancePeerRecovery(second.state, { type: "failed" }, 2_000);
    assert.equal(third.state.phase, "rebuilding");
    assert.equal(third.state.nextRetryAt, 4_000); // 2000ms delay on attempt 2

    const fourth = advancePeerRecovery(third.state, { type: "failed" }, 4_000);
    assert.equal(fourth.state.phase, "rebuilding");
    assert.equal(fourth.state.nextRetryAt, 9_000); // 5000ms delay on attempt 3
  });

  it("transitions restart_failed to rebuilding with the next delay", () => {
    const restarting: PeerRecoveryState = { phase: "restarting", attempt: 0, nextRetryAt: null };
    const next = advancePeerRecovery(restarting, { type: "restart_failed" }, 1_000);
    assert.equal(next.state.phase, "rebuilding");
    assert.equal(next.action, "rebuild_peer");
    assert.equal(next.state.nextRetryAt, 1_000); // 0ms delay

    const nextFailure = advancePeerRecovery(next.state, { type: "restart_failed" }, 1_500);
    assert.equal(nextFailure.state.phase, "rebuilding");
    assert.equal(nextFailure.action, "rebuild_peer");
    assert.equal(nextFailure.state.nextRetryAt, 2_500); // 1000ms delay
  });

  it("transitions restart_succeeded to stable", () => {
    const restarting: PeerRecoveryState = { phase: "restarting", attempt: 2, nextRetryAt: null };
    const next = advancePeerRecovery(restarting, { type: "restart_succeeded" }, 1_000);
    assert.equal(next.state.phase, "stable");
    assert.equal(next.action, "cancel");
    assert.equal(next.state.attempt, 0);
  });

  it("cancels recovery when the peer becomes connected or leaves", () => {
    const disconnected = advancePeerRecovery(initialPeerRecoveryState(), { type: "disconnected" }, 1_000).state;
    const connected = advancePeerRecovery(disconnected, { type: "connected" }, 1_100);
    assert.equal(connected.state.phase, "stable");
    assert.equal(connected.action, "cancel");

    const leaving = advancePeerRecovery(disconnected, { type: "member_left" }, 1_200);
    assert.equal(leaving.state.phase, "idle");
    assert.equal(leaving.action, "cancel");
  });
});
