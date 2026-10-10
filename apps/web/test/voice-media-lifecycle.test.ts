import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync as readFileSyncRaw } from "node:fs";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthenticatedAppSurface } from "../src/app/AuthenticatedAppSurface.js";
import { joinVoiceWithAudioUnlock } from "../src/features/voice/voiceActions.js";
import { ensureOfferableAudioSection } from "../src/lib/voiceMedia.js";
import { readAppSource } from "./app-source.js";

function readSource(path: string) {
  // Source-contract assertions should not depend on the checkout's line endings.
  return readFileSyncRaw(path, "utf8").replace(/\r\n/g, "\n");
}

describe("voice snapshot reconciliation", () => {
  it("moves a LIVE card selection into voice without a second confirmation", () => {
    const source = readAppSource();
    const voiceRoom = source.match(/function\s+VoiceRoomScreen[\s\S]*?\n}\n\nfunction\s+OwnerPanel/)?.[0] ?? "";

    assert.match(voiceRoom, /liveWatchAttemptRef/);
    assert.match(voiceRoom, /microphoneEnabled:\s*true/);
    assert.doesNotMatch(voiceRoom, /onClick=\{\s*joinAndWatchLive\s*\}\s*/);
  });

  it("supports receive-only joins and lazily opens the microphone", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(source, /interface\s+VoiceJoinOptions[\s\S]*?microphoneEnabled\?:\s+boolean/);
    assert.match(source, /options\.microphoneEnabled\s*\?\?\s*true/);
    assert.match(source, /if\s+\(\s*!stream\s*\)[\s\S]*?getUserMedia[\s\S]*?renegotiatePeers\(\s*\)/);
    assert.match(source, /record\.microphoneEnabled/);
  });
  it("navigates away from the access claim route after authentication", () => {
    const source = readAppSource();

    assert.match(
      source,
      /const\s+completeAuthentication\s+=\s+useCallback\(\s*[\s\S]*?authRequestGateRef\.current\.invalidate\(\s*\)[\s\S]*?setUser\(\s*nextUser\s*\)[\s\S]*?setAuthState\(\s*"ready"\s*\)/
    );
    assert.match(source, /const\s+authenticatedUserIdRef\s+=\s+useRef<string\s+\|\s+null>\s*\(\s*null\s*\)/);
    assert.match(
      source,
      /if\s+\(\s*authenticatedUserIdRef\.current\s+!==\s+nextUser\.id\s*\)\s+setRtcConfigReady\(\s*false\s*\)[\s\S]*?authenticatedUserIdRef\.current\s+=\s+nextUser\.id[\s\S]*?\s*\}\s*,\s+\[\]\s*\)/
    );
    assert.match(
      source,
      /fetchMe\(\s*\)[\s\S]*?authenticatedUserIdRef\.current\s+=\s+response\.user\.id[\s\S]*?setUser\(\s*response\.user\s*\)/
    );
    assert.match(
      source,
      /const\s+generation\s+=\s+authRequestGateRef\.current\.begin\(\s*\)[\s\S]*?authRequestGateRef\.current\.isCurrent\(\s*generation\s*\)/
    );
    assert.match(
      source,
      /const\s+handleAccessClaimed\s+=\s+useCallback\(\s*[\s\S]*?completeAuthentication\(\s*claimed\s*\)[\s\S]*?loadAcceptedServer\(\s*serverId\s*\)/
    );
    assert.match(source, /<AccessClaimScreen[\s\S]*?onClaimed=\{\s*onAccessClaimed\s*\}\s*/);
  });

  it("does not reserve a blank stage status row", () => {
    const source = readAppSource();

    assert.match(
      source,
      /\{\s*stageStatus\s+\?\s+\(?\s*<p\s+className="voice-stage-status"\s+aria-live="polite">\s*\{\s*stageStatus\s*\}\s*<\/p>\s*\)?\s*:\s+null\s*\}\s*/
    );
  });

  it("unlocks audio playback synchronously before starting voice join", async () => {
    const events: string[] = [];

    assert.equal(typeof joinVoiceWithAudioUnlock, "function");
    await joinVoiceWithAudioUnlock(
      "voice-room",
      () => events.push("unlock"),
      () => events.push("release"),
      async (roomId) => {
        events.push(`join:${roomId}`);
        return true;
      }
    );

    assert.deepEqual(events, ["unlock", "join:voice-room"]);
  });

  it("releases unused audio playback after a failed voice join", async () => {
    const events: string[] = [];

    assert.equal(typeof joinVoiceWithAudioUnlock, "function");
    await joinVoiceWithAudioUnlock(
      "voice-room",
      () => events.push("unlock"),
      () => events.push("release"),
      async () => {
        events.push("join");
        return false;
      }
    );

    assert.deepEqual(events, ["unlock", "join", "release"]);
  });

  it("stops a pre-join microphone test before opening voice capture", () => {
    const source = readAppSource();
    const join = source.match(/const\s+onJoinVoice[\s\S]*?onJoinVoice,/)?.[0] ?? "";

    assert.match(join, /audio\.microphoneTest\.active/);
    assert.match(join, /audio\.stopMicrophoneTest/);
    assert.match(join, /!audio\.voice\.activeRoomId/);
    assert.ok(join.indexOf("audio.stopMicrophoneTest") < join.indexOf("joinVoiceWithAudioUnlock"));
  });

  it("releases unused audio playback in the canonical voice leave path", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const leave =
      source.match(/const\s+leave\s+=\s+useCallback\(\s*\(\s*\)\s+=>\s+\{\s*[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/)?.[0] ??
      "";

    assert.match(leave, /releaseUnusedSharedAudioOutput\(\s*\)/);
  });

  it("keeps one voice-audio sibling mounted for every authenticated surface", () => {
    type SurfaceProps = { audio: ReactNode; children: ReactNode };
    const Surface = AuthenticatedAppSurface as ComponentType<SurfaceProps>;

    assert.equal(typeof Surface, "function");
    for (const route of ["text", "voice", "owner", "invite"]) {
      const html = renderToStaticMarkup(
        createElement(Surface as ComponentType<SurfaceProps>, {
          audio: createElement("audio", { "data-voice-runtime": "true" }),
          children: createElement("main", { "data-route": route })
        })
      );
      assert.match(html, /data-voice-runtime="true"/);
      assert.match(html, new RegExp(`data-route="${route}"`));
    }
  });

  it("handles Back/Forward as route changes without leaving or remounting voice", () => {
    const app = readSource("src/App.tsx");
    const pop = app.match(/const\s+handlePop\s+=\s+\(\s*\)\s+=>\s+\{\s*[\s\S]*?\n\s+\}\s*;/)?.[0] ?? "";
    assert.match(pop, /parseRoute\(\s*window.location.pathname\s*\)/);
    assert.match(pop, /setRoute\(\s*nextRoute\s*\)/);
    assert.doesNotMatch(pop, /leave|reload|location\.(?:assign|replace)|joinVoice/);
    assert.match(app, /window.addEventListener\(\s*"popstate",\s+handlePop\s*\)/);
    assert.doesNotMatch(app, /<AuthenticatedAppSurface[^>]*key=/);
  });

  it("keeps the native remote audio element mounted as the only hardware sink", () => {
    const source = readAppSource();
    const remoteAudio = source.match(/function\s+RemoteAudio[\s\S]*?\n}\n\nfunction\s+GlobalVoiceAudio/)?.[0] ?? "";

    assert.match(remoteAudio, /connectAudioOutput\(\s*audio,\s+stream,\s+\{\s+muted,\s+volume\s+\}\s*\)/);
    assert.doesNotMatch(remoteAudio, /if\s+\(\s*!useFallback\s*\)\s+return\s+null/);
    assert.match(remoteAudio, /return\s+<audio[^>]*ref=\{\s*audioRef\s*\}\s*/);
  });

  it("keeps watched screen-share audio independent of stage and participant deafen", () => {
    const source = readAppSource();
    const globalVoiceAudio =
      source.match(/function\s+GlobalVoiceAudio[\s\S]*?\n}\n\nfunction\s+VisualStage/)?.[0] ?? "";
    const visualStage = source.match(/function\s+VisualStage[\s\S]*?\n}\n\nfunction\s+StatusPill/)?.[0] ?? "";
    const voiceRoom = source.match(/function\s+VoiceRoomScreen[\s\S]*?\n}\n\nfunction\s+OwnerPanel/)?.[0] ?? "";

    assert.match(
      globalVoiceAudio,
      /<RemoteAudio[\s\S]*?muted=\{\s*muted\s+\|\|\s+mutedUserIds\.has\(\s*item\.userId\s*\)\s*\}\s*/
    );
    assert.doesNotMatch(visualStage, /<RemoteAudio/);
    assert.match(
      voiceRoom,
      /<RemoteAudio\s+key=\{\s*source.key\s*\}\s+stream=\{\s*source.stream!\s*\}\s+muted=\{\s*false\s*\}\s*/
    );
    assert.doesNotMatch(visualStage, /^\s*muted:\s*boolean;/m);
    assert.doesNotMatch(voiceRoom, /<VisualStage[\s\S]*?muted=\{\s*props\.controls\.deafen\.on\s*\}\s*/);
  });

  it("exposes a retry action only when native audio playback is blocked", () => {
    const source = readAppSource();

    assert.match(source, /subscribeBlockedAudioOutputs/);
    assert.match(source, /retryBlockedAudioOutputs/);
    assert.match(source, /audioPlaybackBlocked/);
  });

  it("runs peer reconciliation for acknowledged and pushed snapshots", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const acknowledgedSnapshots =
      source.match(/socket\.emit\(\s*"voice:snapshot"[\s\S]{0,240}applyVoiceSnapshot\(\s*nextSnapshot\s*\)/g) ?? [];

    assert.equal(acknowledgedSnapshots.length, 2);
    assert.match(
      source,
      /const\s+onSnapshot\s+=\s+\(\s*nextSnapshot:\s+VoiceSnapshot\s*\)\s+=>\s+applyVoiceSnapshot\(\s*nextSnapshot\s*\)/
    );
  });

  it("closes stale media peers when signaling disconnects", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    const disconnect = source.match(/const\s+onDisconnect\s+=\s+\(\s*\)\s+=>\s+\{\s*[\s\S]*?\n\s+\}\s*;/)?.[0] ?? "";
    assert.match(disconnect, /closePeers\(\s*\)/);
    assert.match(disconnect, /desktopMicrophone\.suspend\(\s*\)/);
  });

  it("cancels failed-peer recovery after an authoritative member leave", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(source, /activeVoiceMemberUserIdsRef\.current\s+=\s+activeMemberUserIds/);
    assert.match(source, /\.\.\.peerRecoveryTimersRef\.current\.keys\(\s*\)/);
    assert.match(source, /if\s+\(\s*!activeVoiceMemberUserIdsRef\.current\.has\(\s*peerUserId\s*\)\s*\)\s+return/);
  });

  it("preserves visual subscriptions during transient peer recovery", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(
      source,
      /removePeer\(\s*peerUserId,\s+\{\s*[\s\S]*?preserveVisualSubscriptions:\s+true,[\s\S]*?preserveRecoveryState:\s+true/
    );
  });

  it("rejoins with effective media before requesting reconnect snapshots", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const recovery =
      source.match(
        /const\s+attemptRecovery\s+=\s+async\s+\(\s*\)\s+=>\s+\{\s*([\s\S]*?)\n\s+\}\s*;\n\s+const\s+onConnect/
      )?.[1] ?? "";

    const effectiveStateIndex = recovery.indexOf("effectiveVoiceMediaState(");
    const joinIndex = recovery.indexOf("requestVoiceJoin(");
    const snapshotIndex = recovery.indexOf("requestKnownSnapshots()");
    assert.notEqual(effectiveStateIndex, -1);
    assert.notEqual(joinIndex, -1);
    assert.notEqual(snapshotIndex, -1);
    assert.ok(effectiveStateIndex < joinIndex);
    assert.ok(joinIndex < snapshotIndex);
    assert.doesNotMatch(recovery, /Boolean\(\s*localStreamsRef\.current\.mic\s*\)/);
    assert.doesNotMatch(recovery, /emitMediaState\(\s*/);
  });

  it("retries connected recovery until join and visual subscriptions are acknowledged", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(source, /const\s+recoveryRetryTimerRef\s+=\s+useRef<number\s+\|\s+null>\s*\(\s*null\s*\)/);
    assert.match(source, /const\s+recoveryAttemptInFlightRef\s+=\s+useRef\(\s*false\s*\)/);
    assert.match(source, /voiceRecoveryRetryDelayMs/);
    assert.match(
      source,
      /const\s+subscription\s+=\s+await\s+setVisualSubscriptions\(\s*visualTargetsRef\.current\s*\)/
    );
    assert.match(source, /if\s+\(\s*!subscription\.ok\s*\)[\s\S]*?retry\s+=\s+true/);
    assert.match(source, /scheduleRecovery\(\s*voiceRecoveryRetryDelayMs\s*\)/);
    assert.match(source, /window\.clearTimeout\(\s*recoveryRetryTimerRef\.current\s*\)/);
  });

  it("uses the acknowledged atomic join for explicit room entry", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const join = source.match(/const\s+join\s+=\s+useCallback[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/)?.[0] ?? "";

    assert.match(join, /effectiveVoiceMediaState\(\s*/);
    assert.match(join, /await\s+requestVoiceJoin\(\s*/);
    assert.match(join, /response\.state\.media\.mic/);
    assert.doesNotMatch(join, /socket\.emit\(\s*"voice:join"/);
    assert.doesNotMatch(join, /await\s+emitMediaState\(\s*/);
  });

  it("derives undeafen and ended microphone state from live tracks", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const setDeafened =
      source.match(/const\s+setDeafened\s+=\s+useCallback[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/)?.[0] ?? "";

    assert.match(source, /watchMicrophoneStreamEnd\(\s*/);
    assert.match(setDeafened, /effectiveVoiceMediaState\(\s*/);
    assert.doesNotMatch(setDeafened, /Boolean\(\s*localStreamsRef\.current\.mic\s*\)/);
  });

  it("preserves only the pre-deafen microphone preference through undeafen", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const toggleMic = source.match(/const\s+toggleMic\s+=\s+useCallback[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/)?.[0] ?? "";
    const setDeafened =
      source.match(/const\s+setDeafened\s+=\s+useCallback[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/)?.[0] ?? "";

    assert.match(source, /const\s+microphoneOnBeforeDeafenRef\s+=\s+useRef\(\s*true\s*\)/);
    assert.match(source, /const\s+deafenTransitionRef\s+=\s+useRef\(\s*0\s*\)/);
    assert.match(
      setDeafened,
      /microphoneOnBeforeDeafenRef\.current\s+=\s+moderationRef\.current\.muted[\s\S]*?microphoneOnBeforeModerationMuteRef\.current[\s\S]*?:\s+controlsRef\.current\.mic\.on/
    );
    assert.match(
      setDeafened,
      /const\s+restoreMicrophoneOn\s+=\s+!moderationRef\.current\.muted[\s\S]*?&&\s+microphoneOnBeforeDeafenRef\.current/
    );
    assert.match(
      setDeafened,
      /desktopMicrophone\.apply\(\s*\[track\],\s+restoreMicrophoneOn\s+&&\s+track\.readyState\s+===\s+"live"\s*\)/
    );
    assert.match(setDeafened, /restoreMicrophoneOn/);
    assert.match(setDeafened, /effectiveVoiceMediaState\(\s*nextControls,\s+localStreamsRef\.current\s*\)/);
    assert.match(setDeafened, /const\s+response\s+=\s+await\s+emitMediaState/);
    assert.match(setDeafened, /transition\s+!==\s+deafenTransitionRef\.current/);
    assert.match(
      setDeafened,
      /const\s+failedControls:\s+VoiceControls\s+=\s+\{\s*[\s\S]*?\.\.\.controlsRef\.current,[\s\S]*?deafen:[\s\S]*?on:\s+true/
    );
    assert.doesNotMatch(toggleMic, /microphoneOnBeforeDeafenRef/);
  });

  it("retains microphone intent for recovery while a lost microphone stays unpublished", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const handleMicrophoneLost =
      source.match(/const\s+handleMicrophoneLost\s+=\s+useCallback[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/)?.[0] ?? "";
    const activateMicrophoneInput =
      source.match(/const\s+activateMicrophoneInput\s+=\s+useCallback[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/)?.[0] ?? "";

    assert.match(handleMicrophoneLost, /microphoneRecoveryRef.current\s+=/);
    assert.match(handleMicrophoneLost, /controlsRef.current.deafen.on\s+&&\s+microphoneOnBeforeDeafenRef.current/);
    assert.match(handleMicrophoneLost, /mic:\s+\{\s+\.\.\.controlsRef.current.mic,\s+on:\s+false\s+\}\s*/);
    // Only the input that is still current may report itself as lost.
    assert.match(
      activateMicrophoneInput,
      /if\s+\(\s*microphoneInputRef\.current\s+!==\s+input\s*\)\s+return;\s*\n\s*handleMicrophoneLost\(\s*/
    );
  });

  it("does not treat a microphone selection as a socket reconnect", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const join = source.match(/const\s+join\s+=\s+useCallback[\s\S]*?\n\s+},\s+\[([^\]]*)\]\s*\);/) ?? [];

    assert.match(source, /const\s+microphoneDeviceIdRef\s+=\s+useRef\(\s*microphoneDeviceId\s*\)/);
    assert.match(join[0] ?? "", /openMicrophoneCapture\(\s*\{\s+deviceId:\s+microphoneDeviceIdRef\.current\s+\}\s*\)/);
    assert.doesNotMatch(join[1] ?? "", /\bmicrophoneDeviceId\b/);
    assert.doesNotMatch(join[1] ?? "", /\bnoiseSuppression\b/);
  });

  it("applies noise suppression to the live graph instead of re-capturing", () => {
    // Regression: the preference used to release the device and reopen it,
    // which took seconds, published silence in between, and could end with no
    // microphone at all if the reopen failed.
    const source = readSource("src/lib/useVoiceMedia.ts");
    const effect =
      source.match(
        /useEffect\(\s*\(\s*\)\s+=>\s+\{\s*\n\s+noiseSuppressionRef\.current\s+=\s+noiseSuppression;[\s\S]*?\n\s+},\s+\[([^\]]*)\]\s*\);/
      ) ?? [];

    assert.match(source, /const\s+noiseSuppressionRef\s+=\s+useRef\(\s*noiseSuppression\s*\)/);
    assert.match(effect[0] ?? "", /microphoneInputRef\.current\?\.setNoiseSuppression\(\s*noiseSuppression\s*\)/);
    assert.equal((effect[1] ?? "").trim(), "noiseSuppression");
    assert.doesNotMatch(source, /openMicrophoneCapture\(\s*[^)]*noiseSuppression/);
  });

  it("initializes the optional worklet with the current preference", () => {
    const source = readSource("src/lib/microphoneInput.ts");

    assert.match(source, /processorOptions:\s+\{\s+enabled:\s+noiseSuppression\s+\}\s*/);
  });

  it("reopens the capture for a device change and for nothing else", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const effect =
      source.match(
        /useEffect\(\s*\(\s*\)\s+=>\s+\{\s*\n\s+const\s+previousStream\s+=\s+localStreamsRef\.current\.mic;[\s\S]*?\n\s+},\s+\[([^\]]*)\]\s*\);/
      ) ?? [];

    assert.doesNotMatch(effect[1] ?? "", /\bnoiseSuppression\b/, "the preference no longer drives a re-capture");
    assert.match(effect[0] ?? "", /openMicrophoneCapture\(\s*\{\s+deviceId:\s+microphoneDeviceId\s+\}\s*\)/);
    // The replacement track must inherit mute, deafen, and owner-mute state.
    assert.match(
      effect[0] ?? "",
      /desktopMicrophone\.apply\(\s*\[nextTrack\],\s+controlsRef\.current\.mic\.on\s+&&\s+!controlsRef\.current\.deafen\.on/
    );
    assert.match(
      effect[0] ?? "",
      /replaceMicrophoneTrack\(\s*peersRef\.current\.values\(\s*\),\s+nextTrack,\s+previousTrack\s*\)/
    );
    // An unchanged capture must not reopen the device on unrelated churn.
    assert.match(effect[0] ?? "", /if\s+\(\s*change\s+===\s+"none"\s*\)\s+return/);
  });

  it("keeps both captures alive across a device switch so one can be kept", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const effect =
      source.match(
        /useEffect\(\s*\(\s*\)\s+=>\s+\{\s*\n\s+const\s+previousStream\s+=\s+localStreamsRef\.current\.mic;[\s\S]*?\n\s+},\s+\[[^\]]*\]\s*\);/
      )?.[0] ?? "";

    // Nothing releases the running capture any more, so a failed reopen always
    // leaves the previous microphone to fall back to.
    assert.doesNotMatch(effect, /const\s+release\s+=/);
    assert.match(effect, /setError\(\s*"voiceError\.microphoneReopen"\s*\)/);
    assert.doesNotMatch(effect, /handleMicrophoneLost/, "no reopen path can now strand the user without a microphone");
    assert.doesNotMatch(source, /applyMicrophoneProcessing/);
  });

  it("still reports a microphone that genuinely disappeared", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(
      source,
      /const\s+handleMicrophoneLost\s+=\s+useCallback\(\s*\(\s*message:\s+VoiceErrorKey\s*\)\s+=>\s+\{\s*/
    );
    assert.match(source, /handleMicrophoneLost\(\s*"voiceError\.microphoneDisconnected"\s*\)/);
  });

  it("applies refreshed ICE servers to active peer connections", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(source, /const\s+iceServersRef\s+=\s+useRef\(\s*iceServers\s*\)/);
    assert.match(source, /new\s+RTCPeerConnection\(\s*\{\s+iceServers:\s+iceServersRef\.current\s+\}\s*\)/);
    assert.match(source, /peer\.setConfiguration\(\s*\{\s+iceServers\s+\}\s*\)/);
    assert.match(source, /peer\.restartIce\(\s*\)/);
  });

  it("recovers disconnected ICE peers before rebuilding them", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(source, /oniceconnectionstatechange/);
    assert.match(source, /advancePeerRecovery/);
    assert.match(source, /iceConnectionState\s+[!=]==\s+"disconnected"/);
    assert.match(source, /voicePeerRecoveryGraceMs/);
    assert.match(source, /peer\.restartIce\(\s*\)/);
    assert.match(source, /"reconnecting"/);
    assert.match(source, /peerGeneration/);
    assert.match(source, /isCurrentPeer/);
    assert.match(source, /preserveRecoveryState:\s+true/);
    assert.match(source, /phase\s+===\s+"restarting"/);
    assert.match(source, /iceConnectionState\s+!==\s+"disconnected"/);
    assert.match(source, /voicePeerConnectionTimeoutMs/);
    assert.match(source, /restartTimeout\s+=\s+window\.setTimeout/);
    assert.match(source, /restart_failed/);
  });

  it("routes quality recovery through the guarded peer recovery owner", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(source, /type:\s+expectedPeer\s+\?\s+"quality_degraded"\s+:\s+"recovery_requested"/);
    assert.match(source, /transition\.action\s+!==\s+"restart_ice"/);
    assert.match(source, /voicePeerConnectionTimeoutMs/);
    assert.match(source, /schedulePeerRecovery\(\s*payload\.fromUserId,\s+peer,\s+\{\s+type:\s+"failed"\s+\}\s*\)/);
  });

  it("invalidates an in-flight local offer before accepting a colliding offer", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.match(source, /const\s+offerGenerationsRef\s+=\s+useRef<Map<string,\s+number>\s*>\s*/);
    assert.match(source, /offerGenerationsRef\.current\.get\(\s*peerUserId\s*\)\s+!==\s+offerGeneration/);
    assert.match(source, /shouldIgnoreIncomingOffer\(\s*[\s\S]{0,180}makingOfferPeersRef\.current\.has/);
  });

  it("keeps answer cleanup generation-safe after candidate flushing", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");
    const answer = source.match(/if\s+\(\s*signal\.type\s+===\s+"answer"\s*\)\s+\{\s*([\s\S]*?)\n\s+\}\s*/)?.[1] ?? "";

    assert.match(answer, /await\s+flushPendingCandidates/);
    assert.match(
      answer,
      /if\s+\(\s*!isCurrentPeer\(\s*payload\.fromUserId,\s+peer,\s+peerGeneration\s*\)\s*\)\s+return;/
    );
  });
});

