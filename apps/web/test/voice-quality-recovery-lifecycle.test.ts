import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { advancePeerRecovery, initialPeerRecoveryState, isPeerConnectionReady, voicePeerConnectionTimeoutMs, type PeerRecoveryState } from "../src/lib/voicePeerRecovery.js";

// Execute the hook's actual callbacks with controlled peer/timer boundaries.
// These tests cover the orchestration that state-machine-only tests missed.
function callback(name: string, dependencies: Record<string, unknown>) {
  const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
  const file = ts.createSourceFile("useVoiceMedia.ts", source, ts.ScriptTarget.Latest, true);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0].getText(file);
    }
    if (ts.isBinaryExpression(node) && node.left.getText(file) === name) expression = node.right.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(expression, `${name} must remain a callable hook boundary`);
  const compiled = ts.transpile(`const callback = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(dependencies), `${compiled}; return callback;`)(...Object.values(dependencies)) as (...args: unknown[]) => void;
}

function harness() {
  const peer = { connectionState: "connected", iceConnectionState: "connected" };
  const peersRef = { current: new Map<string, unknown>([["member", peer]]) };
  const peerRecoveryStatesRef = { current: new Map<string, PeerRecoveryState>() };
  const peerConnectionTimeoutsRef = { current: new Map<string, number>() };
  const timers = new Map<number, () => void>();
  let sequence = 0;
  let requests = 0;
  let rebuilds = 0;
  const mediaRequests: boolean[] = [];
  const dependencies = {
    voiceDiagnostics: { record: () => undefined },
    peersRef, peerRecoveryStatesRef, peerConnectionTimeoutsRef,
    peer, peerUserId: "member", peerGeneration: 1,
    peerRecoveryTimersRef: { current: new Map<string, number>() },
    ensurePeer: () => peer,
    advancePeerRecovery, initialPeerRecoveryState, voicePeerConnectionTimeoutMs,
    isPeerConnectionReady,
    peerGenerationsRef: { current: new Map([["member", 1]]) },
    isCurrentPeer: (id: string, expected: unknown) => peersRef.current.get(id) === expected,
    setPeerConnectionStates: () => undefined,
    requestPeerRecovery: (_id: string, _peer: unknown, recoverMedia = false) => {
      requests += 1; mediaRequests.push(recoverMedia); return true;
    },
    schedulePeerRecovery: () => { rebuilds += 1; },
    window: {
      setTimeout: (fn: () => void) => { timers.set(++sequence, fn); return sequence; },
      clearTimeout: (id: number) => { timers.delete(id); }
    }
  };
  return {
    peer, peersRef, peerRecoveryStatesRef, timers, dependencies, mediaRequests,
    recover: callback("recoverPeer", dependencies),
    get requests() { return requests; },
    get rebuilds() { return rebuilds; },
    expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }
  };
}

describe("connected peer audio recovery", () => {
  it("asks the remote sender to rebuild when an offerer's inbound audio stalls", () => {
    const peer = { restartIce: () => assert.fail("ICE restart cannot restore a stalled remote sender") };
    const signals: unknown[] = [];
    const request = callback("requestPeerRecovery", {
      socket: { emit: (_event: string, payload: unknown) => signals.push(payload) },
      roomRef: { current: "room" }, userIdRef: { current: "a" },
      peerGenerationsRef: { current: new Map([["b", 1]]) },
      isCurrentPeer: () => true,
      shouldInitiatePeerConnection: () => true,
      sendOffer: () => assert.fail("an ICE-only offer leaves the remote sender untouched"),
      schedulePeerRecoveryRef: { current: () => undefined }
    });
    request("b", peer, true);
    assert.deepEqual(signals, [{ roomId: "room", toUserId: "b", signal: { type: "recovery-request" } }]);
  });

  it("does not treat ICE connectivity as a completed media connection", () => {
    assert.equal(isPeerConnectionReady("connecting"), false);
    assert.equal(isPeerConnectionReady("connected"), true);
  });

  it("rebuilds a still-degraded connected peer when the recovery deadline expires", () => {
    const h = harness();
    h.recover("member", h.peer);
    h.recover("member", h.peer);
    assert.equal(h.requests, 1, "recovery remains single-flight");
    assert.deepEqual(h.mediaRequests, [true], "quality recovery requests fresh remote media");
    h.expire();
    assert.equal(h.rebuilds, 1, "connected transport is not proof of recovered audio");
  });

  it("finishes on clean audio without requiring an ICE state change and permits later recovery", () => {
    const h = harness();
    h.recover("member", h.peer);
    callback("confirmPeerAudioRecovered", h.dependencies)("member", h.peer);
    assert.equal(h.peerRecoveryStatesRef.current.get("member")?.phase, "stable");
    h.expire();
    assert.equal(h.rebuilds, 0);
    h.recover("member", h.peer);
    assert.equal(h.requests, 2);
  });

  it("ignores stale quality requests and clear readings after peer replacement", () => {
    const h = harness();
    h.peersRef.current.set("member", {});
    h.recover("member", h.peer);
    assert.equal(h.requests, 0);
    callback("confirmPeerAudioRecovered", h.dependencies)("member", h.peer);
    assert.equal(h.peerRecoveryStatesRef.current.size, 0);
  });

  it("ignores a recovery deadline after the peer leaves", () => {
    const h = harness();
    h.recover("member", h.peer);
    h.peersRef.current.delete("member");
    h.expire();
    assert.equal(h.rebuilds, 0);
  });
});

describe("recovery event ordering", () => {
  it("keeps the initial deadline alive when ICE wins the race with DTLS", () => {
    const h = harness();
    h.peer.connectionState = "connecting";
    h.dependencies.peerConnectionTimeoutsRef.current.set("member", 99);
    callback("peer.oniceconnectionstatechange", h.dependencies)();
    assert.equal(h.dependencies.peerConnectionTimeoutsRef.current.get("member"), 99);
  });

  for (const event of ["peer.onconnectionstatechange", "peer.oniceconnectionstatechange"]) {
    it(`keeps the audio deadline alive through ${event}`, () => {
      const h = harness();
      h.recover("member", h.peer);
      callback(event, h.dependencies)();
      assert.equal(h.peerRecoveryStatesRef.current.get("member")?.phase, "restarting");
      assert.equal(h.timers.size, 1);
      h.expire();
      assert.equal(h.rebuilds, 1);
    });
  }

  it("settles a connected remote transport request without waiting for local audio", () => {
    const h = harness();
    h.recover("member");
    assert.deepEqual(h.mediaRequests, [false], "transport recovery keeps the ICE path");
    callback("confirmPeerAudioRecovered", h.dependencies)("member", h.peer);
    assert.equal(h.peerRecoveryStatesRef.current.get("member")?.phase, "restarting");
    h.expire();
    assert.equal(h.rebuilds, 0);
    assert.equal(h.peerRecoveryStatesRef.current.get("member")?.phase, "stable");
    h.recover("member");
    assert.equal(h.requests, 2);
  });

  it("does not confirm audio recovery while transport is disconnected", () => {
    const h = harness();
    h.recover("member", h.peer);
    h.peer.connectionState = "disconnected";
    callback("confirmPeerAudioRecovered", h.dependencies)("member", h.peer);
    assert.equal(h.peerRecoveryStatesRef.current.get("member")?.phase, "restarting");
    h.expire();
    assert.equal(h.rebuilds, 1);
  });
});

describe("recovery cancellation", () => {
  it("a stale deadline cannot rebuild a replacement peer", () => {
    const h = harness();
    h.recover("member", h.peer);
    h.peersRef.current.set("member", {});
    h.expire();
    assert.equal(h.rebuilds, 0);
  });

  it("does not send a recovery request after the member leaves", () => {
    const h = harness();
    h.peersRef.current.delete("member");
    h.recover("member", h.peer);
    assert.equal(h.requests, 0);
    assert.equal(h.timers.size, 0);
  });
});

describe("initial negotiation and media instance lifecycle", () => {
  it("rebuilds an answerer when its remote listener requests media recovery", async () => {
    const peer = {};
    let rebuilds = 0;
    const handle = callback("handleSignal", {
      remoteMediaInstancesRef: { current: new Map() },
      ensurePeer: () => peer,
      peerGenerationsRef: { current: new Map([["a", 1]]) },
      isCurrentPeer: () => true,
      isRtcRecoveryRequest: (signal: { type: string }) => signal.type === "recovery-request",
      userIdRef: { current: "b" },
      shouldInitiatePeerConnection: (a: string, b: string) => a < b,
      schedulePeerRecovery: () => { rebuilds++; }
    });
    await handle({ fromUserId: "a", signal: { type: "recovery-request" } });
    assert.equal(rebuilds, 1);
  });

  it("offers a peer created by an early candidate exactly once", () => {
    const peer = {};
    const offeredPeersRef = { current: new Set<unknown>() };
    let offers = 0;
    const offer = callback("ensureInitialOffer", {
      userIdRef: { current: "a" }, offeredPeersRef,
      makingOfferPeersRef: { current: new Set() },
      shouldInitiatePeerConnection: (a: string, b: string) => a < b,
      sendOffer: async (_id: string, connection: unknown) => { offers++; offeredPeersRef.current.add(connection); },
      setError: () => assert.fail("unexpected offer error")
    });
    // The candidate handler already created this peer before the snapshot.
    offer("b", peer);
    offer("b", peer);
    assert.equal(offers, 1);
  });

  it("replaces the remote connection on reload, but not on repeated snapshots", () => {
    const peersRef = { current: new Map<string, object>([["member", {}]]) };
    const remoteMediaInstancesRef = { current: new Map([["member", "old"]]) };
    let removals = 0;
    let offers = 0;
    const apply = callback("applyVoiceSnapshot", {
      roomRef: { current: "room" }, userIdRef: { current: "self" },
      syncScreenRecoveryRef: { current: () => undefined },
      peersRef, remoteMediaInstancesRef,
      voiceSnapshotsRef: { current: {} },
      setVoiceSnapshots: () => undefined, setRemoteStreams: () => undefined,
      peerRecoveryTimersRef: { current: new Map() },
      activeVoiceMemberUserIdsRef: { current: new Set() },
      visualTargetsRef: { current: [] },
      staleVoicePeerUserIds: (tracked: Set<string>, active: Set<string>) => [...tracked].filter(id => !active.has(id)),
      removePeer: (id: string, options: { preserveVisualSubscriptions?: boolean }) => {
        assert.equal(options.preserveVisualSubscriptions, true);
        removals++; peersRef.current.delete(id);
      },
      ensurePeer: (id: string) => {
        if (!peersRef.current.has(id)) peersRef.current.set(id, {});
        return peersRef.current.get(id);
      },
      ensureInitialOffer: () => { offers++; }
    });
    const snapshot = (mediaInstanceId: string) => ({ roomId: "room", viewerInVoiceRoom: true, members: [
      { user: { userId: "member" }, media: {}, mediaInstanceId }
    ] });
    apply(snapshot("old"));
    assert.equal(removals, 0);
    const old = peersRef.current.get("member");
    apply(snapshot("new"));
    assert.equal(removals, 1);
    assert.notEqual(peersRef.current.get("member"), old);
    apply(snapshot("new"));
    assert.equal(removals, 1);
    assert.equal(offers, 3);
  });

  it("discards signals from a replaced media instance before touching a peer", async () => {
    const handle = callback("handleSignal", {
      remoteMediaInstancesRef: { current: new Map([["member", "new"]]) },
      ensurePeer: () => assert.fail("stale signal must not touch the replacement")
    });
    await handle({ fromUserId: "member", mediaInstanceId: "old", signal: { type: "offer", sdp: "stale" } });
  });
});
