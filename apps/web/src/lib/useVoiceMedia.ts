import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PublicUser,
  RtcSignal,
  VisualMediaKind,
  VisualTarget,
  VoiceMediaState,
  VoiceModerationState,
  VoiceSetMediaAck,
  VoiceSnapshot
} from "@voxly/shared";
import type { VoxlySocket } from "../socket.js";
import { createInitialVoiceControls, toggleVoiceControl, type VoiceControlKey, type VoiceControls } from "./voiceControls.js";
import {
  configureScreenTrack,
  effectiveVoiceMediaState,
  mediaConstraintsFor,
  preferScreenSenderResolution,
  replaceMicrophoneTrack,
  watchMicrophoneStreamEnd
} from "./voiceMedia.js";
import { requestVoiceJoin } from "./voiceJoin.js";
import { requestVisualSubscriptions, voiceRecoveryRetryDelayMs } from "./voiceRecovery.js";
import { DEFAULT_NOISE_SUPPRESSION, microphoneCaptureChange, openMicrophoneCapture } from "./noiseSuppression.js";
import { releaseUnusedSharedAudioOutput } from "./audioOutput.js";
import {
  shouldIgnoreIncomingOffer,
  shouldInitiatePeerConnection,
  staleVoicePeerUserIds,
  type PeerConnectionState
} from "./voiceNegotiation.js";
import { clearVoiceResume, readVoiceResume, voiceResumeWindowMs, writeVoiceResume } from "./voiceResume.js";
import {
  mediaStreamForTrack,
  pruneRemoteStreamsForSnapshot,
  removeRemoteStream,
  upsertRemoteStream,
  type RemoteMediaKind,
  type RemoteStreamState
} from "./voiceStreams.js";
import {
  createVoiceActivityState,
  updateVoiceActivity,
  voiceActivitySampleMs
} from "./voiceActivity.js";
import { createMicrophoneInput, type MicrophoneInput } from "./microphoneInput.js";

interface LocalPreviewState {
  kind: "camera" | "screen";
  stream: MediaStream;
}

interface UseVoiceMediaInput {
  socket: VoxlySocket | null;
  user: PublicUser | null;
  iceServers: RTCIceServer[];
  voiceRoomIds: string[];
  microphoneDeviceId?: string;
  microphoneVolume?: number;
  noiseSuppression?: boolean;
  /**
   * Rooms whose microphone is closed by the room itself. Needed here rather
   * than only on the server because audio flows peer to peer: a server that
   * records `mic: false` stops the indicator, not the sound, so the local track
   * has to be held disabled too.
   */
  afkRoomIds?: string[];
}

export interface VoiceJoinOptions {
  microphoneEnabled?: boolean;
}

type PeerSignal =
  | { type: "offer"; sdp: string; streams?: SignalStreamDescriptor[] }
  | { type: "answer"; sdp: string; streams?: SignalStreamDescriptor[] }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

type LocalStreamKind = "mic" | "camera" | "screen";

interface SignalStreamDescriptor {
  id: string;
  kind: RemoteMediaKind;
}

interface PeerRemovalOptions {
  expectedPeer?: RTCPeerConnection;
  preserveVisualSubscriptions?: boolean;
}

