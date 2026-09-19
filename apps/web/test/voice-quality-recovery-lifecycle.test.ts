import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { advancePeerRecovery, initialPeerRecoveryState, voicePeerConnectionTimeoutMs, type PeerRecoveryState } from "../src/lib/voicePeerRecovery.js";

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
  const dependencies = {
    peersRef, peerRecoveryStatesRef, peerConnectionTimeoutsRef,
    peer, peerUserId: "member", peerGeneration: 1,
    peerRecoveryTimersRef: { current: new Map<string, number>() },
    ensurePeer: () => peer,
    advancePeerRecovery, initialPeerRecoveryState, voicePeerConnectionTimeoutMs,
    peerGenerationsRef: { current: new Map([["member", 1]]) },
    isCurrentPeer: (id: string, expected: unknown) => peersRef.current.get(id) === expected,
    setPeerConnectionStates: () => undefined,
    requestPeerRecovery: () => { requests += 1; return true; },
    schedulePeerRecovery: () => { rebuilds += 1; },
    window: {
      setTimeout: (fn: () => void) => { timers.set(++sequence, fn); return sequence; },
      clearTimeout: (id: number) => { timers.delete(id); }
    }
  };
  return {
    peer, peersRef, peerRecoveryStatesRef, timers, dependencies,
    recover: callback("recoverPeer", dependencies),
    get requests() { return requests; },
    get rebuilds() { return rebuilds; },
    expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }
  };
}

describe("connected peer audio recovery", () => {
  it("rebuilds a still-degraded connected peer when the recovery deadline expires", () => {
    const h = harness();
    h.recover("member", h.peer);
    h.recover("member", h.peer);
    assert.equal(h.requests, 1, "recovery remains single-flight");
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