/**
 * Enough of `RTCPeerConnection` to see what an offer would carry. The headless
 * peer spike measured the part that matters: `createOffer` writes one media
 * section per transceiver, so a connection with no audio transceiver offers no
 * audio section — in Chrome and in werift alike.
 */
function fakePeer(kinds: Array<{ kind: string; direction: RTCRtpTransceiverDirection }> = []) {
  const transceivers = kinds.map(({ kind, direction }) => ({ direction, receiver: { track: { kind } } }));
  return {
    getTransceivers: () => transceivers,
    addTransceiver(kind: "audio", init: { direction: "recvonly" }) {
      const transceiver = { direction: init.direction as RTCRtpTransceiverDirection, receiver: { track: { kind } } };
      transceivers.push(transceiver);
      return transceiver;
    },
    offeredSections: () =>
      transceivers.map((transceiver) => `${transceiver.receiver.track.kind}:${transceiver.direction}`)
  };
}

describe("offers from a member who sends no audio", () => {
  it("still carries an audio section, so a member who joined muted can still receive audio", () => {
    const peer = fakePeer();

    assert.deepEqual(peer.offeredSections(), []);
    ensureOfferableAudioSection(peer);
    assert.deepEqual(peer.offeredSections(), ["audio:recvonly"]);
  });

  it("adds one beside a camera, which an answerer could not have added itself", () => {
    const peer = fakePeer([{ kind: "video", direction: "sendonly" }]);

    ensureOfferableAudioSection(peer);
    assert.deepEqual(peer.offeredSections(), ["video:sendonly", "audio:recvonly"]);
  });

  it("leaves a member who already sends audio alone", () => {
    const peer = fakePeer([{ kind: "audio", direction: "sendrecv" }]);

    ensureOfferableAudioSection(peer);
    assert.deepEqual(peer.offeredSections(), ["audio:sendrecv"]);
  });

  it("does not stack another section onto every later offer", () => {
    const peer = fakePeer();

    ensureOfferableAudioSection(peer);
    ensureOfferableAudioSection(peer);
    assert.deepEqual(peer.offeredSections(), ["audio:recvonly"]);
  });

  it("replaces an audio section the far side rejected", () => {
    const peer = fakePeer([{ kind: "audio", direction: "stopped" }]);

    ensureOfferableAudioSection(peer);
    assert.deepEqual(peer.offeredSections(), ["audio:stopped", "audio:recvonly"]);
  });

  it("runs on the one path every offer goes through", () => {
    const source = readSource("src/lib/useVoiceMedia.ts");

    assert.equal(source.match(/createOffer\(\s*\)/g)?.length, 1);
    assert.match(source, /ensureOfferableAudioSection\(\s*peer\s*\);[\s\S]{0,160}await\s+peer\.createOffer\(\s*\)/);
  });
});
