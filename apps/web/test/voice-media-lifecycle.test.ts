import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as appModule from "../src/App.js";

describe("voice snapshot reconciliation", () => {
  it("moves a LIVE card selection into voice without a second confirmation", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const voiceRoom = source.match(/function VoiceRoomScreen[\s\S]*?\n}\n\nfunction OwnerPanel/)?.[0] ?? "";

    assert.match(voiceRoom, /liveWatchAttemptRef/);
    assert.match(voiceRoom, /microphoneEnabled:\s*true/);
    assert.doesNotMatch(voiceRoom, /onClick=\{joinAndWatchLive\}/);
  });

  it("supports receive-only joins and lazily opens the microphone", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /interface VoiceJoinOptions[\s\S]*?microphoneEnabled\?: boolean/);
    assert.match(source, /options\.microphoneEnabled\s*\?\?\s*true/);
    assert.match(source, /if \(!stream\)[\s\S]*?getUserMedia[\s\S]*?renegotiatePeers\(\)/);
    assert.match(source, /record\.microphoneEnabled/);
  });
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

  it("keeps focused screen-share audio audible while participant audio is deafened", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const globalVoiceAudio = source.match(/function GlobalVoiceAudio[\s\S]*?\n}\n\nfunction VisualStage/)?.[0] ?? "";
    const visualStage = source.match(/function VisualStage[\s\S]*?\n}\n\nfunction StatusPill/)?.[0] ?? "";
    const voiceRoom = source.match(/function VoiceRoomScreen[\s\S]*?\n}\n\nfunction OwnerPanel/)?.[0] ?? "";

    assert.match(globalVoiceAudio, /<RemoteAudio[\s\S]*?muted=\{muted \|\| mutedUserIds\.has\(item\.userId\)\}/);
    assert.match(visualStage, /<RemoteAudio stream=\{focusedStream\} muted=\{false\}/);
    assert.doesNotMatch(visualStage, /^\s*muted:\s*boolean;/m);
    assert.doesNotMatch(voiceRoom, /<VisualStage[\s\S]*?muted=\{props\.controls\.deafen\.on\}/);
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

  it("rejoins with effective media before requesting reconnect snapshots", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const recovery = source.match(/const attemptRecovery = async \(\) => \{([\s\S]*?)\n    \};\n    const onConnect/)?.[1] ?? "";

    const effectiveStateIndex = recovery.indexOf("effectiveVoiceMediaState(");
    const joinIndex = recovery.indexOf("requestVoiceJoin(");
    const snapshotIndex = recovery.indexOf("requestKnownSnapshots()");
    assert.notEqual(effectiveStateIndex, -1);
    assert.notEqual(joinIndex, -1);
    assert.notEqual(snapshotIndex, -1);
    assert.ok(effectiveStateIndex < joinIndex);
    assert.ok(joinIndex < snapshotIndex);
    assert.doesNotMatch(recovery, /Boolean\(localStreamsRef\.current\.mic\)/);
    assert.doesNotMatch(recovery, /emitMediaState\(/);
  });

  it("retries connected recovery until join and visual subscriptions are acknowledged", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /const recoveryRetryTimerRef = useRef<number \| null>\(null\)/);
    assert.match(source, /const recoveryAttemptInFlightRef = useRef\(false\)/);
    assert.match(source, /voiceRecoveryRetryDelayMs/);
    assert.match(source, /const subscription = await setVisualSubscriptions\(visualTargetsRef\.current\)/);
    assert.match(source, /if \(!subscription\.ok\)[\s\S]*?retry = true/);
    assert.match(source, /scheduleRecovery\(voiceRecoveryRetryDelayMs\)/);
    assert.match(source, /window\.clearTimeout\(recoveryRetryTimerRef\.current\)/);
  });

  it("uses the acknowledged atomic join for explicit room entry", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const join = source.match(/const join = useCallback[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    assert.match(join, /effectiveVoiceMediaState\(/);
    assert.match(join, /await requestVoiceJoin\(/);
    assert.match(join, /response\.state\.media\.mic/);
    assert.doesNotMatch(join, /socket\.emit\("voice:join"/);
    assert.doesNotMatch(join, /await emitMediaState\(/);
  });

  it("derives undeafen and ended microphone state from live tracks", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const setDeafened = source.match(/const setDeafened = useCallback[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    assert.match(source, /watchMicrophoneStreamEnd\(/);
    assert.match(setDeafened, /effectiveVoiceMediaState\(/);
    assert.doesNotMatch(setDeafened, /Boolean\(localStreamsRef\.current\.mic\)/);
  });

  it("preserves only the pre-deafen microphone preference through undeafen", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const toggleMic = source.match(/const toggleMic = useCallback[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";
    const setDeafened = source.match(/const setDeafened = useCallback[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    assert.match(source, /const microphoneOnBeforeDeafenRef = useRef\(true\)/);
    assert.match(source, /const deafenTransitionRef = useRef\(0\)/);
    assert.match(setDeafened, /microphoneOnBeforeDeafenRef\.current = moderationRef\.current\.muted[\s\S]*?microphoneOnBeforeModerationMuteRef\.current[\s\S]*?: controlsRef\.current\.mic\.on/);
    assert.match(setDeafened, /const restoreMicrophoneOn = !moderationRef\.current\.muted[\s\S]*?&& microphoneOnBeforeDeafenRef\.current/);
    assert.match(setDeafened, /track\.enabled = restoreMicrophoneOn && track\.readyState === "live"/);
    assert.match(setDeafened, /restoreMicrophoneOn/);
    assert.match(setDeafened, /effectiveVoiceMediaState\(nextControls, localStreamsRef\.current\)/);
    assert.match(setDeafened, /const response = await emitMediaState/);
    assert.match(setDeafened, /transition !== deafenTransitionRef\.current/);
    assert.match(setDeafened, /const failedControls: VoiceControls = \{[\s\S]*?\.\.\.controlsRef\.current,[\s\S]*?deafen:[\s\S]*?on: true/);
    assert.doesNotMatch(toggleMic, /microphoneOnBeforeDeafenRef/);
  });

  it("invalidates deafen mic restoration when the microphone track ends", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const activateMicrophoneInput = source.match(/const activateMicrophoneInput = useCallback[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    assert.match(activateMicrophoneInput, /microphoneOnBeforeDeafenRef\.current = false/);
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
