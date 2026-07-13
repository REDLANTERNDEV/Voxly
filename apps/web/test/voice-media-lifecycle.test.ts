import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as appModule from "../src/App.js";

describe("voice snapshot reconciliation", () => {
  it("navigates away from the access claim route after authentication", () => {
    const source = readFileSync("src/App.tsx", "utf8");

    assert.match(source, /const completeAuthentication = useCallback\([\s\S]*?authRequestGateRef\.current\.invalidate\(\)[\s\S]*?setUser\(nextUser\)[\s\S]*?setAuthState\("ready"\)/);
    assert.match(source, /const authenticatedUserIdRef = useRef<string \| null>\(null\)/);
    assert.match(source, /if \(authenticatedUserIdRef\.current !== nextUser\.id\) setRtcConfigReady\(false\)[\s\S]*?authenticatedUserIdRef\.current = nextUser\.id[\s\S]*?\}, \[\]\)/);
    assert.match(source, /fetchMe\(\)[\s\S]*?authenticatedUserIdRef\.current = response\.user\.id[\s\S]*?setUser\(response\.user\)/);
    assert.match(source, /const requestGeneration = authRequestGateRef\.current\.begin\(\)[\s\S]*?authRequestGateRef\.current\.isCurrent\(requestGeneration\)/);
    assert.match(source, /const handleAccessClaimed = useCallback\([\s\S]*?completeAuthentication\(claimedUser\)[\s\S]*?firstServerRoomPath\(serverId, roomResponse\.rooms\)/);
    assert.match(source, /<AccessClaimScreen[\s\S]*?onClaimed=\{handleAccessClaimed\}/);
  });

  it("does not reserve a blank stage status row", () => {
    const source = readFileSync("src/App.tsx", "utf8");

    assert.match(source, /\{stageStatus \? <p className="voice-stage-status" aria-live="polite">\{stageStatus\}<\/p> : null\}/);
  });

  it("unlocks audio playback synchronously before starting voice join", async () => {
    const joinVoiceWithAudioUnlock = (appModule as Record<string, unknown>).joinVoiceWithAudioUnlock;
    const events: string[] = [];

    assert.equal(typeof joinVoiceWithAudioUnlock, "function");
    await (joinVoiceWithAudioUnlock as (
      roomId: string,
      unlock: () => void,
      release: () => void,
      join: (roomId: string) => Promise<boolean>
    ) => Promise<void>)("voice-room", () => events.push("unlock"), () => events.push("release"), async (roomId) => {
      events.push(`join:${roomId}`);
      return true;
    });

    assert.deepEqual(events, ["unlock", "join:voice-room"]);
  });

  it("releases unused audio playback after a failed voice join", async () => {
    const joinVoiceWithAudioUnlock = (appModule as Record<string, unknown>).joinVoiceWithAudioUnlock;
    const events: string[] = [];

    assert.equal(typeof joinVoiceWithAudioUnlock, "function");
    await (joinVoiceWithAudioUnlock as (
      roomId: string,
      unlock: () => void,
      release: () => void,
      join: (roomId: string) => Promise<boolean>
    ) => Promise<void>)("voice-room", () => events.push("unlock"), () => events.push("release"), async () => {
      events.push("join");
      return false;
    });

    assert.deepEqual(events, ["unlock", "join", "release"]);
  });

  it("releases unused audio playback in the canonical voice leave path", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const leave = source.match(/const leave = useCallback\(\(\) => \{[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    assert.match(leave, /releaseUnusedSharedAudioOutput\(\)/);
  });

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

  it("keeps the native remote audio element mounted as the only hardware sink", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const remoteAudio = source.match(/function RemoteAudio[\s\S]*?\n}\n\nfunction GlobalVoiceAudio/)?.[0] ?? "";

    assert.match(remoteAudio, /connectAudioOutput\(audio, stream, \{ muted, volume \}\)/);
    assert.doesNotMatch(remoteAudio, /if \(!useFallback\) return null/);
    assert.match(remoteAudio, /return <audio[^>]*ref=\{audioRef\}/);
  });

  it("exposes a retry action only when native audio playback is blocked", () => {
    const source = readFileSync("src/App.tsx", "utf8");

    assert.match(source, /subscribeBlockedAudioOutputs/);
    assert.match(source, /retryBlockedAudioOutputs/);
    assert.match(source, /audioPlaybackBlocked/);
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
