import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as appModule from "../src/App.js";

describe("voice snapshot reconciliation", () => {
  it("keeps one voice-audio sibling mounted for every authenticated surface", () => {
    type SurfaceProps = { audio: ReactNode; children: ReactNode };
    const Surface = (appModule as unknown as { AuthenticatedAppSurface?: ComponentType<SurfaceProps> }).AuthenticatedAppSurface;

    assert.equal(typeof Surface, "function");
    for (const route of ["text", "voice", "owner", "invite"]) {
      const html = renderToStaticMarkup(createElement(Surface as ComponentType<SurfaceProps>, {
        audio: createElement("audio", { "data-voice-runtime": "true" }),
        children: createElement("main", { "data-route": route })
      }));
      assert.match(html, /data-voice-runtime="true"/);
      assert.match(html, new RegExp(`data-route="${route}"`));
    }
  });

  it("runs peer reconciliation for acknowledged and pushed snapshots", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const acknowledgedSnapshots = source.match(/socket\.emit\("voice:snapshot"[\s\S]{0,240}applyVoiceSnapshot\(nextSnapshot\)/g) ?? [];

    assert.equal(acknowledgedSnapshots.length, 2);
    assert.match(source, /const onSnapshot = \(nextSnapshot: VoiceSnapshot\) => applyVoiceSnapshot\(nextSnapshot\)/);
  });

  it("closes stale media peers when signaling disconnects", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /const onDisconnect = \(\) => \{[\s\S]{0,900}closePeers\(\)/);
  });

  it("cancels failed-peer recovery after an authoritative member leave", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /activeVoiceMemberUserIdsRef\.current = activeMemberUserIds/);
    assert.match(source, /\.\.\.peerRecoveryTimersRef\.current\.keys\(\)/);
    assert.match(source, /if \(!activeVoiceMemberUserIdsRef\.current\.has\(peerUserId\)\) return/);
  });

  it("preserves visual subscriptions during transient peer recovery", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /removePeer\(peerUserId, \{ expectedPeer: peer, preserveVisualSubscriptions: true \}\)/);
  });

  it("rejoins the active voice room before requesting reconnect snapshots", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const onConnect = source.match(/const onConnect = \(\) => \{([\s\S]*?)\n    \};\n    const onDisconnect/)?.[1] ?? "";

    const joinIndex = onConnect.indexOf('socket.emit("voice:join", activeRoomId)');
    const snapshotIndex = onConnect.indexOf("requestKnownSnapshots()");
    assert.notEqual(joinIndex, -1);
    assert.notEqual(snapshotIndex, -1);
    assert.ok(joinIndex < snapshotIndex);
  });

  it("does not treat a microphone selection as a socket reconnect", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const join = source.match(/const join = useCallback[\s\S]*?\n  }, \[([^\]]*)\]\);/) ?? [];

    assert.match(source, /const microphoneDeviceIdRef = useRef\(microphoneDeviceId\)/);
    assert.match(join[0] ?? "", /buildMicrophoneConstraints\(microphoneDeviceIdRef\.current\)/);
    assert.doesNotMatch(join[1] ?? "", /\bmicrophoneDeviceId\b/);
  });

  it("applies refreshed ICE servers to active peer connections", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /const iceServersRef = useRef\(iceServers\)/);
    assert.match(source, /new RTCPeerConnection\(\{ iceServers: iceServersRef\.current \}\)/);
    assert.match(source, /peer\.setConfiguration\(\{ iceServers \}\)/);
    assert.match(source, /peer\.restartIce\(\)/);
  });

  it("invalidates an in-flight local offer before accepting a colliding offer", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /const offerGenerationsRef = useRef<Map<string, number>>/);
    assert.match(source, /offerGenerationsRef\.current\.get\(peerUserId\) !== offerGeneration/);
    assert.match(source, /shouldIgnoreIncomingOffer\([\s\S]{0,180}makingOfferPeersRef\.current\.has/);
  });
});
