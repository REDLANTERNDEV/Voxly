import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthenticatedAppSurface } from "../src/app/AuthenticatedAppSurface.js";
import { joinVoiceWithAudioUnlock } from "../src/features/voice/voiceActions.js";
import { readAppSource } from "./app-source.js";

describe("voice snapshot reconciliation", () => {
  it("moves a LIVE card selection into voice without a second confirmation", () => {
    const source = readAppSource();
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
    const source = readAppSource();

    assert.match(source, /const completeAuthentication = useCallback\([\s\S]*?authRequestGateRef\.current\.invalidate\(\)[\s\S]*?setUser\(nextUser\)[\s\S]*?setAuthState\("ready"\)/);
    assert.match(source, /const authenticatedUserIdRef = useRef<string \| null>\(null\)/);
    assert.match(source, /if \(authenticatedUserIdRef\.current !== nextUser\.id\) setRtcConfigReady\(false\)[\s\S]*?authenticatedUserIdRef\.current = nextUser\.id[\s\S]*?\}, \[\]\)/);
    assert.match(source, /fetchMe\(\)[\s\S]*?authenticatedUserIdRef\.current = response\.user\.id[\s\S]*?setUser\(response\.user\)/);
    assert.match(source, /const generation = authRequestGateRef\.current\.begin\(\)[\s\S]*?authRequestGateRef\.current\.isCurrent\(generation\)/);
    assert.match(source, /const handleAccessClaimed = useCallback\([\s\S]*?completeAuthentication\(claimed\)[\s\S]*?loadAcceptedServer\(serverId\)/);
    assert.match(source, /<AccessClaimScreen[\s\S]*?onClaimed=\{onAccessClaimed\}/);
  });

  it("does not reserve a blank stage status row", () => {
    const source = readAppSource();

    assert.match(source, /\{stageStatus \? <p className="voice-stage-status" aria-live="polite">\{stageStatus\}<\/p> : null\}/);
  });

  it("unlocks audio playback synchronously before starting voice join", async () => {
    const events: string[] = [];

    assert.equal(typeof joinVoiceWithAudioUnlock, "function");
    await joinVoiceWithAudioUnlock("voice-room", () => events.push("unlock"), () => events.push("release"), async (roomId) => {
      events.push(`join:${roomId}`);
      return true;
    });

    assert.deepEqual(events, ["unlock", "join:voice-room"]);
  });

  it("releases unused audio playback after a failed voice join", async () => {
    const events: string[] = [];

    assert.equal(typeof joinVoiceWithAudioUnlock, "function");
    await joinVoiceWithAudioUnlock("voice-room", () => events.push("unlock"), () => events.push("release"), async () => {
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
    const Surface = AuthenticatedAppSurface as ComponentType<SurfaceProps>;

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
    const source = readAppSource();
    const remoteAudio = source.match(/function RemoteAudio[\s\S]*?\n}\n\nfunction GlobalVoiceAudio/)?.[0] ?? "";

    assert.match(remoteAudio, /connectAudioOutput\(audio, stream, \{ muted, volume \}\)/);
    assert.doesNotMatch(remoteAudio, /if \(!useFallback\) return null/);
    assert.match(remoteAudio, /return <audio[^>]*ref=\{audioRef\}/);
  });

  it("keeps focused screen-share audio audible while participant audio is deafened", () => {
    const source = readAppSource();
    const globalVoiceAudio = source.match(/function GlobalVoiceAudio[\s\S]*?\n}\n\nfunction VisualStage/)?.[0] ?? "";
    const visualStage = source.match(/function VisualStage[\s\S]*?\n}\n\nfunction StatusPill/)?.[0] ?? "";
    const voiceRoom = source.match(/function VoiceRoomScreen[\s\S]*?\n}\n\nfunction OwnerPanel/)?.[0] ?? "";

    assert.match(globalVoiceAudio, /<RemoteAudio[\s\S]*?muted=\{muted \|\| mutedUserIds\.has\(item\.userId\)\}/);
    assert.match(visualStage, /<RemoteAudio stream=\{focusedStream\} muted=\{false\}/);
    assert.doesNotMatch(visualStage, /^\s*muted:\s*boolean;/m);
    assert.doesNotMatch(voiceRoom, /<VisualStage[\s\S]*?muted=\{props\.controls\.deafen\.on\}/);
  });

  it("exposes a retry action only when native audio playback is blocked", () => {
    const source = readAppSource();

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

  it("invalidates deafen mic restoration when the microphone is lost", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const handleMicrophoneLost = source.match(/const handleMicrophoneLost = useCallback[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";
    const activateMicrophoneInput = source.match(/const activateMicrophoneInput = useCallback[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    assert.match(handleMicrophoneLost, /microphoneOnBeforeDeafenRef\.current = false/);
    // Only the input that is still current may report itself as lost.
    assert.match(activateMicrophoneInput, /if \(microphoneInputRef\.current !== input\) return;\s*\n\s*handleMicrophoneLost\(/);
  });

  it("does not treat a microphone selection as a socket reconnect", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const join = source.match(/const join = useCallback[\s\S]*?\n  }, \[([^\]]*)\]\);/) ?? [];

    assert.match(source, /const microphoneDeviceIdRef = useRef\(microphoneDeviceId\)/);
    assert.match(join[0] ?? "", /openMicrophoneCapture\(\{\s*\n\s*deviceId: microphoneDeviceIdRef\.current,\s*\n\s*noiseSuppression: noiseSuppressionRef\.current\s*\n\s*\}\)/);
    assert.doesNotMatch(join[1] ?? "", /\bmicrophoneDeviceId\b/);
    assert.doesNotMatch(join[1] ?? "", /\bnoiseSuppression\b/);
  });

  it("re-captures the microphone when noise suppression changes", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const effect = source.match(/useEffect\(\(\) => \{\n    const previousStream = localStreamsRef\.current\.mic;[\s\S]*?\n  }, \[([^\]]*)\]\);/) ?? [];

    assert.match(source, /const noiseSuppressionRef = useRef\(noiseSuppression\)/);
    assert.match(effect[1] ?? "", /\bnoiseSuppression\b/);
    assert.match(effect[0] ?? "", /openMicrophoneCapture\(\{ deviceId: microphoneDeviceId, noiseSuppression \}, \{ release \}\)/);
    // The replacement track must inherit mute, deafen, and owner-mute state.
    assert.match(effect[0] ?? "", /nextTrack\.enabled = controlsRef\.current\.mic\.on && !controlsRef\.current\.deafen\.on/);
    assert.match(effect[0] ?? "", /replaceMicrophoneTrack\(peersRef\.current\.values\(\), nextTrack, previousTrack\)/);
    // An unchanged capture must not reopen the device on unrelated dependency churn.
    assert.match(effect[0] ?? "", /if \(change === "none"\) return/);
  });

  it("frees the device for a processing change but overlaps a device switch", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const effect = source.match(/useEffect\(\(\) => \{\n    const previousStream = localStreamsRef\.current\.mic;[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    // Reopening an already-held device is served from the running pipeline and
    // keeps its processing, so only a device switch may overlap the captures.
    assert.match(effect, /const release = change === "processing"\s*\n\s*\? \(\) => \{/);
    // Releasing stops the raw capture, never the generated destination track
    // the peers are still reading from.
    assert.match(effect, /microphoneInputRef\.current\?\.rawStream\.getAudioTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
    // Our own release must not be reported to the user as an unplugged device.
    assert.match(effect, /microphoneEndedCleanupRef\.current\?\.\(\);\s*\n\s*microphoneEndedCleanupRef\.current = null;/);
    assert.doesNotMatch(source, /applyMicrophoneProcessing/);
  });

  it("gives up the microphone when a released capture cannot be reopened", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
    const effect = source.match(/useEffect\(\(\) => \{\n    const previousStream = localStreamsRef\.current\.mic;[\s\S]*?\n  }, \[[^\]]*\]\);/)?.[0] ?? "";

    // A device switch still holds the previous capture and can keep using it.
    assert.match(effect, /if \(change === "device"\) \{\s*\n\s*setError\("The microphone could not be reopened\. Using the previous microphone\."\);/);
    // A processing change already let the device go, so there is nothing to
    // keep and the mic state has to reflect that rather than look live.
    assert.match(effect, /handleMicrophoneLost\("The microphone could not be reopened with the new noise suppression setting\."\)/);
    assert.match(source, /const handleMicrophoneLost = useCallback\(\(message: string\) => \{/);
    assert.match(source, /handleMicrophoneLost\("Microphone disconnected\."\)/);
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