export function useVoiceMedia({ socket, user, iceServers, voiceRoomIds, microphoneDeviceId = "", microphoneVolume = 100, noiseSuppression = DEFAULT_NOISE_SUPPRESSION, afkRoomIds = [] }: UseVoiceMediaInput) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [controls, setControls] = useState<VoiceControls>(() => createInitialVoiceControls());
  const [voiceModeration, setVoiceModeration] = useState<VoiceModerationState>({ muted: false, deafened: false });
  const [voiceSnapshots, setVoiceSnapshots] = useState<Record<string, VoiceSnapshot>>({});
  const [visualTargets, setVisualTargets] = useState<VisualTarget[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStreamState[]>([]);
  const [peerConnectionStates, setPeerConnectionStates] = useState<Record<string, PeerConnectionState>>({});
  const [localPreviews, setLocalPreviews] = useState<LocalPreviewState[]>([]);
  const [microphoneMonitorStream, setMicrophoneMonitorStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const localStreamsRef = useRef<Partial<Record<LocalStreamKind, MediaStream>>>({});
  const microphoneInputRef = useRef<MicrophoneInput | null>(null);
  const iceServersRef = useRef(iceServers);
  const microphoneDeviceIdRef = useRef(microphoneDeviceId);
  const microphoneVolumeRef = useRef(microphoneVolume);
  const noiseSuppressionRef = useRef(noiseSuppression);
  const appliedMicrophoneCaptureRef = useRef({ deviceId: microphoneDeviceId });
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamKindsRef = useRef<Map<string, Map<string, RemoteMediaKind>>>(new Map());
  const viewerVisualSubscriptionsRef = useRef<Map<string, Set<VisualMediaKind>>>(new Map());
  const visualTargetsRef = useRef<VisualTarget[]>([]);
  const makingOfferPeersRef = useRef<Set<string>>(new Set());
  const offerGenerationsRef = useRef<Map<string, number>>(new Map());
  const pendingOfferPeersRef = useRef<Set<string>>(new Set());
  const peerRecoveryTimersRef = useRef<Map<string, number>>(new Map());
  const activeVoiceMemberUserIdsRef = useRef<Set<string>>(new Set());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const microphoneSwitchRef = useRef(0);
  const microphoneSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ignoredOfferPeersRef = useRef<Set<string>>(new Set());
  const recoverPeerRef = useRef<(peerUserId: string) => void>(() => undefined);
  const resumeAttemptRef = useRef(false);
  const recoveryInProgressRef = useRef(false);
  const joinAttemptRef = useRef(0);
  const resumeDeadlineRef = useRef<number | null>(null);
  const resumeDeadlineTimerRef = useRef<number | null>(null);
  const recoveryRetryTimerRef = useRef<number | null>(null);
  const recoveryAttemptInFlightRef = useRef(false);
  const controlsRef = useRef(controls);
  const voiceRoomIdsRef = useRef(voiceRoomIds);
  const afkRoomIdsRef = useRef(afkRoomIds);
  /** True while the member occupies a room that closes the microphone. */
  const micLockedByRoom = () => Boolean(roomRef.current && afkRoomIdsRef.current.includes(roomRef.current));
  const speakingRef = useRef(false);
  const speakingCleanupRef = useRef<(() => void) | null>(null);
  const microphoneEndedCleanupRef = useRef<(() => void) | null>(null);
  const microphoneEnabledRef = useRef(true);
  const microphoneOnBeforeDeafenRef = useRef(true);
  const microphoneOnBeforeModerationMuteRef = useRef(true);
  const moderationRef = useRef<VoiceModerationState>({ muted: false, deafened: false });
  const deafenTransitionRef = useRef(0);
  const roomRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    iceServersRef.current = iceServers;
  }, [iceServers]);

  useEffect(() => {
    microphoneDeviceIdRef.current = microphoneDeviceId;
  }, [microphoneDeviceId]);

  useEffect(() => {
    microphoneVolumeRef.current = microphoneVolume;
    microphoneInputRef.current?.setVolume(microphoneVolume);
  }, [microphoneVolume]);

  // Suppression is a value on the live capture graph, so the preference reaches
  // the audio on the next block. It used to require releasing the device and
  // reopening it, which took seconds and could fail with nothing to fall back
  // to. See `noiseSuppression.ts` for why the browser constraint cannot carry
  // this instead.
  useEffect(() => {
    noiseSuppressionRef.current = noiseSuppression;
    microphoneInputRef.current?.setNoiseSuppression(noiseSuppression);
  }, [noiseSuppression]);

  useEffect(() => {
    userIdRef.current = user?.id ?? null;
  }, [user?.id]);

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
    afkRoomIdsRef.current = afkRoomIds;
  }, [afkRoomIds]);

  const persistVoiceResume = useCallback((targets = visualTargetsRef.current, resetDeadline = false) => {
    if (!roomRef.current) return;
    const storage = voiceResumeStorage();
    const now = Date.now();
    const expiresAt = resetDeadline || !resumeDeadlineRef.current || resumeDeadlineRef.current <= now
      ? now + voiceResumeWindowMs
      : resumeDeadlineRef.current;
    resumeDeadlineRef.current = expiresAt;
    if (storage) writeVoiceResume(storage, roomRef.current, targets, now, expiresAt, microphoneEnabledRef.current);
  }, []);

  const emitMediaState = useCallback((media: Partial<VoiceMediaState>) => {
    if (!socket || !roomRef.current) {
      return Promise.resolve<VoiceSetMediaAck>({ ok: false, error: "not_in_voice_room" });
    }

    return new Promise<VoiceSetMediaAck>((resolve) => {
      socket.emit("voice:setMediaState", { roomId: roomRef.current as string, media }, resolve);
    });
  }, [socket]);

  const setLocalSpeaking = useCallback((next: boolean) => {
    if (speakingRef.current === next) {
      return;
    }
    speakingRef.current = next;
    void emitMediaState({ speaking: next });
  }, [emitMediaState]);

  const stopSpeakingMonitor = useCallback(() => {
    speakingCleanupRef.current?.();
    speakingCleanupRef.current = null;
    setLocalSpeaking(false);
  }, [setLocalSpeaking]);

  const startSpeakingMonitor = useCallback((stream: MediaStream) => {
    stopSpeakingMonitor();
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }

    try {
      const context = new AudioContextClass();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      // The window has to be longer than the sampling interval, otherwise most
      // of the signal is never examined and quiet speech is missed whenever the
      // sampled slice happens to land between syllables.
      analyser.fftSize = 2048;
      const samples = new Float32Array(analyser.fftSize);
      let activity = createVoiceActivityState();
      source.connect(analyser);

      const interval = window.setInterval(() => {
        const micIsLive = localStreamsRef.current.mic?.getAudioTracks().some((track) => track.enabled && track.readyState === "live") ?? false;
        if (!micIsLive) {
          setLocalSpeaking(false);
          return;
        }

        // Float samples rather than the 8-bit view: one step of that view is
        // ~0.008 RMS, which is coarser than the levels a quiet speaker produces,
        // so quiet speech quantized to zero and never armed the gate.
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) {
          sum += value * value;
        }
        activity = updateVoiceActivity(activity, Math.sqrt(sum / samples.length), Date.now());
        setLocalSpeaking(activity.speaking);
      }, voiceActivitySampleMs);

      speakingCleanupRef.current = () => {
        window.clearInterval(interval);
        source.disconnect();
        void context.close().catch(() => undefined);
      };
    } catch {
      speakingCleanupRef.current = null;
    }
  }, [setLocalSpeaking, stopSpeakingMonitor]);

  const stopStream = useCallback((kind: LocalStreamKind) => {
    const stream = localStreamsRef.current[kind];
    if (kind === "mic") {
      microphoneEndedCleanupRef.current?.();
      microphoneEndedCleanupRef.current = null;
      const input = microphoneInputRef.current;
      microphoneInputRef.current = null;
      input?.dispose();
      setMicrophoneMonitorStream(null);
    } else {
      stream?.getTracks().forEach((track) => track.stop());
    }
    delete localStreamsRef.current[kind];
    if (kind === "mic") {
      stopSpeakingMonitor();
    }
    if (kind === "camera" || kind === "screen") {
      setLocalPreviews((current) => current.filter((preview) => preview.kind !== kind));
    }
  }, [stopSpeakingMonitor]);

  const closePeers = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      peer.close();
    }
    peersRef.current.clear();
    remoteStreamKindsRef.current.clear();
    viewerVisualSubscriptionsRef.current.clear();
    makingOfferPeersRef.current.clear();
    offerGenerationsRef.current.clear();
    pendingOfferPeersRef.current.clear();
    for (const timer of peerRecoveryTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    peerRecoveryTimersRef.current.clear();
    activeVoiceMemberUserIdsRef.current.clear();
    pendingCandidatesRef.current.clear();
    ignoredOfferPeersRef.current.clear();
    setRemoteStreams([]);
    setPeerConnectionStates({});
  }, []);

  const removePeer = useCallback((peerUserId: string, options: PeerRemovalOptions = {}) => {
    const peer = peersRef.current.get(peerUserId);
    if (options.expectedPeer && peer !== options.expectedPeer) return false;
    peer?.close();
    peersRef.current.delete(peerUserId);
    remoteStreamKindsRef.current.delete(peerUserId);
    if (!options.preserveVisualSubscriptions) {
      viewerVisualSubscriptionsRef.current.delete(peerUserId);
    }
    makingOfferPeersRef.current.delete(peerUserId);
    offerGenerationsRef.current.delete(peerUserId);
    pendingOfferPeersRef.current.delete(peerUserId);
    pendingCandidatesRef.current.delete(peerUserId);
    ignoredOfferPeersRef.current.delete(peerUserId);
    const recoveryTimer = peerRecoveryTimersRef.current.get(peerUserId);
    if (recoveryTimer) window.clearTimeout(recoveryTimer);
    peerRecoveryTimersRef.current.delete(peerUserId);
    setRemoteStreams((current) => current.filter((item) => item.userId !== peerUserId));
    setPeerConnectionStates((current) => {
      const next = { ...current };
      delete next[peerUserId];
      return next;
    });
    return Boolean(peer);
  }, []);

  const localStreamDescriptors = useCallback((peerUserId: string): SignalStreamDescriptor[] => {
    const descriptors: SignalStreamDescriptor[] = [];
    if (localStreamsRef.current.mic) {
      descriptors.push({ id: localStreamsRef.current.mic.id, kind: "audio" });
    }
    const subscribedKinds = viewerVisualSubscriptionsRef.current.get(peerUserId) ?? new Set<VisualMediaKind>();
    if (localStreamsRef.current.camera && subscribedKinds.has("camera")) {
      descriptors.push({ id: localStreamsRef.current.camera.id, kind: "camera" });
    }
    if (localStreamsRef.current.screen && subscribedKinds.has("screen")) {
      descriptors.push({ id: localStreamsRef.current.screen.id, kind: "screen" });
    }
    return descriptors;
  }, []);

  const rememberRemoteStreamKinds = useCallback((peerUserId: string, descriptors: SignalStreamDescriptor[] | undefined) => {
    if (!descriptors?.length) {
      return;
    }
    const streamKinds = remoteStreamKindsRef.current.get(peerUserId) ?? new Map<string, RemoteMediaKind>();
    for (const descriptor of descriptors) {
      streamKinds.set(descriptor.id, descriptor.kind);
    }
    remoteStreamKindsRef.current.set(peerUserId, streamKinds);
  }, []);

  const syncLocalTracks = useCallback((peer: RTCPeerConnection, peerUserId: string) => {
    const currentTracks = new Set<MediaStreamTrack>();
    const subscribedKinds = viewerVisualSubscriptionsRef.current.get(peerUserId) ?? new Set<VisualMediaKind>();
    const streams: Array<[LocalStreamKind, MediaStream | undefined]> = [
      ["mic", localStreamsRef.current.mic],
      ["camera", localStreamsRef.current.camera],
      ["screen", localStreamsRef.current.screen]
    ];
    for (const [kind, stream] of streams) {
      if (!stream || (kind !== "mic" && !subscribedKinds.has(kind))) continue;
      for (const track of stream.getTracks()) {
        currentTracks.add(track);
        const existingSender = peer.getSenders().find((sender) => sender.track === track);
        const sender = existingSender ?? peer.addTrack(track, stream);
        if (kind === "screen" && track.kind === "video") {
          void preferScreenSenderResolution(sender, track);
        }
      }
    }

    for (const sender of peer.getSenders()) {
      if (sender.track && !currentTracks.has(sender.track)) {
        peer.removeTrack(sender);
      }
    }
  }, []);

  const sendOffer = useCallback(async (peerUserId: string, peer: RTCPeerConnection) => {
    if (!socket || !roomRef.current) return;
    if (peer.signalingState !== "stable" || makingOfferPeersRef.current.has(peerUserId)) {
      pendingOfferPeersRef.current.add(peerUserId);
      return;
    }
    makingOfferPeersRef.current.add(peerUserId);
    const offerGeneration = (offerGenerationsRef.current.get(peerUserId) ?? 0) + 1;
    offerGenerationsRef.current.set(peerUserId, offerGeneration);
    try {
      const offer = await peer.createOffer();
      if (
        offerGenerationsRef.current.get(peerUserId) !== offerGeneration ||
        peersRef.current.get(peerUserId) !== peer ||
        peer.signalingState !== "stable" ||
        !roomRef.current
      ) return;
      await peer.setLocalDescription(offer);
      if (
        offerGenerationsRef.current.get(peerUserId) !== offerGeneration ||
        peersRef.current.get(peerUserId) !== peer ||
        (peer.signalingState as RTCSignalingState) !== "have-local-offer" ||
        peer.localDescription?.type !== "offer" ||
        !roomRef.current
      ) return;
      socket.emit("rtc:signal", {
        roomId: roomRef.current,
        toUserId: peerUserId,
        signal: { type: "offer", sdp: peer.localDescription.sdp ?? "", streams: localStreamDescriptors(peerUserId) }
      });
    } finally {
      makingOfferPeersRef.current.delete(peerUserId);
    }
  }, [localStreamDescriptors, socket]);

  const ensurePeer = useCallback((peerUserId: string) => {
    if (!socket || !roomRef.current || !userIdRef.current || peerUserId === userIdRef.current) {
      return null;
    }
    const existing = peersRef.current.get(peerUserId);
    if (existing) {
      return existing;
    }

    const recoveryTimer = peerRecoveryTimersRef.current.get(peerUserId);
    if (recoveryTimer) window.clearTimeout(recoveryTimer);
    peerRecoveryTimersRef.current.delete(peerUserId);

    const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
    peersRef.current.set(peerUserId, peer);
    setPeerConnectionStates((current) => ({ ...current, [peerUserId]: "connecting" }));
    syncLocalTracks(peer, peerUserId);
    peer.onicecandidate = (event) => {
      if (!event.candidate || !roomRef.current) return;
      socket.emit("rtc:signal", {
        roomId: roomRef.current,
        toUserId: peerUserId,
        signal: { type: "candidate", candidate: event.candidate.toJSON() }
      });
    };
    peer.ontrack = (event) => {
      const stream = mediaStreamForTrack(event.track, event.streams);
      const kind = remoteStreamKindsRef.current.get(peerUserId)?.get(stream.id) ?? (event.track.kind === "audio" ? "audio" : "camera");
      setRemoteStreams((current) => {
        return upsertRemoteStream(current, peerUserId, kind, stream);
      });
      event.track.addEventListener("ended", () => {
        if (kind === "screen" && event.track.kind === "audio") return;
        setRemoteStreams((current) => removeRemoteStream(current, peerUserId, kind, stream));
      }, { once: true });
    };
    peer.onconnectionstatechange = () => {
      const state: PeerConnectionState = peer.connectionState === "connected"
        ? "connected"
        : peer.connectionState === "failed"
          ? "failed"
          : "connecting";
      setPeerConnectionStates((current) => ({ ...current, [peerUserId]: state }));
      if (peer.connectionState !== "failed" || !removePeer(peerUserId, { expectedPeer: peer, preserveVisualSubscriptions: true })) return;
      const timer = window.setTimeout(() => {
        peerRecoveryTimersRef.current.delete(peerUserId);
        if (!activeVoiceMemberUserIdsRef.current.has(peerUserId)) return;
        recoverPeerRef.current(peerUserId);
      }, 300);
      peerRecoveryTimersRef.current.set(peerUserId, timer);
    };

    return peer;
  }, [removePeer, socket, syncLocalTracks]);

  const flushPendingCandidates = useCallback(async (peerUserId: string, peer: RTCPeerConnection) => {
    const candidates = pendingCandidatesRef.current.get(peerUserId) ?? [];
    pendingCandidatesRef.current.delete(peerUserId);
    for (const candidate of candidates) {
      try {
        await peer.addIceCandidate(candidate);
      } catch {
        // A candidate from an ignored glare offer can arrive before the offer.
        // Continue so one mismatched ufrag cannot block valid queued candidates.
      }
    }
  }, []);

  useEffect(() => {
    recoverPeerRef.current = (peerUserId) => {
      const peer = ensurePeer(peerUserId);
      if (peer) void sendOffer(peerUserId, peer).catch(() => setError("Could not recover peer connection."));
    };
    return () => {
      recoverPeerRef.current = () => undefined;
    };
  }, [ensurePeer, sendOffer]);

  useEffect(() => {
    if (!roomRef.current) return;
    for (const [peerUserId, peer] of peersRef.current) {
      try {
        peer.setConfiguration({ iceServers });
        peer.restartIce();
        void sendOffer(peerUserId, peer).catch(() => setError("Could not refresh peer connection."));
      } catch {
        setError("Could not apply refreshed RTC configuration.");
      }
    }
  }, [iceServers, sendOffer]);

  const renegotiatePeers = useCallback(() => {
    for (const [peerUserId, peer] of peersRef.current) {
      syncLocalTracks(peer, peerUserId);
      void sendOffer(peerUserId, peer).catch(() => setError("Could not update media."));
    }
  }, [sendOffer, syncLocalTracks]);

  const prepareMicrophoneInput = useCallback((rawStream: MediaStream) => {
    // Record the device this graph was opened with so the switch effect can
    // tell an already-applied change from a pending one.
    appliedMicrophoneCaptureRef.current = { deviceId: microphoneDeviceIdRef.current };
    return createMicrophoneInput(rawStream, microphoneVolumeRef.current, {
      noiseSuppression: noiseSuppressionRef.current
    });
  }, []);

  // Reached when the capture is gone and no replacement is coming: the device
  // was unplugged, or a reopen failed after the previous capture was released.
  const handleMicrophoneLost = useCallback((message: string) => {
    speakingRef.current = false;
    stopStream("mic");
    microphoneEnabledRef.current = false;
    microphoneOnBeforeDeafenRef.current = false;
    deafenTransitionRef.current += 1;
    const nextControls: VoiceControls = {
      ...controlsRef.current,
      mic: { ...controlsRef.current.mic, on: false }
    };
    controlsRef.current = nextControls;
    setControls(nextControls);
    setError(message);
    void emitMediaState({ mic: false, speaking: false });
    persistVoiceResume();
    renegotiatePeers();
  }, [emitMediaState, persistVoiceResume, renegotiatePeers, stopStream]);

  const activateMicrophoneInput = useCallback((input: MicrophoneInput) => {
    microphoneEndedCleanupRef.current?.();
    microphoneInputRef.current = input;
    localStreamsRef.current.mic = input.voiceStream;
    setMicrophoneMonitorStream(input.monitorStream);
    microphoneEndedCleanupRef.current = watchMicrophoneStreamEnd(input.rawStream, () => {
      if (microphoneInputRef.current !== input) return;
      handleMicrophoneLost("Microphone disconnected.");
    });
    startSpeakingMonitor(input.voiceStream);
  }, [handleMicrophoneLost, startSpeakingMonitor]);

  const setVisualSubscriptions = useCallback(async (targets: VisualTarget[]) => {
    if (!socket || !roomRef.current) {
      return { ok: false, error: "not_in_voice_room" } as const;
    }
    const roomId = roomRef.current;
    const response = await requestVisualSubscriptions(socket, { roomId, targets });
    if (response.ok && roomRef.current === roomId) {
      visualTargetsRef.current = response.targets;
      setVisualTargets(response.targets);
      persistVoiceResume(response.targets);
    }
    return response;
  }, [persistVoiceResume, socket]);

  const applyVoiceSnapshot = useCallback((nextSnapshot: VoiceSnapshot) => {
    setVoiceSnapshots((current) => ({ ...current, [nextSnapshot.roomId]: nextSnapshot }));
    if (roomRef.current !== nextSnapshot.roomId) return;

    const currentUserId = userIdRef.current;
    const self = nextSnapshot.members.find((member) => member.user.userId === currentUserId);
    if (self) {
      const previousModeration = moderationRef.current;
      moderationRef.current = self.moderation;
      setVoiceModeration(self.moderation);
      if (self.moderation.muted && !previousModeration.muted) {
        microphoneOnBeforeModerationMuteRef.current = controlsRef.current.mic.on;
        localStreamsRef.current.mic?.getAudioTracks().forEach((track) => { track.enabled = false; });
        speakingRef.current = false;
        const nextControls = { ...controlsRef.current, mic: { ...controlsRef.current.mic, on: false } };
        controlsRef.current = nextControls;
        setControls(nextControls);
        void emitMediaState({ mic: false, speaking: false });
      } else if (!self.moderation.muted && previousModeration.muted) {
        const restoreMic = microphoneOnBeforeModerationMuteRef.current && !controlsRef.current.deafen.on;
        const hasLiveTrack = localStreamsRef.current.mic?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
        localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
          track.enabled = restoreMic && track.readyState === "live";
        });
        const nextControls = { ...controlsRef.current, mic: { ...controlsRef.current.mic, on: restoreMic && hasLiveTrack } };
        controlsRef.current = nextControls;
        setControls(nextControls);
        void emitMediaState({ mic: nextControls.mic.on, speaking: false }).then((response) => {
          if (!response.ok) return;
          const accepted = { ...controlsRef.current, mic: { ...controlsRef.current.mic, on: response.state.media.mic } };
          controlsRef.current = accepted;
          setControls(accepted);
        });
      }
    }

    setRemoteStreams((current) => pruneRemoteStreamsForSnapshot(current, nextSnapshot.members));
    const membersByUserId = new Map(nextSnapshot.members.map((member) => [member.user.userId, member.media]));
    const activeMemberUserIds = new Set(membersByUserId.keys());
    activeVoiceMemberUserIdsRef.current = activeMemberUserIds;
    const trackedPeerUserIds = new Set([
      ...peersRef.current.keys(),
      ...peerRecoveryTimersRef.current.keys()
    ]);
    for (const stalePeerUserId of staleVoicePeerUserIds(trackedPeerUserIds, activeMemberUserIds)) {
      removePeer(stalePeerUserId);
    }
    const availableTargets = visualTargetsRef.current.filter((target) => membersByUserId.get(target.publisherUserId)?.[target.kind]);
    if (availableTargets.length !== visualTargetsRef.current.length) {
      visualTargetsRef.current = availableTargets;
      setVisualTargets(availableTargets);
      persistVoiceResume(availableTargets);
    }
    for (const member of nextSnapshot.members) {
      const peerUserId = member.user.userId;
      const currentUserId = userIdRef.current;
      const wasKnown = peersRef.current.has(peerUserId);
      const peer = ensurePeer(peerUserId);
      if (!wasKnown && peer && currentUserId && shouldInitiatePeerConnection(currentUserId, peerUserId)) {
        void sendOffer(peerUserId, peer).catch(() => setError("Could not start peer connection."));
      }
    }
  }, [emitMediaState, ensurePeer, persistVoiceResume, removePeer, sendOffer]);

  const join = useCallback(async (roomId: string, restoredTargets: VisualTarget[] = [], options: VoiceJoinOptions = {}) => {
    if (!socket || !user) {
      setError("Socket is not connected.");
      return false;
    }
    setError("");
    const previousControls = controlsRef.current;
    const previousMic = localStreamsRef.current.mic;
    const previousTrackStates = previousMic?.getAudioTracks().map((track) => [track, track.enabled] as const) ?? [];
    const attempt = ++joinAttemptRef.current;
    // A room that closes the microphone overrides the request, including the
    // default. The idle mover joins with no options, so without this the member
    // it parks arrives transmitting.
    const microphoneEnabled = afkRoomIdsRef.current.includes(roomId)
      ? false
      : options.microphoneEnabled ?? true;
    let mic = previousMic;
    let acquiredInput: MicrophoneInput | null = null;

    if (microphoneEnabled) {
      if (!mic) {
        try {
          const rawStream = await openMicrophoneCapture({ deviceId: microphoneDeviceIdRef.current });
          acquiredInput = prepareMicrophoneInput(rawStream);
          mic = acquiredInput.voiceStream;
        } catch {
          if (attempt === joinAttemptRef.current) {
            setError("Microphone permission is required to join voice.");
          }
          return false;
        }
      }
      mic.getAudioTracks().forEach((track) => { track.enabled = true; });
    }

    const nextControls: VoiceControls = {
      ...previousControls,
      mic: { ...previousControls.mic, on: microphoneEnabled },
      deafen: { ...previousControls.deafen, on: false }
    };
    const candidateStreams = {
      ...localStreamsRef.current,
      mic: microphoneEnabled ? mic : undefined
    };
    const response = await requestVoiceJoin(socket, {
      roomId,
      media: effectiveVoiceMediaState(nextControls, candidateStreams)
    });

    if (attempt !== joinAttemptRef.current || !response.ok) {
      if (acquiredInput) {
        acquiredInput.dispose();
      } else {
        previousTrackStates.forEach(([track, enabled]) => { track.enabled = enabled; });
      }
      if (attempt === joinAttemptRef.current && !response.ok) {
        setError("Could not join voice.");
      }
      return false;
    }

    const acceptedControls: VoiceControls = {
      ...nextControls,
      mic: { ...nextControls.mic, on: response.state.media.mic },
      deafen: { ...nextControls.deafen, on: response.state.media.deafened }
    };
    if (response.state.moderation.muted) {
      microphoneOnBeforeModerationMuteRef.current = microphoneEnabled;
    }
    moderationRef.current = response.state.moderation;
    setVoiceModeration(response.state.moderation);
    microphoneEnabledRef.current = response.state.media.mic;
    microphoneOnBeforeDeafenRef.current = response.state.media.mic;
    deafenTransitionRef.current += 1;
    controlsRef.current = acceptedControls;
    roomRef.current = roomId;
    setControls(acceptedControls);
    setActiveRoomId(roomId);
    if (!microphoneEnabled) {
      stopStream("mic");
    } else if (acquiredInput) {
      acquiredInput.voiceStream.getAudioTracks().forEach((track) => {
        track.enabled = response.state.media.mic && track.readyState === "live";
      });
      activateMicrophoneInput(acquiredInput);
    } else if (mic) {
      mic.getAudioTracks().forEach((track) => {
        track.enabled = response.state.media.mic && track.readyState === "live";
      });
    }
    socket.emit("voice:snapshot", roomId, (nextSnapshot) => {
      applyVoiceSnapshot(nextSnapshot);
    });
    if (restoredTargets.length > 0) {
      await setVisualSubscriptions(restoredTargets);
    } else {
      persistVoiceResume([]);
    }
    return true;
  }, [activateMicrophoneInput, applyVoiceSnapshot, persistVoiceResume, prepareMicrophoneInput, setVisualSubscriptions, socket, stopStream, user]);

  useEffect(() => {
    const previousStream = localStreamsRef.current.mic;
    if (!roomRef.current || !previousStream) return;
    // The active graph may already carry this device, either because the join
    // capture picked it up or because an unrelated dependency changed.
    const change = microphoneCaptureChange(appliedMicrophoneCaptureRef.current, { deviceId: microphoneDeviceId });
    if (change === "none") return;
    const requestId = ++microphoneSwitchRef.current;
    let cancelled = false;

    // Switching device holds both captures at once, which keeps a live track
    // published across the swap and leaves the previous capture to fall back to
    // if the new one never opens.
    void openMicrophoneCapture({ deviceId: microphoneDeviceId })
      .then((rawStream) => {
        const nextInput = prepareMicrophoneInput(rawStream);
        const nextTrack = nextInput.voiceStream.getAudioTracks()[0];
        if (!nextTrack || cancelled || requestId !== microphoneSwitchRef.current) {
          nextInput.dispose();
          return;
        }
        microphoneSwitchQueueRef.current = microphoneSwitchQueueRef.current.then(async () => {
          if (cancelled || requestId !== microphoneSwitchRef.current) {
            nextInput.dispose();
            return;
          }
          const activeStream = localStreamsRef.current.mic;
          const previousTrack = activeStream?.getAudioTracks()[0];
          if (!roomRef.current || !activeStream || !previousTrack) {
            nextInput.dispose();
            return;
          }
          nextTrack.enabled = controlsRef.current.mic.on && !controlsRef.current.deafen.on;
          try {
            await replaceMicrophoneTrack(peersRef.current.values(), previousTrack, nextTrack);
          } catch (cause) {
            await replaceMicrophoneTrack(peersRef.current.values(), nextTrack, previousTrack).catch(() => undefined);
            nextInput.dispose();
            throw cause;
          }
          if (!roomRef.current || requestId !== microphoneSwitchRef.current) {
            await replaceMicrophoneTrack(peersRef.current.values(), nextTrack, previousTrack).catch(() => undefined);
            nextInput.dispose();
            return;
          }
          stopStream("mic");
          activateMicrophoneInput(nextInput);
          setError("");
        }).catch(() => {
          nextInput.dispose();
          setError("The microphone could not be reopened. Using the previous microphone.");
        });
      })
      .catch(() => {
        if (cancelled || requestId !== microphoneSwitchRef.current) return;
        setError("The microphone could not be reopened. Using the previous microphone.");
      });

    return () => {
      cancelled = true;
    };
  }, [activateMicrophoneInput, activeRoomId, microphoneDeviceId, prepareMicrophoneInput, stopStream]);

  const leave = useCallback(() => {
    joinAttemptRef.current += 1;
    recoveryAttemptInFlightRef.current = false;
    if (recoveryRetryTimerRef.current !== null) {
      window.clearTimeout(recoveryRetryTimerRef.current);
      recoveryRetryTimerRef.current = null;
    }
    microphoneSwitchRef.current += 1;
    deafenTransitionRef.current += 1;
    microphoneOnBeforeDeafenRef.current = true;
    microphoneOnBeforeModerationMuteRef.current = true;
    moderationRef.current = { muted: false, deafened: false };
    setVoiceModeration({ muted: false, deafened: false });
    if (socket && roomRef.current) {
      socket.emit("voice:leave", roomRef.current);
    }
    stopStream("mic");
    stopStream("camera");
    stopStream("screen");
    closePeers();
    roomRef.current = null;
    visualTargetsRef.current = [];
    setVisualTargets([]);
    recoveryInProgressRef.current = false;
    resumeDeadlineRef.current = null;
    if (resumeDeadlineTimerRef.current) {
      window.clearTimeout(resumeDeadlineTimerRef.current);
      resumeDeadlineTimerRef.current = null;
    }
    const storage = voiceResumeStorage();
    if (storage) clearVoiceResume(storage);
    setActiveRoomId(null);
    setVoiceSnapshots({});
    setLocalPreviews([]);
    setError("");
    setControls(createInitialVoiceControls());
    releaseUnusedSharedAudioOutput();
  }, [closePeers, socket, stopStream]);

  const toggleMic = useCallback(async () => {
    let stream = localStreamsRef.current.mic;
    if (controlsRef.current.deafen.on || moderationRef.current.muted || micLockedByRoom()) return;
    deafenTransitionRef.current += 1;
    if (stream && !stream.getAudioTracks().some((track) => track.readyState === "live")) {
      speakingRef.current = false;
      stopStream("mic");
      stream = undefined;
      await emitMediaState({ mic: false, speaking: false });
    }
    if (!stream) {
      setError("");
      try {
        const rawStream = await openMicrophoneCapture({ deviceId: microphoneDeviceIdRef.current });
        const input = prepareMicrophoneInput(rawStream);
        stream = input.voiceStream;
        activateMicrophoneInput(input);
        const requestedControls: VoiceControls = {
          ...controlsRef.current,
          mic: { ...controlsRef.current.mic, on: true }
        };
        const media = effectiveVoiceMediaState(requestedControls, localStreamsRef.current);
        const nextControls: VoiceControls = {
          ...requestedControls,
          mic: { ...requestedControls.mic, on: media.mic }
        };
        microphoneEnabledRef.current = media.mic;
        controlsRef.current = nextControls;
        setControls(nextControls);
        await emitMediaState({ mic: media.mic, speaking: false });
        persistVoiceResume();
        renegotiatePeers();
      } catch {
        setError("Microphone permission was denied.");
      }
      return;
    }

    const requestedOn = !controlsRef.current.mic.on;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = requestedOn && track.readyState === "live";
    });
    const requestedControls: VoiceControls = {
      ...controlsRef.current,
      mic: { ...controlsRef.current.mic, on: requestedOn }
    };
    const media = effectiveVoiceMediaState(requestedControls, localStreamsRef.current);
    const nextControls: VoiceControls = {
      ...requestedControls,
      mic: { ...requestedControls.mic, on: media.mic }
    };
    if (!media.mic) {
      speakingRef.current = false;
    }
    controlsRef.current = nextControls;
    setControls(nextControls);
    await emitMediaState({ mic: media.mic, speaking: media.mic ? speakingRef.current : false });
  }, [activateMicrophoneInput, emitMediaState, persistVoiceResume, prepareMicrophoneInput, renegotiatePeers, stopStream]);

  const setDeafened = useCallback(async (deafened: boolean) => {
    if (!deafened && moderationRef.current.deafened) return false;
    if (controlsRef.current.deafen.on === deafened) return true;
    const transition = ++deafenTransitionRef.current;
    const nextDeafened = deafened;
    if (nextDeafened) {
      const previousControls = controlsRef.current;
      const previousRestorePreference = microphoneOnBeforeDeafenRef.current;
      const previousTrackStates = localStreamsRef.current.mic?.getAudioTracks()
        .map((track) => [track, track.enabled] as const) ?? [];
      microphoneOnBeforeDeafenRef.current = moderationRef.current.muted
        ? microphoneOnBeforeModerationMuteRef.current
        : controlsRef.current.mic.on;
      localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      speakingRef.current = false;
      const nextControls = toggleVoiceControl(controlsRef.current, "deafen");
      controlsRef.current = nextControls;
      setControls(nextControls);
      const media = effectiveVoiceMediaState(nextControls, localStreamsRef.current);
      const response = await emitMediaState({ deafened: media.deafened, mic: media.mic, speaking: false });
      if (transition !== deafenTransitionRef.current) return false;
      if (!response.ok) {
        previousTrackStates.forEach(([track, enabled]) => { track.enabled = enabled; });
        microphoneOnBeforeDeafenRef.current = previousRestorePreference;
        controlsRef.current = previousControls;
        setControls(previousControls);
        setError("Could not update deafen state.");
        return false;
      }
      localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
        track.enabled = response.state.media.mic && track.readyState === "live";
      });
      const acceptedControls: VoiceControls = {
        ...controlsRef.current,
        mic: { ...controlsRef.current.mic, on: response.state.media.mic },
        deafen: { ...controlsRef.current.deafen, on: response.state.media.deafened }
      };
      controlsRef.current = acceptedControls;
      setControls(acceptedControls);
      return acceptedControls.deafen.on === deafened;
    }

    const restoreMicrophoneOn = !moderationRef.current.muted
      && microphoneOnBeforeDeafenRef.current;
    const microphoneAvailable = localStreamsRef.current.mic?.getAudioTracks()
      .some((track) => track.readyState === "live") ?? false;
    localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
      track.enabled = restoreMicrophoneOn && track.readyState === "live";
    });
    const nextControls = toggleVoiceControl(controlsRef.current, "deafen", {
      microphoneAvailable,
      restoreMicrophoneOn
    });
    controlsRef.current = nextControls;
    setControls(nextControls);
    const media = effectiveVoiceMediaState(nextControls, localStreamsRef.current);
    const response = await emitMediaState({ deafened: media.deafened, mic: media.mic, speaking: false });
    if (transition !== deafenTransitionRef.current) return false;
    if (!response.ok) {
      localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      const failedControls: VoiceControls = {
        ...controlsRef.current,
        mic: { ...controlsRef.current.mic, on: false },
        deafen: { ...controlsRef.current.deafen, on: true }
      };
      controlsRef.current = failedControls;
      setControls(failedControls);
      setError("Could not update deafen state.");
      return false;
    }
    localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
      track.enabled = response.state.media.mic && track.readyState === "live";
    });
    const acceptedControls: VoiceControls = {
      ...controlsRef.current,
      mic: { ...controlsRef.current.mic, on: response.state.media.mic },
      deafen: { ...controlsRef.current.deafen, on: response.state.media.deafened }
    };
    controlsRef.current = acceptedControls;
    setControls(acceptedControls);
    return acceptedControls.deafen.on === deafened;
  }, [emitMediaState]);

  const toggleDeafen = useCallback(() => {
    void setDeafened(!controlsRef.current.deafen.on);
  }, [setDeafened]);

  const toggleCamera = useCallback(async () => {
    if (!activeRoomId) return;
    if (localStreamsRef.current.camera) {
      stopStream("camera");
      setControls((current) => ({ ...current, camera: { ...current.camera, on: false } }));
      await emitMediaState({ camera: false });
      renegotiatePeers();
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraintsFor("camera"));
      localStreamsRef.current.camera = stream;
      const ack = await emitMediaState({ camera: true });
      if (!ack.ok) {
        stopStream("camera");
        setError(ack.error === "visual_limit_reached" ? "Visual limit reached." : "Camera could not be enabled.");
        return;
      }
      setLocalPreviews((current) => [...current.filter((preview) => preview.kind !== "camera"), { kind: "camera", stream }]);
      setControls((current) => ({ ...current, camera: { ...current.camera, on: true } }));
      renegotiatePeers();
    } catch {
      setError("Camera permission was denied.");
    }
  }, [activeRoomId, emitMediaState, renegotiatePeers, stopStream]);

  const toggleScreen = useCallback(async () => {
    if (!activeRoomId) return;
    if (localStreamsRef.current.screen) {
      stopStream("screen");
      setControls((current) => ({ ...current, screenShare: { ...current.screenShare, on: false } }));
      await emitMediaState({ screen: false });
      renegotiatePeers();
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(mediaConstraintsFor("screen"));
      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack) configureScreenTrack(screenTrack);
      localStreamsRef.current.screen = stream;
      screenTrack?.addEventListener("ended", () => {
        stopStream("screen");
        setControls((current) => ({ ...current, screenShare: { ...current.screenShare, on: false } }));
        void emitMediaState({ screen: false });
        renegotiatePeers();
      }, { once: true });
      const ack = await emitMediaState({ screen: true });
      if (!ack.ok) {
        stopStream("screen");
        setError(ack.error === "visual_limit_reached" ? "Visual limit reached." : "Screen share could not be enabled.");
        return;
      }
      setLocalPreviews((current) => [...current.filter((preview) => preview.kind !== "screen"), { kind: "screen", stream }]);
      setControls((current) => ({ ...current, screenShare: { ...current.screenShare, on: true } }));
      renegotiatePeers();
    } catch {
      setError("Screen share permission was denied.");
    }
  }, [activeRoomId, emitMediaState, renegotiatePeers, stopStream]);

  const toggleControl = useCallback((key: VoiceControlKey) => {
    if (key === "mic") void toggleMic();
    else if (key === "camera") void toggleCamera();
    else if (key === "screenShare") void toggleScreen();
    else void toggleDeafen();
  }, [toggleCamera, toggleDeafen, toggleMic, toggleScreen]);

  const requestSnapshot = useCallback((roomId: string) => {
    if (!socket) return;
    socket.emit("voice:snapshot", roomId, (nextSnapshot) => {
      applyVoiceSnapshot(nextSnapshot);
    });
  }, [applyVoiceSnapshot, socket]);

  useEffect(() => {
    voiceRoomIdsRef.current = voiceRoomIds;
    if (socket?.connected) {
      for (const roomId of voiceRoomIds) requestSnapshot(roomId);
    }
  }, [requestSnapshot, socket, voiceRoomIds]);

  const handleSignal = useCallback(async (payload: { fromUserId: string; signal: RtcSignal }) => {
    const signal = payload.signal as PeerSignal;
    const peer = ensurePeer(payload.fromUserId);
    if (!peer) return;
    if (signal.type === "offer") {
      rememberRemoteStreamKinds(payload.fromUserId, signal.streams);
      const hasOfferCollision = makingOfferPeersRef.current.has(payload.fromUserId) || peer.signalingState !== "stable";
      const ignoreOffer = shouldIgnoreIncomingOffer(
        userIdRef.current ?? "",
        payload.fromUserId,
        peer.signalingState,
        makingOfferPeersRef.current.has(payload.fromUserId)
      );
      if (ignoreOffer) {
        ignoredOfferPeersRef.current.add(payload.fromUserId);
        pendingCandidatesRef.current.delete(payload.fromUserId);
        return;
      }
      if (hasOfferCollision) {
        offerGenerationsRef.current.set(
          payload.fromUserId,
          (offerGenerationsRef.current.get(payload.fromUserId) ?? 0) + 1
        );
        if (peer.signalingState !== "stable") {
          await peer.setLocalDescription({ type: "rollback" });
        }
      }
      ignoredOfferPeersRef.current.delete(payload.fromUserId);
      await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await flushPendingCandidates(payload.fromUserId, peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (socket && roomRef.current) {
        socket.emit("rtc:signal", {
          roomId: roomRef.current,
          toUserId: payload.fromUserId,
          signal: { type: "answer", sdp: answer.sdp ?? "", streams: localStreamDescriptors(payload.fromUserId) }
        });
      }
      if (pendingOfferPeersRef.current.delete(payload.fromUserId)) {
        void sendOffer(payload.fromUserId, peer).catch(() => setError("Could not update media."));
      }
      return;
    }
    if (signal.type === "answer") {
      ignoredOfferPeersRef.current.delete(payload.fromUserId);
      rememberRemoteStreamKinds(payload.fromUserId, signal.streams);
      await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await flushPendingCandidates(payload.fromUserId, peer);
      if (pendingOfferPeersRef.current.delete(payload.fromUserId)) {
        void sendOffer(payload.fromUserId, peer).catch(() => setError("Could not update media."));
      }
      return;
    }
    if (signal.type === "candidate") {
      if (ignoredOfferPeersRef.current.has(payload.fromUserId)) return;
      if (!peer.remoteDescription) {
        const candidates = pendingCandidatesRef.current.get(payload.fromUserId) ?? [];
        if (candidates.length < 128) candidates.push(signal.candidate);
        pendingCandidatesRef.current.set(payload.fromUserId, candidates);
        return;
      }
      await peer.addIceCandidate(signal.candidate);
    }
  }, [ensurePeer, flushPendingCandidates, localStreamDescriptors, rememberRemoteStreamKinds, sendOffer, socket]);

  useEffect(() => {
    const saveResume = () => {
      persistVoiceResume(visualTargetsRef.current, !recoveryInProgressRef.current);
      recoveryInProgressRef.current = true;
    };
    window.addEventListener("pagehide", saveResume);
    return () => window.removeEventListener("pagehide", saveResume);
  }, [persistVoiceResume]);

  useEffect(() => {
    if (!socket) return;
    let disposed = false;
    const requestKnownSnapshots = () => {
      for (const roomId of voiceRoomIdsRef.current) requestSnapshot(roomId);
    };
    const clearRecoveryRetry = () => {
      if (recoveryRetryTimerRef.current === null) return;
      window.clearTimeout(recoveryRetryTimerRef.current);
      recoveryRetryTimerRef.current = null;
    };
    const scheduleRecovery = (delay: number) => {
      if (
        disposed ||
        recoveryAttemptInFlightRef.current ||
        recoveryRetryTimerRef.current !== null ||
        !roomRef.current ||
        !socket.connected
      ) return;
      if (resumeDeadlineRef.current && Date.now() >= resumeDeadlineRef.current) {
        leave();
        return;
      }
      recoveryRetryTimerRef.current = window.setTimeout(() => {
        recoveryRetryTimerRef.current = null;
        void attemptRecovery();
      }, delay);
    };
    const attemptRecovery = async () => {
      const activeRoomId = roomRef.current;
      if (disposed || recoveryAttemptInFlightRef.current || !activeRoomId || !socket.connected) return;
      if (resumeDeadlineRef.current && Date.now() >= resumeDeadlineRef.current) {
        leave();
        return;
      }

      recoveryAttemptInFlightRef.current = true;
      const attempt = ++joinAttemptRef.current;
      let retry = false;
      try {
        const media = effectiveVoiceMediaState(controlsRef.current, localStreamsRef.current);
        const response = await requestVoiceJoin(socket, { roomId: activeRoomId, media });
        if (disposed || attempt !== joinAttemptRef.current || roomRef.current !== activeRoomId || !socket.connected) return;
        if (!response.ok) {
          setError("Could not restore voice connection.");
          retry = true;
          return;
        }

        requestKnownSnapshots();
        const subscription = await setVisualSubscriptions(visualTargetsRef.current);
        if (disposed || attempt !== joinAttemptRef.current || roomRef.current !== activeRoomId || !socket.connected) return;
        if (!subscription.ok) {
          setError("Could not restore stream connection.");
          retry = true;
          return;
        }

        setError("");
        recoveryInProgressRef.current = false;
        resumeDeadlineRef.current = null;
      } finally {
        if (attempt === joinAttemptRef.current) {
          recoveryAttemptInFlightRef.current = false;
          if (retry && !disposed && roomRef.current === activeRoomId && socket.connected) {
            scheduleRecovery(voiceRecoveryRetryDelayMs);
          }
        }
      }
    };
    const onConnect = () => {
      const activeRoomId = roomRef.current;
      if (activeRoomId) {
        if (recoveryInProgressRef.current && resumeDeadlineRef.current && Date.now() >= resumeDeadlineRef.current) {
          leave();
          return;
        }
        if (resumeDeadlineTimerRef.current) {
          window.clearTimeout(resumeDeadlineTimerRef.current);
          resumeDeadlineTimerRef.current = null;
        }
        clearRecoveryRetry();
        scheduleRecovery(0);
        return;
      }

      requestKnownSnapshots();
      const storage = voiceResumeStorage();
      const record = storage ? readVoiceResume(storage) : null;
      if (!record || resumeAttemptRef.current) return;
      resumeDeadlineRef.current = record.expiresAt;
      recoveryInProgressRef.current = true;
      resumeAttemptRef.current = true;
      void join(record.roomId, record.targets, { microphoneEnabled: record.microphoneEnabled }).finally(() => {
        if (roomRef.current === record.roomId) {
          recoveryInProgressRef.current = false;
          resumeDeadlineRef.current = null;
        }
        resumeAttemptRef.current = false;
      });
    };
    const onDisconnect = () => {
      if (!roomRef.current) return;
      joinAttemptRef.current += 1;
      recoveryAttemptInFlightRef.current = false;
      clearRecoveryRetry();
      persistVoiceResume(visualTargetsRef.current, !recoveryInProgressRef.current);
      recoveryInProgressRef.current = true;
      if (resumeDeadlineTimerRef.current) window.clearTimeout(resumeDeadlineTimerRef.current);
      const delay = Math.max(0, (resumeDeadlineRef.current ?? Date.now()) - Date.now());
      resumeDeadlineTimerRef.current = window.setTimeout(() => {
        resumeDeadlineTimerRef.current = null;
        if (!socket.connected && roomRef.current) leave();
      }, delay);
      closePeers();
      stopStream("camera");
      stopStream("screen");
      setControls((current) => ({
        ...current,
        camera: { ...current.camera, on: false },
        screenShare: { ...current.screenShare, on: false }
      }));
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    if (socket.connected) onConnect();
    return () => {
      disposed = true;
      clearRecoveryRetry();
      recoveryAttemptInFlightRef.current = false;
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [closePeers, join, leave, persistVoiceResume, requestSnapshot, setVisualSubscriptions, socket, stopStream]);

  useEffect(() => {
    if (!socket) return;
    const onSnapshot = (nextSnapshot: VoiceSnapshot) => applyVoiceSnapshot(nextSnapshot);
    const onVoiceJoined = ({ roomId, user: joinedUser }: { roomId: string; user: { userId: string } }) => {
      if (roomRef.current !== roomId) {
        return;
      }
      const currentUserId = userIdRef.current;
      const wasKnown = peersRef.current.has(joinedUser.userId);
      const peer = ensurePeer(joinedUser.userId);
      if (wasKnown || !peer || !currentUserId || !shouldInitiatePeerConnection(currentUserId, joinedUser.userId)) {
        return;
      }
      void sendOffer(joinedUser.userId, peer).catch(() => setError("Could not start peer connection."));
    };
    const onSignal = (payload: { fromUserId: string; signal: RtcSignal }) => {
      void handleSignal(payload).catch(() => setError("RTC signal could not be handled."));
    };
    const onVisualSubscriberState = (payload: { roomId: string; viewerUserId: string; subscribedKinds: VisualMediaKind[] }) => {
      if (roomRef.current !== payload.roomId) return;
      viewerVisualSubscriptionsRef.current.set(payload.viewerUserId, new Set(payload.subscribedKinds));
      const peer = ensurePeer(payload.viewerUserId);
      if (!peer) return;
      syncLocalTracks(peer, payload.viewerUserId);
      void sendOffer(payload.viewerUserId, peer).catch(() => setError("Could not update media."));
    };
    socket.on("voice:snapshot", onSnapshot);
    socket.on("voice:joined", onVoiceJoined);
    socket.on("voice:visualSubscriberState", onVisualSubscriberState);
    socket.on("rtc:signal", onSignal);
    return () => {
      socket.off("voice:snapshot", onSnapshot);
      socket.off("voice:joined", onVoiceJoined);
      socket.off("voice:visualSubscriberState", onVisualSubscriberState);
      socket.off("rtc:signal", onSignal);
    };
  }, [applyVoiceSnapshot, ensurePeer, handleSignal, sendOffer, socket, syncLocalTracks]);

  useEffect(() => {
    if (!user) {
      leave();
    }
  }, [leave, user]);

  return {
    activeRoomId,
    controls,
    error,
    join,
    leave,
    localPreviews,
    microphoneMonitorStream,
    requestSnapshot,
    remoteStreams,
    setDeafened,
    peerConnectionStates,
    setVisualSubscriptions,
    visualTargets,
    voiceSnapshots,
    voiceModeration,
    toggleControl
  };
}

function voiceResumeStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
