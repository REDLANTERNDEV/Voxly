import { ScreenQualityOwner } from "./screenQualityController.js";
import { ScreenRecoveryOwner, type ScreenPlaybackStatus } from "./screenRecovery.js";
import { VoicePeerOwner } from "./voicePeerOwner.js";
import { MicrophoneOwner } from "./microphoneOwner.js";
import { stepMicrophoneHealth, type MicrophoneHealthState } from "./microphoneHealth.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { isRtcRecoveryRequest } from "@voxly/shared";
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
import type { VoiceErrorKey } from "./i18n.js";
import {
  createInitialVoiceControls,
  toggleVoiceControl,
  type VoiceControlKey,
  type VoiceControls
} from "./voiceControls.js";
import { createPendingCaptures, desktopCallState } from "./desktopCallState.js";
import { DesktopMicrophoneGate } from "./desktopMicrophone.js";
import {
  createDesktopMuteReceiver,
  readDesktopMicrophoneState,
  subscribeDesktopMicrophone,
  subscribeDesktopMute
} from "./desktopVoice.js";
import { createPendingMediaOperation } from "./pendingMediaOperation.js";
import {
  configureScreenTrack,
  effectiveVoiceMediaState,
  ensureOfferableAudioSection,
  mediaConstraintsFor,
  replaceMicrophoneTrack,
  watchMicrophoneStreamEnd
} from "./voiceMedia.js";
import { requestVoiceJoin } from "./voiceJoin.js";
import { requestVisualSubscriptions, voiceRecoveryRetryDelayMs } from "./voiceRecovery.js";
import { DEFAULT_NOISE_SUPPRESSION, microphoneCaptureChange, openMicrophoneCapture } from "./noiseSuppression.js";
import { voiceDiagnostics } from "./voiceDiagnostics.js";
import { releaseUnusedSharedAudioOutput, voiceOutputDiagnostics } from "./audioOutput.js";
import {
  shouldIgnoreIncomingOffer,
  shouldInitiatePeerConnection,
  staleVoicePeerUserIds,
  type PeerConnectionState
} from "./voiceNegotiation.js";
import {
  advancePeerRecovery,
  initialPeerRecoveryState,
  isPeerConnectionReady,
  voicePeerConnectionTimeoutMs,
  voicePeerRecoveryGraceMs,
  type PeerRecoveryEvent,
  type PeerRecoveryState
} from "./voicePeerRecovery.js";
import { clearVoiceResume, readVoiceResume, voiceResumeWindowMs, writeVoiceResume } from "./voiceResume.js";
import {
  mediaStreamForTrack,
  pruneRemoteStreamsForSnapshot,
  removeRemoteStream,
  upsertRemoteStream,
  type RemoteMediaKind,
  type RemoteStreamState
} from "./voiceStreams.js";
import { createAudibleActivityState, updateAudibleActivity, voiceActivitySampleMs } from "./voiceActivity.js";
import { createMicrophoneInput, type MicrophoneInput } from "./microphoneInput.js";
import { volumeGain } from "./voiceVolume.js";

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
  microphoneDevices?: readonly Pick<MediaDeviceInfo, "deviceId">[];
  microphoneDeviceRevision?: number;
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
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "recovery-request" };

type LocalStreamKind = "mic" | "camera" | "screen";

interface SignalStreamDescriptor {
  id: string;
  kind: RemoteMediaKind;
}

interface PeerRemovalOptions {
  expectedPeer?: RTCPeerConnection;
  preserveVisualSubscriptions?: boolean;
  preserveRecoveryState?: boolean;
}

export function useVoiceMedia({
  socket,
  user,
  iceServers,
  voiceRoomIds,
  microphoneDeviceId = "",
  microphoneDevices = [],
  microphoneDeviceRevision = 0,
  microphoneVolume = 100,
  noiseSuppression = DEFAULT_NOISE_SUPPRESSION,
  afkRoomIds = []
}: UseVoiceMediaInput) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [joinPending, setJoinPending] = useState(false);
  const [pendingCaptures] = useState(createPendingCaptures);
  const [pendingJoin] = useState(() => createPendingMediaOperation(setJoinPending));
  const [controls, setControls] = useState<VoiceControls>(() => createInitialVoiceControls());
  const [voiceModeration, setVoiceModeration] = useState<VoiceModerationState>({ muted: false, deafened: false });
  const [voiceSnapshots, setVoiceSnapshots] = useState<Record<string, VoiceSnapshot>>({});
  const voiceSnapshotsRef = useRef<Record<string, VoiceSnapshot>>({});
  const [visualTargets, setVisualTargets] = useState<VisualTarget[]>([]);
  const [screenPlaybackStates, setScreenPlaybackStates] = useState<Record<string, ScreenPlaybackStatus>>({});
  const screenRecoveryRef = useRef<ScreenRecoveryOwner | null>(null);
  const screenRecoveryRoomRef = useRef<string | null>(null);
  const syncScreenRecoveryRef = useRef<() => void>(() => {});
  const [remoteStreams, setRemoteStreams] = useState<RemoteStreamState[]>([]);
  const [peerConnectionStates, setPeerConnectionStates] = useState<Record<string, PeerConnectionState>>({});
  const [localPreviews, setLocalPreviews] = useState<LocalPreviewState[]>([]);
  const [microphoneHealthWarning, setMicrophoneHealthWarning] = useState(false);
  const [microphoneMonitorStream, setMicrophoneMonitorStream] = useState<MediaStream | null>(null);
  const [error, setErrorState] = useState<VoiceErrorKey | "">("");
  const [errorRevision, setErrorRevision] = useState(0);
  const setError = useCallback((next: VoiceErrorKey | "") => {
    setErrorState(next);
    if (next) setErrorRevision((current) => current + 1);
  }, []);
  const localStreamsRef = useRef<Partial<Record<LocalStreamKind, MediaStream>>>({});
  const [microphoneInputRef] = useState(() => new MicrophoneOwner());
  const [screenQualityOwner] = useState(() => new ScreenQualityOwner());
  const [peerOwner] = useState(() => new VoicePeerOwner());
  const iceServersRef = useRef(iceServers);
  const microphoneDeviceIdRef = useRef(microphoneDeviceId);
  const microphoneVolumeRef = useRef(microphoneVolume);
  const noiseSuppressionRef = useRef(noiseSuppression);
  const appliedMicrophoneCaptureRef = useRef({ deviceId: microphoneDeviceId });
  const mediaInstanceIdRef = useRef<string | null>(null);
  const remoteMediaInstancesRef = useRef(new Map<string, string>());
  const offeredPeersRef = useRef(new Set<RTCPeerConnection>());
  const peersRef = useRef(peerOwner.peers);
  const remoteStreamKindsRef = useRef<Map<string, Map<string, RemoteMediaKind>>>(new Map());
  const viewerVisualSubscriptionsRef = useRef<Map<string, Set<VisualMediaKind>>>(new Map());
  const visualTargetsRef = useRef<VisualTarget[]>([]);
  const makingOfferPeersRef = useRef<Set<string>>(new Set());
  const offerGenerationsRef = useRef<Map<string, number>>(new Map());
  const pendingOfferPeersRef = useRef<Set<string>>(new Set());
  const peerRecoveryTimersRef = useRef<Map<string, number>>(new Map());
  const peerConnectionTimeoutsRef = useRef<Map<string, number>>(new Map());
  const peerGenerationsRef = useRef(peerOwner.generations);
  const peerRecoveryStatesRef = useRef<Map<string, PeerRecoveryState>>(new Map());
  const activeVoiceMemberUserIdsRef = useRef<Set<string>>(new Set());
  const pendingCandidatesRef = useRef<Map<string, { generation: number; candidates: RTCIceCandidateInit[] }>>(
    new Map()
  );
  const microphoneSwitchRef = useRef(0);
  const microphoneRecoveryRef = useRef<{ roomId: string; deviceId: string; enabled: boolean } | null>(null);
  const microphoneRecoveryBusyRef = useRef(false);
  const microphoneRecoveryQueuedRef = useRef(false);
  const [microphoneRecoveryRevision, setMicrophoneRecoveryRevision] = useState(0);
  const microphoneSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ignoredOfferPeersRef = useRef<Set<string>>(new Set());
  const recoverPeerRef = useRef<(peerUserId: string) => void>(() => undefined);
  const schedulePeerRecoveryRef = useRef<
    (peerUserId: string, peer?: RTCPeerConnection, event?: PeerRecoveryEvent) => boolean
  >(() => false);
  const resumeAttemptRef = useRef(false);
  const recoveryInProgressRef = useRef(false);
  const joinAttemptRef = useRef(0);
  const resumeDeadlineRef = useRef<number | null>(null);
  const resumeDeadlineTimerRef = useRef<number | null>(null);
  const peerGraceTimerRef = useRef<number | null>(null);
  const recoveryRetryTimerRef = useRef<number | null>(null);
  const recoveryAttemptInFlightRef = useRef(false);
  const controlsRef = useRef(controls);
  const desktopMicrophoneRef = useRef<DesktopMicrophoneGate | null>(null);
  if (!desktopMicrophoneRef.current)
    desktopMicrophoneRef.current = new DesktopMicrophoneGate(readDesktopMicrophoneState(window).mode);
  const desktopMicrophone = desktopMicrophoneRef.current;
  const desktopMicrophoneTransitionRef = useRef(0);
  const voiceRoomIdsRef = useRef(voiceRoomIds);
  const afkRoomIdsRef = useRef(afkRoomIds);
  /** True while the member occupies a room that closes the microphone. */
  const micLockedByRoom = useCallback(
    () => Boolean(roomRef.current && afkRoomIdsRef.current.includes(roomRef.current)),
    []
  );
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

  const isCurrentPeer = useCallback((peerUserId: string, peer: RTCPeerConnection, peerGeneration: number) => {
    return (
      peersRef.current.get(peerUserId) === peer &&
      peerGenerationsRef.current.get(peerUserId) === peerGeneration &&
      peer.connectionState !== "closed"
    );
  }, []);

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
    const expiresAt =
      resetDeadline || !resumeDeadlineRef.current || resumeDeadlineRef.current <= now
        ? now + voiceResumeWindowMs
        : resumeDeadlineRef.current;
    resumeDeadlineRef.current = expiresAt;
    if (storage) writeVoiceResume(storage, roomRef.current, targets, now, expiresAt, microphoneEnabledRef.current);
  }, []);

  const emitMediaState = useCallback(
    (media: Partial<VoiceMediaState>) => {
      if (!socket || !roomRef.current) {
        return Promise.resolve<VoiceSetMediaAck>({ ok: false, error: "not_in_voice_room" });
      }

      return new Promise<VoiceSetMediaAck>((resolve) => {
        socket.emit("voice:setMediaState", { roomId: roomRef.current as string, media }, resolve);
      });
    },
    [socket]
  );

  useEffect(
    () =>
      subscribeDesktopMicrophone(window, (state) => {
        const live =
          localStreamsRef.current.mic?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
        const allowed = Boolean(
          roomRef.current &&
          socket?.connected &&
          live &&
          controlsRef.current.mic.on &&
          !controlsRef.current.deafen.on &&
          !moderationRef.current.muted &&
          !micLockedByRoom()
        );
        desktopMicrophone.update(state, allowed);
        desktopMicrophone.apply(localStreamsRef.current.mic?.getAudioTracks() ?? [], allowed);
        if (!roomRef.current || !socket?.connected) return;
        const room = roomRef.current;
        const transition = ++desktopMicrophoneTransitionRef.current;
        const media = effectiveVoiceMediaState(controlsRef.current, localStreamsRef.current);
        if (!media.mic) speakingRef.current = false;
        void emitMediaState({ mic: media.mic, speaking: media.mic && speakingRef.current }).then((response) => {
          if (room !== roomRef.current || transition !== desktopMicrophoneTransitionRef.current) return;
          if (!response.ok || !response.state.media.mic) {
            if (media.mic) desktopMicrophone.resetHolds();
            desktopMicrophone.apply(localStreamsRef.current.mic?.getAudioTracks() ?? [], false);
            speakingRef.current = false;
          }
        });
      }),
    [desktopMicrophone, emitMediaState, micLockedByRoom, socket]
  );

  const setLocalSpeaking = useCallback(
    (next: boolean) => {
      if (speakingRef.current === next) {
        return;
      }
      speakingRef.current = next;
      void emitMediaState({ speaking: next });
    },
    [emitMediaState]
  );

  const stopSpeakingMonitor = useCallback(() => {
    speakingCleanupRef.current?.();
    speakingCleanupRef.current = null;
    setLocalSpeaking(false);
  }, [setLocalSpeaking]);

  const startSpeakingMonitor = useCallback(
    (input: MicrophoneInput) => {
      stopSpeakingMonitor();
      if (input.analyser) {
        const analyser = input.analyser;
        const samples = new Float32Array(analyser.fftSize || 2048);
        let activity = createAudibleActivityState();

        const interval = window.setInterval(() => {
          const micIsLive =
            localStreamsRef.current.mic
              ?.getAudioTracks()
              .some((track) => track.enabled && track.readyState === "live") ?? false;
          if (!micIsLive) {
            setLocalSpeaking(false);
            return;
          }

          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) {
            sum += value * value;
          }
          const outputRms = Math.sqrt(sum / samples.length) * volumeGain(microphoneVolumeRef.current);
          activity = updateAudibleActivity(activity, outputRms, Date.now());
          setLocalSpeaking(activity.speaking);
        }, voiceActivitySampleMs);

        speakingCleanupRef.current = () => {
          window.clearInterval(interval);
        };
        return;
      }

      const AudioContextClass =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        return;
      }

      try {
        const context = new AudioContextClass();
        const source = context.createMediaStreamSource(input.rawStream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        const samples = new Float32Array(analyser.fftSize);
        let activity = createAudibleActivityState();
        source.connect(analyser);

        const interval = window.setInterval(() => {
          const micIsLive =
            localStreamsRef.current.mic
              ?.getAudioTracks()
              .some((track) => track.enabled && track.readyState === "live") ?? false;
          if (!micIsLive) {
            setLocalSpeaking(false);
            return;
          }

          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) {
            sum += value * value;
          }
          const outputRms = Math.sqrt(sum / samples.length) * volumeGain(microphoneVolumeRef.current);
          activity = updateAudibleActivity(activity, outputRms, Date.now());
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
    },
    [setLocalSpeaking, stopSpeakingMonitor]
  );

  const stopStream = useCallback(
    (kind: LocalStreamKind) => {
      const stream = localStreamsRef.current[kind];
      if (kind === "screen") screenQualityOwner.clear();
      if (kind === "mic") {
        microphoneEndedCleanupRef.current?.();
        microphoneEndedCleanupRef.current = null;
        desktopMicrophone.forget(stream?.getAudioTracks() ?? []);
        microphoneInputRef.release();
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
    },
    [stopSpeakingMonitor]
  );

  const closePeers = useCallback(() => {
    screenQualityOwner.clear();
    peerOwner.clear();
    mediaInstanceIdRef.current = null;
    remoteMediaInstancesRef.current.clear();
    offeredPeersRef.current.clear();
    remoteStreamKindsRef.current.clear();
    viewerVisualSubscriptionsRef.current.clear();
    makingOfferPeersRef.current.clear();
    offerGenerationsRef.current.clear();
    pendingOfferPeersRef.current.clear();
    peerGenerationsRef.current.clear();
    peerRecoveryStatesRef.current.clear();
    for (const timer of peerRecoveryTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    peerRecoveryTimersRef.current.clear();
    for (const timer of peerConnectionTimeoutsRef.current.values()) {
      window.clearTimeout(timer);
    }
    peerConnectionTimeoutsRef.current.clear();
    activeVoiceMemberUserIdsRef.current.clear();
    pendingCandidatesRef.current.clear();
    ignoredOfferPeersRef.current.clear();
    setRemoteStreams([]);
    setPeerConnectionStates({});
  }, []);

  const removePeer = useCallback((peerUserId: string, options: PeerRemovalOptions = {}) => {
    const peer = peersRef.current.get(peerUserId);
    if (options.expectedPeer && peer !== options.expectedPeer) return false;
    screenQualityOwner.release(peerUserId);
    if (peer) offeredPeersRef.current.delete(peer);
    peerOwner.release(peerUserId, peer);
    const connectionTimeout = peerConnectionTimeoutsRef.current.get(peerUserId);
    if (connectionTimeout !== undefined) window.clearTimeout(connectionTimeout);
    peerConnectionTimeoutsRef.current.delete(peerUserId);
    peersRef.current.delete(peerUserId);
    remoteStreamKindsRef.current.delete(peerUserId);
    if (!options.preserveVisualSubscriptions) {
      viewerVisualSubscriptionsRef.current.delete(peerUserId);
    }
    makingOfferPeersRef.current.delete(peerUserId);
    offerGenerationsRef.current.delete(peerUserId);
    pendingOfferPeersRef.current.delete(peerUserId);
    pendingCandidatesRef.current.delete(peerUserId);
    if (!options.preserveRecoveryState) {
      peerRecoveryStatesRef.current.delete(peerUserId);
    }
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

  const schedulePeerRecovery = useCallback(
    (peerUserId: string, expectedPeer?: RTCPeerConnection, event: PeerRecoveryEvent = { type: "failed" }) => {
      const peer = peersRef.current.get(peerUserId);
      if (!peer || (expectedPeer && peer !== expectedPeer)) return false;
      const peerGeneration = peerGenerationsRef.current.get(peerUserId);
      if (peerGeneration === undefined || !isCurrentPeer(peerUserId, peer, peerGeneration)) return false;
      const transition = advancePeerRecovery(
        peerRecoveryStatesRef.current.get(peerUserId) ?? initialPeerRecoveryState(),
        event,
        Date.now()
      );
      peerRecoveryStatesRef.current.set(peerUserId, transition.state);
      if (
        !removePeer(peerUserId, {
          expectedPeer: peer,
          preserveVisualSubscriptions: true,
          preserveRecoveryState: true
        })
      )
        return false;
      const replacementGeneration = peerGenerationsRef.current.get(peerUserId);
      const delay = Math.max(0, (transition.state.nextRetryAt ?? Date.now()) - Date.now());
      const timer = window.setTimeout(() => {
        peerRecoveryTimersRef.current.delete(peerUserId);
        if (!activeVoiceMemberUserIdsRef.current.has(peerUserId)) return;
        if (peerGenerationsRef.current.get(peerUserId) !== replacementGeneration) return;
        recoverPeerRef.current(peerUserId);
      }, delay);
      peerRecoveryTimersRef.current.set(peerUserId, timer);
      return true;
    },
    [isCurrentPeer, removePeer]
  );

  useEffect(() => {
    schedulePeerRecoveryRef.current = schedulePeerRecovery;
    return () => {
      schedulePeerRecoveryRef.current = () => false;
    };
  }, [schedulePeerRecovery]);

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

  const rememberRemoteStreamKinds = useCallback(
    (peerUserId: string, descriptors: SignalStreamDescriptor[] | undefined) => {
      if (!descriptors?.length) {
        return;
      }
      const streamKinds = remoteStreamKindsRef.current.get(peerUserId) ?? new Map<string, RemoteMediaKind>();
      for (const descriptor of descriptors) {
        streamKinds.set(descriptor.id, descriptor.kind);
      }
      remoteStreamKindsRef.current.set(peerUserId, streamKinds);
    },
    []
  );

  const syncLocalTracks = useCallback((peer: RTCPeerConnection, peerUserId: string) => {
    const currentTracks = new Set<MediaStreamTrack>();
    let screenSender: RTCRtpSender | null = null;
    let screenTrack: MediaStreamTrack | null = null;
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
          screenSender = sender;
          screenTrack = track;
        }
      }
    }

    screenQualityOwner.sync(peerUserId, peer, screenSender, screenTrack);
    for (const sender of peer.getSenders()) {
      if (sender.track && !currentTracks.has(sender.track)) {
        peer.removeTrack(sender);
      }
    }
  }, []);

  const sendOffer = useCallback(
    async (peerUserId: string, peer: RTCPeerConnection) => {
      if (!socket || !roomRef.current) return;
      const peerGeneration = peerGenerationsRef.current.get(peerUserId);
      if (peerGeneration === undefined || !isCurrentPeer(peerUserId, peer, peerGeneration)) return;
      if (peer.signalingState !== "stable" || makingOfferPeersRef.current.has(peerUserId)) {
        pendingOfferPeersRef.current.add(peerUserId);
        return;
      }
      makingOfferPeersRef.current.add(peerUserId);
      const offerGeneration = (offerGenerationsRef.current.get(peerUserId) ?? 0) + 1;
      offerGenerationsRef.current.set(peerUserId, offerGeneration);
      try {
        // Inside the try so a closed peer cannot leave this one marked as forever
        // making an offer.
        ensureOfferableAudioSection(peer);
        const offer = await peer.createOffer();
        if (
          offerGenerationsRef.current.get(peerUserId) !== offerGeneration ||
          !isCurrentPeer(peerUserId, peer, peerGeneration) ||
          peer.signalingState !== "stable" ||
          !roomRef.current
        )
          return;
        await peer.setLocalDescription(offer);
        if (
          offerGenerationsRef.current.get(peerUserId) !== offerGeneration ||
          !isCurrentPeer(peerUserId, peer, peerGeneration) ||
          (peer.signalingState as RTCSignalingState) !== "have-local-offer" ||
          peer.localDescription?.type !== "offer" ||
          !roomRef.current
        )
          return;
        offeredPeersRef.current.add(peer);
        socket.emit("rtc:signal", {
          roomId: roomRef.current,
          toUserId: peerUserId,
          signal: { type: "offer", sdp: peer.localDescription.sdp ?? "", streams: localStreamDescriptors(peerUserId) }
        });
      } finally {
        if (isCurrentPeer(peerUserId, peer, peerGeneration)) {
          makingOfferPeersRef.current.delete(peerUserId);
        }
      }
    },
    [isCurrentPeer, localStreamDescriptors, socket]
  );

  const requestPeerRecovery = useCallback(
    (peerUserId: string, peer: RTCPeerConnection, recoverMedia = false) => {
      if (!socket || !roomRef.current || !userIdRef.current) return false;
      if (!isCurrentPeer(peerUserId, peer, peerGenerationsRef.current.get(peerUserId) ?? -1)) return false;
      // A connected ICE route can still carry no audio. In that case the remote
      // sender must rebuild; restarting only this listener's ICE cannot do it.
      if (shouldInitiatePeerConnection(userIdRef.current, peerUserId) && !recoverMedia) {
        try {
          peer.restartIce();
          void sendOffer(peerUserId, peer).catch(() =>
            schedulePeerRecoveryRef.current(peerUserId, peer, { type: "restart_failed" })
          );
        } catch {
          schedulePeerRecoveryRef.current(peerUserId, peer, { type: "restart_failed" });
        }
        return true;
      }
      socket.emit("rtc:signal", {
        roomId: roomRef.current,
        toUserId: peerUserId,
        signal: { type: "recovery-request" }
      });
      return true;
    },
    [isCurrentPeer, sendOffer, socket]
  );

  const ensurePeer = useCallback(
    (peerUserId: string) => {
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

      const peerGeneration = (peerGenerationsRef.current.get(peerUserId) ?? 0) + 1;
      peerGenerationsRef.current.set(peerUserId, peerGeneration);
      if (!peerRecoveryStatesRef.current.has(peerUserId)) {
        peerRecoveryStatesRef.current.set(peerUserId, initialPeerRecoveryState());
      }
      const recovering = peerRecoveryStatesRef.current.get(peerUserId)?.phase === "rebuilding";
      const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
      peersRef.current.set(peerUserId, peer);
      setPeerConnectionStates((current) => ({ ...current, [peerUserId]: recovering ? "reconnecting" : "connecting" }));
      syncLocalTracks(peer, peerUserId);
      peer.onicecandidate = (event) => {
        if (!event.candidate || !roomRef.current || !isCurrentPeer(peerUserId, peer, peerGeneration)) return;
        socket.emit("rtc:signal", {
          roomId: roomRef.current,
          toUserId: peerUserId,
          signal: { type: "candidate", candidate: event.candidate.toJSON() }
        });
      };
      peer.ontrack = (event) => {
        if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
        const stream = mediaStreamForTrack(event.track, event.streams);
        const kind =
          remoteStreamKindsRef.current.get(peerUserId)?.get(stream.id) ??
          (event.track.kind === "audio" ? "audio" : "camera");
        peerOwner.noteTrack(peer, event.track, kind);
        setRemoteStreams((current) => {
          return upsertRemoteStream(current, peerUserId, kind, stream);
        });
        event.track.addEventListener(
          "ended",
          () => {
            if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
            if (kind === "screen" && event.track.kind === "audio") return;
            setRemoteStreams((current) => removeRemoteStream(current, peerUserId, kind, stream));
          },
          { once: true }
        );
      };
      peer.onconnectionstatechange = () => {
        if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
        if (peer.connectionState === "connected") {
          const transition = advancePeerRecovery(
            peerRecoveryStatesRef.current.get(peerUserId) ?? initialPeerRecoveryState(),
            { type: "connected" },
            Date.now()
          );
          peerRecoveryStatesRef.current.set(peerUserId, transition.state);
          if (transition.action === "cancel") {
            const timeout = peerConnectionTimeoutsRef.current.get(peerUserId);
            if (timeout !== undefined) window.clearTimeout(timeout);
            peerConnectionTimeoutsRef.current.delete(peerUserId);
          }
        }
        const recovering =
          peerRecoveryStatesRef.current.get(peerUserId)?.phase === "restarting" ||
          peerRecoveryStatesRef.current.get(peerUserId)?.phase === "rebuilding";
        const state: PeerConnectionState =
          peer.connectionState === "connected" && !recovering
            ? "connected"
            : peer.connectionState === "failed"
              ? "failed"
              : recovering
                ? "reconnecting"
                : "connecting";
        setPeerConnectionStates((current) => ({ ...current, [peerUserId]: state }));
        if (peer.connectionState === "failed") {
          const isRestarting = peerRecoveryStatesRef.current.get(peerUserId)?.phase === "restarting";
          schedulePeerRecovery(peerUserId, peer, { type: isRestarting ? "restart_failed" : "failed" });
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
        const iceState = peer.iceConnectionState;
        if (iceState === "connected" || iceState === "completed") {
          // ICE only proves that candidates can reach each other. Keep the
          // connection deadline alive until DTLS and the peer itself are ready.
          if (!isPeerConnectionReady(peer.connectionState)) return;
          const isRestarting = peerRecoveryStatesRef.current.get(peerUserId)?.phase === "restarting";
          const transition = advancePeerRecovery(
            peerRecoveryStatesRef.current.get(peerUserId) ?? initialPeerRecoveryState(),
            { type: isRestarting ? "restart_succeeded" : "connected" },
            Date.now()
          );
          peerRecoveryStatesRef.current.set(peerUserId, transition.state);
          if (transition.action !== "cancel") return;
          setPeerConnectionStates((current) => ({ ...current, [peerUserId]: "connected" }));
          const connectionTimeout = peerConnectionTimeoutsRef.current.get(peerUserId);
          if (connectionTimeout !== undefined) {
            window.clearTimeout(connectionTimeout);
            peerConnectionTimeoutsRef.current.delete(peerUserId);
          }
          const timer = peerRecoveryTimersRef.current.get(peerUserId);
          if (timer !== undefined) {
            window.clearTimeout(timer);
            peerRecoveryTimersRef.current.delete(peerUserId);
          }
          return;
        }
        if (iceState === "failed") {
          const isRestarting = peerRecoveryStatesRef.current.get(peerUserId)?.phase === "restarting";
          schedulePeerRecovery(peerUserId, peer, { type: isRestarting ? "restart_failed" : "failed" });
          return;
        }
        if (
          peer.iceConnectionState !== "disconnected" ||
          peerRecoveryTimersRef.current.has(peerUserId) ||
          peerRecoveryStatesRef.current.get(peerUserId)?.phase === "restarting"
        )
          return;
        const transition = advancePeerRecovery(
          peerRecoveryStatesRef.current.get(peerUserId) ?? initialPeerRecoveryState(),
          { type: "disconnected" },
          Date.now()
        );
        peerRecoveryStatesRef.current.set(peerUserId, transition.state);
        const timer = window.setTimeout(() => {
          peerRecoveryTimersRef.current.delete(peerUserId);
          if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
          if (peer.iceConnectionState !== "disconnected") return;
          const restart = advancePeerRecovery(
            peerRecoveryStatesRef.current.get(peerUserId) ?? initialPeerRecoveryState(),
            { type: "grace_elapsed" },
            Date.now()
          );
          peerRecoveryStatesRef.current.set(peerUserId, restart.state);
          if (restart.action !== "restart_ice") return;
          setPeerConnectionStates((current) => ({ ...current, [peerUserId]: "reconnecting" }));
          try {
            requestPeerRecovery(peerUserId, peer);
          } catch {
            schedulePeerRecovery(peerUserId, peer, { type: "restart_failed" });
            return;
          }
          const restartTimeout = window.setTimeout(() => {
            peerConnectionTimeoutsRef.current.delete(peerUserId);
            if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
            if (isPeerConnectionReady(peer.connectionState)) return;
            schedulePeerRecovery(peerUserId, peer, { type: "restart_failed" });
          }, voicePeerConnectionTimeoutMs);
          peerConnectionTimeoutsRef.current.set(peerUserId, restartTimeout);
        }, voicePeerRecoveryGraceMs);
        peerRecoveryTimersRef.current.set(peerUserId, timer);
      };

      const connectionTimeout = window.setTimeout(() => {
        peerConnectionTimeoutsRef.current.delete(peerUserId);
        if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
        if (isPeerConnectionReady(peer.connectionState)) return;
        schedulePeerRecovery(peerUserId, peer);
      }, voicePeerConnectionTimeoutMs);
      peerConnectionTimeoutsRef.current.set(peerUserId, connectionTimeout);

      return peer;
    },
    [isCurrentPeer, requestPeerRecovery, schedulePeerRecovery, syncLocalTracks]
  );

  const ensureInitialOffer = useCallback(
    (peerUserId: string, peer: RTCPeerConnection | null) => {
      const currentUserId = userIdRef.current;
      if (
        !peer ||
        !currentUserId ||
        offeredPeersRef.current.has(peer) ||
        makingOfferPeersRef.current.has(peerUserId) ||
        !shouldInitiatePeerConnection(currentUserId, peerUserId)
      )
        return;
      void sendOffer(peerUserId, peer).catch(() => setError("voiceError.startPeer"));
    },
    [sendOffer]
  );

  const recoverPeer = useCallback(
    (peerUserId: string, expectedPeer?: RTCPeerConnection) => {
      const peer = peersRef.current.get(peerUserId);
      // Quality observations belong to the exact connection that was measured.
      // A late sample must not create or recover a replacement connection.
      if (!peer || (expectedPeer && expectedPeer !== peer)) return;
      const peerGeneration = peerGenerationsRef.current.get(peerUserId);
      if (peerGeneration === undefined || !isCurrentPeer(peerUserId, peer, peerGeneration)) return;
      const transition = advancePeerRecovery(
        peerRecoveryStatesRef.current.get(peerUserId) ?? initialPeerRecoveryState(),
        { type: expectedPeer ? "quality_degraded" : "recovery_requested" },
        Date.now()
      );
      peerRecoveryStatesRef.current.set(peerUserId, transition.state);
      if (transition.action !== "restart_ice") return;
      voiceDiagnostics.record("recovery", { reason: expectedPeer ? "quality" : "transport" }, peer);
      setPeerConnectionStates((current) => ({ ...current, [peerUserId]: "reconnecting" }));
      try {
        requestPeerRecovery(peerUserId, peer, Boolean(expectedPeer));
      } catch {
        schedulePeerRecovery(peerUserId, peer, { type: "restart_failed" });
        return;
      }
      if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
      const previousTimeout = peerConnectionTimeoutsRef.current.get(peerUserId);
      if (previousTimeout !== undefined) window.clearTimeout(previousTimeout);
      const restartTimeout = window.setTimeout(() => {
        if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
        peerConnectionTimeoutsRef.current.delete(peerUserId);
        const state = peerRecoveryStatesRef.current.get(peerUserId);
        if (state?.phase !== "restarting") return;
        // The remote member owns its audio verdict. For a transport-only
        // request, settle a connected restart even if ICE emitted no new event.
        if (state.reason === "transport" && peer.connectionState === "connected") {
          peerRecoveryStatesRef.current.set(
            peerUserId,
            advancePeerRecovery(state, { type: "connected" }, Date.now()).state
          );
          setPeerConnectionStates((current) => ({ ...current, [peerUserId]: "connected" }));
          return;
        }
        schedulePeerRecovery(peerUserId, peer, { type: "restart_failed" });
      }, voicePeerConnectionTimeoutMs);
      peerConnectionTimeoutsRef.current.set(peerUserId, restartTimeout);
    },
    [isCurrentPeer, requestPeerRecovery, schedulePeerRecovery]
  );

  const confirmPeerAudioRecovered = useCallback((peerUserId: string, expectedPeer: RTCPeerConnection) => {
    const peer = peersRef.current.get(peerUserId);
    if (!peer || peer !== expectedPeer) return;
    if (peer.connectionState !== "connected") return;
    const transition = advancePeerRecovery(
      peerRecoveryStatesRef.current.get(peerUserId) ?? initialPeerRecoveryState(),
      { type: "quality_restored" },
      Date.now()
    );
    if (transition.action !== "cancel") return;
    peerRecoveryStatesRef.current.set(peerUserId, transition.state);
    const timeout = peerConnectionTimeoutsRef.current.get(peerUserId);
    if (timeout !== undefined) window.clearTimeout(timeout);
    peerConnectionTimeoutsRef.current.delete(peerUserId);
    setPeerConnectionStates((current) => ({ ...current, [peerUserId]: "connected" }));
  }, []);

  const flushPendingCandidates = useCallback(
    async (peerUserId: string, peer: RTCPeerConnection, peerGeneration: number) => {
      if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
      const pending = pendingCandidatesRef.current.get(peerUserId);
      pendingCandidatesRef.current.delete(peerUserId);
      if (!pending || pending.generation !== peerGeneration) return;
      for (const candidate of pending.candidates) {
        if (!isCurrentPeer(peerUserId, peer, peerGeneration)) return;
        try {
          await peer.addIceCandidate(candidate);
        } catch {
          // A candidate from an ignored glare offer can arrive before the offer.
          // Continue so one mismatched ufrag cannot block valid queued candidates.
        }
      }
    },
    [isCurrentPeer]
  );

  useEffect(() => {
    recoverPeerRef.current = (peerUserId) => {
      const peer = ensurePeer(peerUserId);
      if (peer) requestPeerRecovery(peerUserId, peer);
    };
    return () => {
      recoverPeerRef.current = () => undefined;
    };
  }, [ensurePeer, requestPeerRecovery]);

  useEffect(() => {
    if (!roomRef.current) return;
    for (const [peerUserId, peer] of peersRef.current) {
      try {
        peer.setConfiguration({ iceServers });
        requestPeerRecovery(peerUserId, peer);
      } catch {
        setError("voiceError.rtcConfig");
      }
    }
  }, [iceServers, requestPeerRecovery]);

  /**
   * The live peer connections, for the quality sampler. Exposed as an accessor
   * rather than state so reading the receiving decoders never re-renders the
   * tree, and so the sampler always sees the current set rather than the set as
   * it stood when it last rendered.
   */
  const peerConnections = useCallback(() => {
    try {
      voiceDiagnostics.record("input-output", {
        microphone: microphoneInputRef.current?.diagnostics?.() ?? null,
        output: voiceOutputDiagnostics()
      });
    } catch {
      /* Optional observation must never interrupt voice measurement. */
    }
    const snapshot = roomRef.current ? voiceSnapshotsRef.current[roomRef.current] : undefined;
    const members = new Map(snapshot?.members.map((member) => [member.user.userId, member.media.speaking]) ?? []);
    return [...peersRef.current.entries()].map(([userId, peer]) => ({
      userId,
      peer,
      microphoneTrackIds: peerOwner.microphoneTrackIds(peer),
      activeAudioTrackIds: peerOwner.activeAudioTrackIds(peer),
      recovering: ["restarting", "rebuilding"].includes(peerRecoveryStatesRef.current.get(userId)?.phase ?? ""),
      expectingAudio: members.get(userId) === true
    }));
  }, []);

  const screenReceivers = useCallback(
    () =>
      [...peersRef.current].flatMap(([userId, peer]) =>
        peerOwner.screenReceivers(peer).map((receiver) => ({ userId, peer, receiver }))
      ),
    []
  );

  const renegotiatePeers = useCallback(() => {
    for (const [peerUserId, peer] of peersRef.current) {
      syncLocalTracks(peer, peerUserId);
      void sendOffer(peerUserId, peer).catch(() => setError("voiceError.updateMedia"));
    }
  }, [sendOffer, syncLocalTracks]);

  const prepareMicrophoneInput = useCallback((rawStream: MediaStream) => {
    // Record the device this graph was opened with so the switch effect can
    // tell an already-applied change from a pending one.
    appliedMicrophoneCaptureRef.current = { deviceId: microphoneDeviceIdRef.current };
    const input = createMicrophoneInput(rawStream, microphoneVolumeRef.current, {
      noiseSuppression: noiseSuppressionRef.current
    });
    desktopMicrophone.apply(input.voiceStream.getAudioTracks(), false);
    return input;
  }, []);

  // Reached when the capture is gone and no replacement is coming: the device
  // was unplugged, or a reopen failed after the previous capture was released.
  const handleMicrophoneLost = useCallback(
    (message: VoiceErrorKey) => {
      if (roomRef.current)
        microphoneRecoveryRef.current = {
          roomId: roomRef.current,
          deviceId: microphoneDeviceIdRef.current,
          enabled:
            controlsRef.current.mic.on ||
            (controlsRef.current.deafen.on && microphoneOnBeforeDeafenRef.current) ||
            (moderationRef.current.muted && microphoneOnBeforeModerationMuteRef.current)
        };
      microphoneSwitchRef.current += 1;
      setMicrophoneRecoveryRevision((revision) => revision + 1);
      const shouldWarn = Boolean(
        roomRef.current &&
        controlsRef.current.mic.on &&
        !controlsRef.current.deafen.on &&
        !moderationRef.current.muted &&
        !micLockedByRoom() &&
        document.visibilityState === "visible"
      );
      desktopMicrophone.resetHolds();
      desktopMicrophoneTransitionRef.current += 1;
      speakingRef.current = false;
      stopStream("mic");
      microphoneEnabledRef.current = false;
      deafenTransitionRef.current += 1;
      const nextControls: VoiceControls = {
        ...controlsRef.current,
        mic: { ...controlsRef.current.mic, on: false }
      };
      controlsRef.current = nextControls;
      setControls(nextControls);
      setMicrophoneHealthWarning(shouldWarn);
      setError(message);
      void emitMediaState({ mic: false, speaking: false });
      persistVoiceResume();
      renegotiatePeers();
    },
    [emitMediaState, persistVoiceResume, renegotiatePeers, stopStream]
  );

  const activateMicrophoneInput = useCallback(
    (input: MicrophoneInput, requested = controlsRef.current.mic.on) => {
      microphoneEndedCleanupRef.current?.();
      desktopMicrophone.apply(
        input.voiceStream.getAudioTracks(),
        requested && !controlsRef.current.deafen.on && !moderationRef.current.muted && !micLockedByRoom()
      );
      microphoneInputRef.adopt(input);
      setMicrophoneHealthWarning(false);
      microphoneRecoveryRef.current = null;
      setErrorState((current) => (current.startsWith("voiceError.microphone") ? "" : current));
      localStreamsRef.current.mic = input.voiceStream;
      setMicrophoneMonitorStream(input.monitorStream);
      microphoneEndedCleanupRef.current = watchMicrophoneStreamEnd(input.rawStream, () => {
        if (microphoneInputRef.current !== input) return;
        handleMicrophoneLost("voiceError.microphoneDisconnected");
      });
      startSpeakingMonitor(input);
    },
    [handleMicrophoneLost, startSpeakingMonitor]
  );

  const visualSubscriptionRequest = useRef(0);
  const setVisualSubscriptions = useCallback(
    async (targets: VisualTarget[]) => {
      if (!socket || !roomRef.current) {
        return { ok: false, error: "not_in_voice_room" } as const;
      }
      const roomId = roomRef.current;
      const request = ++visualSubscriptionRequest.current;
      const response = await requestVisualSubscriptions(socket, { roomId, targets });
      if (response.ok && roomRef.current === roomId && request === visualSubscriptionRequest.current) {
        visualTargetsRef.current = response.targets;
        setVisualTargets(response.targets);
        persistVoiceResume(response.targets);
        syncScreenRecoveryRef.current();
      }
      return response;
    },
    [persistVoiceResume, socket]
  );

  const syncScreenRecovery = useCallback(() => {
    if (screenRecoveryRoomRef.current !== roomRef.current) {
      screenRecoveryRef.current?.sync([]);
      screenRecoveryRoomRef.current = roomRef.current;
    }
    const snapshot = roomRef.current ? voiceSnapshotsRef.current[roomRef.current] : undefined;
    const publishing = new Set(
      snapshot?.members.filter((member) => member.media.screen).map((member) => member.user.userId)
    );
    screenRecoveryRef.current?.sync(
      visualTargetsRef.current
        .filter((target) => target.kind === "screen" && publishing.has(target.publisherUserId))
        .map((target) => {
          const peer = peersRef.current.get(target.publisherUserId) ?? null;
          return {
            publisherId: target.publisherUserId,
            peer,
            receiver: peer ? (peerOwner.screenReceivers(peer)[0] ?? null) : null
          };
        })
    );
  }, []);
  syncScreenRecoveryRef.current = syncScreenRecovery;

  useEffect(() => {
    const owner = new ScreenRecoveryOwner(async (publisherId, expectedPeer, isSelected) => {
      if (!isSelected() || !socket?.connected || !expectedPeer || peersRef.current.get(publisherId) !== expectedPeer)
        return;
      const generation = peerGenerationsRef.current.get(publisherId);
      const response = await setVisualSubscriptions(visualTargetsRef.current);
      syncScreenRecovery();
      if (
        !isSelected() ||
        !response.ok ||
        screenRecoveryRef.current !== owner ||
        generation === undefined ||
        !isCurrentPeer(publisherId, expectedPeer, generation) ||
        !visualTargetsRef.current.some((target) => target.publisherUserId === publisherId && target.kind === "screen")
      )
        return;
      const state = peerRecoveryStatesRef.current.get(publisherId);
      if (state?.phase === "restarting" || state?.phase === "rebuilding") return;
      // A media fault requires the remote sender to rebuild, even with healthy ICE.
      requestPeerRecovery(publisherId, expectedPeer, true);
    }, setScreenPlaybackStates);
    screenRecoveryRef.current = owner;
    const sample = () => {
      syncScreenRecovery();
      if (socket?.connected) void owner.sample();
    };
    sample();
    const timer = window.setInterval(sample, 2_000);
    return () => {
      window.clearInterval(timer);
      owner.dispose();
      if (screenRecoveryRef.current === owner) screenRecoveryRef.current = null;
    };
  }, [socket, user?.id, isCurrentPeer, requestPeerRecovery, setVisualSubscriptions, syncScreenRecovery]);

  const noteScreenPlayback = useCallback(
    (publisherId: string, track: MediaStreamTrack) => {
      syncScreenRecovery();
      screenRecoveryRef.current?.notePlayback(publisherId, track);
    },
    [syncScreenRecovery]
  );
  const retryScreenPlayback = useCallback(
    (publisherId: string) => {
      syncScreenRecovery();
      screenRecoveryRef.current?.retry(publisherId);
      void screenRecoveryRef.current?.sample();
    },
    [syncScreenRecovery]
  );

  const applyVoiceSnapshot = useCallback(
    (nextSnapshot: VoiceSnapshot) => {
      voiceSnapshotsRef.current[nextSnapshot.roomId] = nextSnapshot;
      setVoiceSnapshots((current) => ({ ...current, [nextSnapshot.roomId]: nextSnapshot }));
      if (roomRef.current !== nextSnapshot.roomId) return;

      const currentUserId = userIdRef.current;
      const self = nextSnapshot.members.find((member) => member.user.userId === currentUserId);
      if (self) {
        const previousModeration = moderationRef.current;
        moderationRef.current = self.moderation;
        setVoiceModeration(self.moderation);
        if (self.moderation.muted && !previousModeration.muted) {
          desktopMicrophone.resetHolds();
          desktopMicrophone.suspend();
          microphoneOnBeforeModerationMuteRef.current = controlsRef.current.mic.on;
          localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
            desktopMicrophone.apply([track], false);
          });
          speakingRef.current = false;
          const nextControls = { ...controlsRef.current, mic: { ...controlsRef.current.mic, on: false } };
          controlsRef.current = nextControls;
          setControls(nextControls);
          void emitMediaState({ mic: false, speaking: false });
        } else if (!self.moderation.muted && previousModeration.muted) {
          const restoreMic = microphoneOnBeforeModerationMuteRef.current && !controlsRef.current.deafen.on;
          const hasLiveTrack =
            localStreamsRef.current.mic?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
          localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
            desktopMicrophone.apply([track], restoreMic && track.readyState === "live");
          });
          const nextControls = {
            ...controlsRef.current,
            mic: { ...controlsRef.current.mic, on: restoreMic && hasLiveTrack }
          };
          controlsRef.current = nextControls;
          setControls(nextControls);
          void emitMediaState({
            mic: effectiveVoiceMediaState(nextControls, localStreamsRef.current).mic,
            speaking: false
          }).then((response) => {
            if (!response.ok) return;
            const accepted = {
              ...controlsRef.current,
              mic: {
                ...controlsRef.current.mic,
                on:
                  desktopMicrophone.acceptedControl(response.state.media.mic, controlsRef.current.mic.on) &&
                  !response.state.moderation.muted &&
                  !response.state.media.deafened
              }
            };
            controlsRef.current = accepted;
            setControls(accepted);
          });
        }
      }

      setRemoteStreams((current) => pruneRemoteStreamsForSnapshot(current, nextSnapshot.members));
      const membersByUserId = new Map(nextSnapshot.members.map((member) => [member.user.userId, member.media]));
      const activeMemberUserIds = new Set(membersByUserId.keys());
      activeVoiceMemberUserIdsRef.current = activeMemberUserIds;
      const trackedPeerUserIds = new Set([...peersRef.current.keys(), ...peerRecoveryTimersRef.current.keys()]);
      for (const stalePeerUserId of staleVoicePeerUserIds(trackedPeerUserIds, activeMemberUserIds)) {
        removePeer(stalePeerUserId);
        remoteMediaInstancesRef.current.delete(stalePeerUserId);
      }
      const availableTargets = visualTargetsRef.current.filter(
        (target) => membersByUserId.get(target.publisherUserId)?.[target.kind]
      );
      if (availableTargets.length !== visualTargetsRef.current.length) {
        visualTargetsRef.current = availableTargets;
        setVisualTargets(availableTargets);
        persistVoiceResume(availableTargets);
      }
      for (const member of nextSnapshot.members) {
        const peerUserId = member.user.userId;
        const instance = member.mediaInstanceId;
        const previousInstance = remoteMediaInstancesRef.current.get(peerUserId);
        if (instance && previousInstance && instance !== previousInstance) {
          removePeer(peerUserId, { preserveVisualSubscriptions: true });
        }
        if (instance) remoteMediaInstancesRef.current.set(peerUserId, instance);
        ensureInitialOffer(peerUserId, ensurePeer(peerUserId));
      }
      syncScreenRecoveryRef.current();
    },
    [emitMediaState, ensureInitialOffer, ensurePeer, persistVoiceResume, removePeer]
  );

  const join = useCallback(
    async (roomId: string, restoredTargets: VisualTarget[] = [], options: VoiceJoinOptions = {}) => {
      microphoneRecoveryRef.current = null;
      if (!socket || !user) {
        setError("voiceError.socketDisconnected");
        return false;
      }
      return pendingJoin.run(() =>
        pendingCaptures.run(async () => {
          setError("");
          const previousControls = controlsRef.current;
          const previousMic = localStreamsRef.current.mic;
          const previousTrackStates =
            previousMic?.getAudioTracks().map((track) => [track, track.enabled] as const) ?? [];
          const attempt = ++joinAttemptRef.current;
          desktopMicrophone.resetHolds();
          desktopMicrophoneTransitionRef.current += 1;
          // A room that closes the microphone overrides the request, including the
          // default. The idle mover joins with no options, so without this the member
          // it parks arrives transmitting.
          const microphoneEnabled = afkRoomIdsRef.current.includes(roomId)
            ? false
            : (options.microphoneEnabled ?? true);
          let mic = previousMic;
          let acquiredInput: MicrophoneInput | null = null;

          if (microphoneEnabled) {
            if (!mic) {
              try {
                const rawStream = await pendingCaptures.run(() =>
                  openMicrophoneCapture({ deviceId: microphoneDeviceIdRef.current })
                );
                acquiredInput = prepareMicrophoneInput(rawStream);
                mic = acquiredInput.voiceStream;
              } catch {
                if (attempt === joinAttemptRef.current) {
                  setError("voiceError.microphonePermissionRequired");
                }
                return false;
              }
            }
            mic.getAudioTracks().forEach((track) => {
              desktopMicrophone.apply([track], true);
            });
          }

          if (attempt !== joinAttemptRef.current) {
            acquiredInput?.dispose();
            return false;
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
          const mediaInstanceId = mediaInstanceIdRef.current ?? crypto.randomUUID();
          const response = await requestVoiceJoin(socket, {
            mediaInstanceId,
            roomId,
            media: effectiveVoiceMediaState(nextControls, candidateStreams)
          });

          if (attempt !== joinAttemptRef.current || !response.ok) {
            if (acquiredInput) {
              acquiredInput.dispose();
            } else {
              previousTrackStates.forEach(([track, enabled]) => {
                desktopMicrophone.apply([track], enabled);
              });
            }
            if (attempt === joinAttemptRef.current && !response.ok) {
              setError("voiceError.join");
            }
            return false;
          }

          const acceptedControls: VoiceControls = {
            ...nextControls,
            mic: {
              ...nextControls.mic,
              on:
                desktopMicrophone.acceptedControl(response.state.media.mic, nextControls.mic.on) &&
                !response.state.moderation.muted &&
                !response.state.media.deafened
            },
            deafen: { ...nextControls.deafen, on: response.state.media.deafened }
          };
          if (response.state.moderation.muted) {
            microphoneOnBeforeModerationMuteRef.current = microphoneEnabled;
          }
          moderationRef.current = response.state.moderation;
          setVoiceModeration(response.state.moderation);
          microphoneEnabledRef.current = acceptedControls.mic.on;
          microphoneOnBeforeDeafenRef.current = acceptedControls.mic.on;
          deafenTransitionRef.current += 1;
          controlsRef.current = acceptedControls;
          if (!roomRef.current) voiceDiagnostics.begin();
          mediaInstanceIdRef.current = mediaInstanceId;
          roomRef.current = roomId;
          setControls(acceptedControls);
          setActiveRoomId(roomId);
          if (!microphoneEnabled) {
            stopStream("mic");
          } else if (acquiredInput) {
            acquiredInput.voiceStream.getAudioTracks().forEach((track) => {
              desktopMicrophone.apply(
                [track],
                controlsRef.current.mic.on &&
                  !controlsRef.current.deafen.on &&
                  !moderationRef.current.muted &&
                  !micLockedByRoom() &&
                  track.readyState === "live"
              );
            });
            activateMicrophoneInput(acquiredInput);
          } else if (mic) {
            mic.getAudioTracks().forEach((track) => {
              desktopMicrophone.apply(
                [track],
                controlsRef.current.mic.on &&
                  !controlsRef.current.deafen.on &&
                  !moderationRef.current.muted &&
                  !micLockedByRoom() &&
                  track.readyState === "live"
              );
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
        })
      );
    },
    [
      activateMicrophoneInput,
      applyVoiceSnapshot,
      persistVoiceResume,
      prepareMicrophoneInput,
      setVisualSubscriptions,
      socket,
      stopStream,
      user,
      pendingJoin,
      pendingCaptures
    ]
  );

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
    void pendingCaptures
      .run(() =>
        openMicrophoneCapture({ deviceId: microphoneDeviceId }).then((rawStream) => {
          const nextInput = prepareMicrophoneInput(rawStream);
          const nextTrack = nextInput.voiceStream.getAudioTracks()[0];
          if (!nextTrack || cancelled || requestId !== microphoneSwitchRef.current) {
            nextInput.dispose();
            return;
          }
          microphoneSwitchQueueRef.current = microphoneSwitchQueueRef.current
            .then(async () => {
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
              desktopMicrophone.apply(
                [nextTrack],
                controlsRef.current.mic.on &&
                  !controlsRef.current.deafen.on &&
                  !moderationRef.current.muted &&
                  !micLockedByRoom()
              );
              try {
                await replaceMicrophoneTrack(peersRef.current.values(), previousTrack, nextTrack);
              } catch (cause) {
                await replaceMicrophoneTrack(peersRef.current.values(), nextTrack, previousTrack).catch(
                  () => undefined
                );
                nextInput.dispose();
                throw cause;
              }
              if (!roomRef.current || requestId !== microphoneSwitchRef.current) {
                await replaceMicrophoneTrack(peersRef.current.values(), nextTrack, previousTrack).catch(
                  () => undefined
                );
                nextInput.dispose();
                return;
              }
              stopStream("mic");
              activateMicrophoneInput(nextInput);
              setError("");
            })
            .catch(() => {
              nextInput.dispose();
              setError("voiceError.microphoneReopen");
            });
          return microphoneSwitchQueueRef.current;
        })
      )
      .catch(() => {
        if (cancelled || requestId !== microphoneSwitchRef.current) return;
        setError("voiceError.microphoneReopen");
      });

    return () => {
      cancelled = true;
    };
  }, [activateMicrophoneInput, activeRoomId, microphoneDeviceId, prepareMicrophoneInput, stopStream]);

  const leave = useCallback(() => {
    microphoneRecoveryRef.current = null;
    visualSubscriptionRequest.current += 1;
    setMicrophoneHealthWarning(false);
    desktopMicrophone.resetHolds();
    desktopMicrophoneTransitionRef.current += 1;
    if (roomRef.current) voiceDiagnostics.end();
    joinAttemptRef.current += 1;
    pendingJoin.cancel();
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
    screenRecoveryRef.current?.sync([]);
    recoveryInProgressRef.current = false;
    resumeDeadlineRef.current = null;
    if (resumeDeadlineTimerRef.current) {
      window.clearTimeout(resumeDeadlineTimerRef.current);
      resumeDeadlineTimerRef.current = null;
    }
    if (peerGraceTimerRef.current) {
      window.clearTimeout(peerGraceTimerRef.current);
      peerGraceTimerRef.current = null;
    }
    const storage = voiceResumeStorage();
    if (storage) clearVoiceResume(storage);
    setActiveRoomId(null);
    setVoiceSnapshots({});
    voiceSnapshotsRef.current = {};
    setLocalPreviews([]);
    setError("");
    setControls(createInitialVoiceControls());
    releaseUnusedSharedAudioOutput();
  }, [closePeers, socket, stopStream, pendingJoin]);

  const toggleMic = useCallback(async () => {
    microphoneRecoveryRef.current = null;
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
      const roomId = roomRef.current;
      if (!roomId) return;
      const requestId = ++microphoneSwitchRef.current;
      const joinAttempt = joinAttemptRef.current;
      const deviceId = microphoneDeviceIdRef.current;
      let expectedInput = microphoneInputRef.current;
      const isCurrentCapture = () =>
        requestId === microphoneSwitchRef.current &&
        joinAttempt === joinAttemptRef.current &&
        roomRef.current === roomId &&
        microphoneDeviceIdRef.current === deviceId &&
        microphoneInputRef.current === expectedInput &&
        !controlsRef.current.deafen.on &&
        !moderationRef.current.muted &&
        !micLockedByRoom();
      setError("");
      try {
        const rawStream = await pendingCaptures.run(() => openMicrophoneCapture({ deviceId }));
        // Permission prompts can outlive leave, a new join, or a device change.
        if (!isCurrentCapture()) {
          rawStream.getTracks().forEach((track) => track.stop());
          return;
        }
        const input = prepareMicrophoneInput(rawStream);
        stream = input.voiceStream;
        activateMicrophoneInput(input, true);
        expectedInput = input;
        const requestedControls: VoiceControls = {
          ...controlsRef.current,
          mic: { ...controlsRef.current.mic, on: true }
        };
        const media = effectiveVoiceMediaState(requestedControls, localStreamsRef.current);
        const nextControls: VoiceControls = {
          ...requestedControls,
          mic: { ...requestedControls.mic, on: desktopMicrophone.acceptedControl(media.mic, requestedControls.mic.on) }
        };
        microphoneEnabledRef.current = nextControls.mic.on;
        controlsRef.current = nextControls;
        setControls(nextControls);
        await emitMediaState({ mic: media.mic, speaking: false });
        if (!isCurrentCapture()) return;
        persistVoiceResume();
        renegotiatePeers();
      } catch {
        if (!isCurrentCapture()) return;
        setMicrophoneHealthWarning(document.visibilityState === "visible");
        setError("voiceError.microphonePermissionDenied");
      }
      return;
    }

    const requestedOn = !controlsRef.current.mic.on;
    stream.getAudioTracks().forEach((track) => {
      desktopMicrophone.apply([track], requestedOn && track.readyState === "live");
    });
    const requestedControls: VoiceControls = {
      ...controlsRef.current,
      mic: { ...controlsRef.current.mic, on: requestedOn }
    };
    const media = effectiveVoiceMediaState(requestedControls, localStreamsRef.current);
    const nextControls: VoiceControls = {
      ...requestedControls,
      mic: { ...requestedControls.mic, on: desktopMicrophone.acceptedControl(media.mic, requestedControls.mic.on) }
    };
    if (!media.mic) {
      desktopMicrophone.suspend();
      speakingRef.current = false;
    }
    controlsRef.current = nextControls;
    microphoneEnabledRef.current = nextControls.mic.on;
    setControls(nextControls);
    await emitMediaState({ mic: media.mic, speaking: media.mic ? speakingRef.current : false });
  }, [
    activateMicrophoneInput,
    emitMediaState,
    persistVoiceResume,
    prepareMicrophoneInput,
    renegotiatePeers,
    stopStream
  ]);

  const recoverMicrophone = useCallback(async () => {
    const recovery = microphoneRecoveryRef.current;
    if (!recovery) return;
    if (microphoneRecoveryBusyRef.current) {
      microphoneRecoveryQueuedRef.current = true;
      return;
    }
    if (pendingCaptures.isPending() || pendingJoin.isPending() || !socket?.connected || microphoneInputRef.current)
      return;
    if (roomRef.current !== recovery.roomId || microphoneDeviceIdRef.current !== recovery.deviceId) {
      microphoneRecoveryRef.current = null;
      return;
    }
    if (!microphoneDevices.some((device) => !recovery.deviceId || device.deviceId === recovery.deviceId)) return;
    const request = ++microphoneSwitchRef.current;
    const joinAttempt = joinAttemptRef.current;
    const current = () =>
      microphoneRecoveryRef.current === recovery &&
      request === microphoneSwitchRef.current &&
      joinAttempt === joinAttemptRef.current &&
      roomRef.current === recovery.roomId &&
      microphoneDeviceIdRef.current === recovery.deviceId;
    microphoneRecoveryBusyRef.current = true;
    try {
      const raw = await pendingCaptures.run(() => openMicrophoneCapture({ deviceId: recovery.deviceId }));
      if (!current()) {
        raw.getTracks().forEach((track) => track.stop());
        return;
      }
      const input = prepareMicrophoneInput(raw);
      const requested =
        recovery.enabled && !controlsRef.current.deafen.on && !moderationRef.current.muted && !micLockedByRoom();
      activateMicrophoneInput(input, requested);
      const requestedControls = { ...controlsRef.current, mic: { ...controlsRef.current.mic, on: requested } };
      const media = effectiveVoiceMediaState(requestedControls, localStreamsRef.current);
      const nextControls = {
        ...requestedControls,
        mic: { ...requestedControls.mic, on: desktopMicrophone.acceptedControl(media.mic, requested) }
      };
      controlsRef.current = nextControls;
      microphoneEnabledRef.current = nextControls.mic.on;
      setControls(nextControls);
      // Activation consumes the recovery lease; remaining work belongs to this graph.
      await emitMediaState({ mic: media.mic, speaking: false });
      if (
        request !== microphoneSwitchRef.current ||
        roomRef.current !== recovery.roomId ||
        microphoneInputRef.current !== input
      )
        return;
      persistVoiceResume();
      renegotiatePeers();
    } catch {
      if (current()) {
        setMicrophoneHealthWarning(document.visibilityState === "visible");
        setError("voiceError.microphoneDisconnected");
      }
    } finally {
      microphoneRecoveryBusyRef.current = false;
      if (microphoneRecoveryQueuedRef.current) {
        microphoneRecoveryQueuedRef.current = false;
        if (microphoneRecoveryRef.current) setMicrophoneRecoveryRevision((revision) => revision + 1);
      }
    }
  }, [
    activateMicrophoneInput,
    emitMediaState,
    microphoneDevices,
    pendingCaptures,
    pendingJoin,
    persistVoiceResume,
    prepareMicrophoneInput,
    renegotiatePeers,
    setError,
    socket
  ]);

  useEffect(() => {
    // Settled device scans and a newly ended source each permit one attempt.
    void recoverMicrophone();
  }, [microphoneDeviceRevision, microphoneRecoveryRevision]);

  const setDeafened = useCallback(
    async (deafened: boolean) => {
      if (!deafened && moderationRef.current.deafened) return false;
      if (controlsRef.current.deafen.on === deafened) return true;
      const transition = ++deafenTransitionRef.current;
      const nextDeafened = deafened;
      if (nextDeafened) {
        const previousControls = controlsRef.current;
        const previousRestorePreference = microphoneOnBeforeDeafenRef.current;
        const previousTrackStates =
          localStreamsRef.current.mic?.getAudioTracks().map((track) => [track, track.enabled] as const) ?? [];
        desktopMicrophone.resetHolds();
        desktopMicrophone.suspend();
        microphoneOnBeforeDeafenRef.current = moderationRef.current.muted
          ? microphoneOnBeforeModerationMuteRef.current
          : controlsRef.current.mic.on;
        localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
          desktopMicrophone.apply([track], false);
        });
        speakingRef.current = false;
        const nextControls = toggleVoiceControl(controlsRef.current, "deafen");
        controlsRef.current = nextControls;
        setControls(nextControls);
        const media = effectiveVoiceMediaState(nextControls, localStreamsRef.current);
        const response = await emitMediaState({ deafened: media.deafened, mic: media.mic, speaking: false });
        if (transition !== deafenTransitionRef.current) return false;
        if (!response.ok) {
          previousTrackStates.forEach(([track, enabled]) => {
            desktopMicrophone.apply([track], enabled);
          });
          microphoneOnBeforeDeafenRef.current = previousRestorePreference;
          controlsRef.current = previousControls;
          setControls(previousControls);
          setError("voiceError.deafenState");
          return false;
        }
        localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
          desktopMicrophone.apply(
            [track],
            controlsRef.current.mic.on &&
              !controlsRef.current.deafen.on &&
              !moderationRef.current.muted &&
              !micLockedByRoom() &&
              track.readyState === "live"
          );
        });
        const acceptedControls: VoiceControls = {
          ...controlsRef.current,
          mic: {
            ...controlsRef.current.mic,
            on:
              desktopMicrophone.acceptedControl(response.state.media.mic, controlsRef.current.mic.on) &&
              !response.state.moderation.muted &&
              !response.state.media.deafened
          },
          deafen: { ...controlsRef.current.deafen, on: response.state.media.deafened }
        };
        controlsRef.current = acceptedControls;
        setControls(acceptedControls);
        return acceptedControls.deafen.on === deafened;
      }

      const restoreMicrophoneOn = !moderationRef.current.muted && microphoneOnBeforeDeafenRef.current;
      const microphoneAvailable =
        localStreamsRef.current.mic?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
      localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
        desktopMicrophone.apply([track], restoreMicrophoneOn && track.readyState === "live");
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
          desktopMicrophone.apply([track], false);
        });
        const failedControls: VoiceControls = {
          ...controlsRef.current,
          mic: { ...controlsRef.current.mic, on: false },
          deafen: { ...controlsRef.current.deafen, on: true }
        };
        controlsRef.current = failedControls;
        setControls(failedControls);
        setError("voiceError.deafenState");
        return false;
      }
      localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
        desktopMicrophone.apply(
          [track],
          controlsRef.current.mic.on &&
            !controlsRef.current.deafen.on &&
            !moderationRef.current.muted &&
            !micLockedByRoom() &&
            track.readyState === "live"
        );
      });
      const acceptedControls: VoiceControls = {
        ...controlsRef.current,
        mic: {
          ...controlsRef.current.mic,
          on:
            desktopMicrophone.acceptedControl(response.state.media.mic, controlsRef.current.mic.on) &&
            !response.state.moderation.muted &&
            !response.state.media.deafened
        },
        deafen: { ...controlsRef.current.deafen, on: response.state.media.deafened }
      };
      controlsRef.current = acceptedControls;
      setControls(acceptedControls);
      return acceptedControls.deafen.on === deafened;
    },
    [emitMediaState]
  );

  const toggleDeafen = useCallback(() => {
    if (!roomRef.current || !socket?.connected) return Promise.resolve(false);
    return setDeafened(!controlsRef.current.deafen.on);
  }, [setDeafened, socket]);

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
      const stream = await pendingCaptures.run(() =>
        navigator.mediaDevices.getUserMedia(mediaConstraintsFor("camera"))
      );
      localStreamsRef.current.camera = stream;
      const ack = await emitMediaState({ camera: true });
      if (!ack.ok) {
        stopStream("camera");
        setError(ack.error === "visual_limit_reached" ? "voiceError.visualLimit" : "voiceError.camera");
        return;
      }
      setLocalPreviews((current) => [
        ...current.filter((preview) => preview.kind !== "camera"),
        { kind: "camera", stream }
      ]);
      setControls((current) => ({ ...current, camera: { ...current.camera, on: true } }));
      renegotiatePeers();
    } catch {
      setError("voiceError.cameraPermissionDenied");
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
      const stream = await pendingCaptures.run(() =>
        navigator.mediaDevices.getDisplayMedia(mediaConstraintsFor("screen"))
      );
      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack) configureScreenTrack(screenTrack);
      localStreamsRef.current.screen = stream;
      screenTrack?.addEventListener(
        "ended",
        () => {
          stopStream("screen");
          setControls((current) => ({ ...current, screenShare: { ...current.screenShare, on: false } }));
          void emitMediaState({ screen: false });
          renegotiatePeers();
        },
        { once: true }
      );
      const ack = await emitMediaState({ screen: true });
      if (!ack.ok) {
        stopStream("screen");
        setError(ack.error === "visual_limit_reached" ? "voiceError.visualLimit" : "voiceError.screenShare");
        return;
      }
      setLocalPreviews((current) => [
        ...current.filter((preview) => preview.kind !== "screen"),
        { kind: "screen", stream }
      ]);
      setControls((current) => ({ ...current, screenShare: { ...current.screenShare, on: true } }));
      renegotiatePeers();
    } catch {
      setError("voiceError.screenSharePermissionDenied");
    }
  }, [activeRoomId, emitMediaState, renegotiatePeers, stopStream]);

  const toggleControl = useCallback(
    (key: VoiceControlKey) => {
      if (key === "mic") void toggleMic();
      else if (key === "camera") void toggleCamera();
      else if (key === "screenShare") void toggleScreen();
      else void toggleDeafen();
    },
    [toggleCamera, toggleDeafen, toggleMic, toggleScreen]
  );

  useEffect(
    () =>
      subscribeDesktopMute(
        window,
        createDesktopMuteReceiver(() => {
          const liveMicrophone =
            localStreamsRef.current.mic?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
          return {
            inVoice: Boolean(roomRef.current),
            connected: Boolean(socket?.connected),
            liveMicrophone,
            deafened: controlsRef.current.deafen.on,
            ownerMuted: moderationRef.current.muted,
            ownerDeafened: moderationRef.current.deafened,
            roomLocked: micLockedByRoom()
          };
        }, toggleMic)
      ),
    [socket, toggleMic, micLockedByRoom]
  );

  const requestSnapshot = useCallback(
    (roomId: string) => {
      if (!socket) return;
      socket.emit("voice:snapshot", roomId, (nextSnapshot) => {
        applyVoiceSnapshot(nextSnapshot);
      });
    },
    [applyVoiceSnapshot, socket]
  );

  useEffect(() => {
    voiceRoomIdsRef.current = voiceRoomIds;
    if (socket?.connected) {
      for (const roomId of voiceRoomIds) requestSnapshot(roomId);
    }
  }, [requestSnapshot, socket, voiceRoomIds]);

  const handleSignal = useCallback(
    async (payload: { fromUserId: string; mediaInstanceId?: string; signal: RtcSignal }) => {
      const knownInstance = remoteMediaInstancesRef.current.get(payload.fromUserId);
      if (payload.mediaInstanceId && knownInstance && payload.mediaInstanceId !== knownInstance) return;
      if (payload.mediaInstanceId) remoteMediaInstancesRef.current.set(payload.fromUserId, payload.mediaInstanceId);
      const signal = payload.signal as PeerSignal;
      const peer = ensurePeer(payload.fromUserId);
      if (!peer) return;
      const peerGeneration = peerGenerationsRef.current.get(payload.fromUserId);
      if (peerGeneration === undefined || !isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
      if (isRtcRecoveryRequest(signal)) {
        // The remote decoder requested media recovery. ICE may still look
        // connected while the RTP pipeline is stalled, so replace this peer
        // instead of restarting the same transport in place.
        schedulePeerRecovery(payload.fromUserId, peer, { type: "failed" });
        return;
      }
      if (signal.type === "offer") {
        rememberRemoteStreamKinds(payload.fromUserId, signal.streams);
        const hasOfferCollision =
          makingOfferPeersRef.current.has(payload.fromUserId) || peer.signalingState !== "stable";
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
        if (!isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
        ignoredOfferPeersRef.current.delete(payload.fromUserId);
        await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        if (!isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
        await flushPendingCandidates(payload.fromUserId, peer, peerGeneration);
        if (!isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
        const answer = await peer.createAnswer();
        if (!isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
        await peer.setLocalDescription(answer);
        if (socket && roomRef.current && isCurrentPeer(payload.fromUserId, peer, peerGeneration)) {
          offeredPeersRef.current.add(peer);
          socket.emit("rtc:signal", {
            roomId: roomRef.current,
            toUserId: payload.fromUserId,
            signal: { type: "answer", sdp: answer.sdp ?? "", streams: localStreamDescriptors(payload.fromUserId) }
          });
        }
        if (pendingOfferPeersRef.current.delete(payload.fromUserId)) {
          void sendOffer(payload.fromUserId, peer).catch(() => setError("voiceError.updateMedia"));
        }
        return;
      }
      if (signal.type === "answer") {
        ignoredOfferPeersRef.current.delete(payload.fromUserId);
        rememberRemoteStreamKinds(payload.fromUserId, signal.streams);
        await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        if (!isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
        await flushPendingCandidates(payload.fromUserId, peer, peerGeneration);
        if (!isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
        if (pendingOfferPeersRef.current.delete(payload.fromUserId)) {
          void sendOffer(payload.fromUserId, peer).catch(() => setError("voiceError.updateMedia"));
        }
        return;
      }
      if (signal.type === "candidate") {
        if (ignoredOfferPeersRef.current.has(payload.fromUserId)) return;
        if (!peer.remoteDescription) {
          const pending = pendingCandidatesRef.current.get(payload.fromUserId);
          const candidates = pending?.generation === peerGeneration ? pending.candidates : [];
          if (candidates.length < 128) candidates.push(signal.candidate);
          pendingCandidatesRef.current.set(payload.fromUserId, { generation: peerGeneration, candidates });
          return;
        }
        if (!isCurrentPeer(payload.fromUserId, peer, peerGeneration)) return;
        await peer.addIceCandidate(signal.candidate);
      }
    },
    [
      ensurePeer,
      flushPendingCandidates,
      isCurrentPeer,
      localStreamDescriptors,
      rememberRemoteStreamKinds,
      schedulePeerRecovery,
      sendOffer,
      socket
    ]
  );

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
      )
        return;
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
      desktopMicrophone.resetHolds();
      desktopMicrophoneTransitionRef.current += 1;
      let retry = false;
      try {
        desktopMicrophone.apply(
          localStreamsRef.current.mic?.getAudioTracks() ?? [],
          controlsRef.current.mic.on &&
            !controlsRef.current.deafen.on &&
            !moderationRef.current.muted &&
            !micLockedByRoom()
        );
        const media = effectiveVoiceMediaState(controlsRef.current, localStreamsRef.current);
        const mediaInstanceId = mediaInstanceIdRef.current ?? crypto.randomUUID();
        const response = await requestVoiceJoin(socket, { roomId: activeRoomId, media, mediaInstanceId });
        if (disposed || attempt !== joinAttemptRef.current || roomRef.current !== activeRoomId || !socket.connected)
          return;
        if (!response.ok) {
          setError("voiceError.restoreVoice");
          retry = true;
          return;
        }

        mediaInstanceIdRef.current = mediaInstanceId;
        requestKnownSnapshots();
        const subscription = await setVisualSubscriptions(visualTargetsRef.current);
        if (disposed || attempt !== joinAttemptRef.current || roomRef.current !== activeRoomId || !socket.connected)
          return;
        if (!subscription.ok) {
          setError("voiceError.restoreStream");
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
        if (peerGraceTimerRef.current) {
          window.clearTimeout(peerGraceTimerRef.current);
          peerGraceTimerRef.current = null;
        }
        if (resumeDeadlineTimerRef.current) {
          window.clearTimeout(resumeDeadlineTimerRef.current);
          resumeDeadlineTimerRef.current = null;
        }
        clearRecoveryRetry();
        scheduleRecovery(0);
        return;
      }

      if (peerGraceTimerRef.current) {
        window.clearTimeout(peerGraceTimerRef.current);
        peerGraceTimerRef.current = null;
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
      desktopMicrophone.resetHolds();
      desktopMicrophoneTransitionRef.current += 1;
      // A disconnected hold must stop publication before any recovery work.
      if (desktopMicrophone.usesShortcut()) desktopMicrophone.suspend();
      speakingRef.current = false;
      joinAttemptRef.current += 1;
      pendingJoin.cancel();
      if (!roomRef.current) return;
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
      if (peerGraceTimerRef.current) window.clearTimeout(peerGraceTimerRef.current);
      peerGraceTimerRef.current = window.setTimeout(() => {
        peerGraceTimerRef.current = null;
        if (!socket.connected) closePeers();
      }, 5_000);
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
      joinAttemptRef.current += 1;
      pendingJoin.cancel();
      if (peerGraceTimerRef.current) {
        window.clearTimeout(peerGraceTimerRef.current);
        peerGraceTimerRef.current = null;
      }
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
      ensureInitialOffer(joinedUser.userId, ensurePeer(joinedUser.userId));
    };
    const onSignal = (payload: { fromUserId: string; mediaInstanceId?: string; signal: RtcSignal }) => {
      void handleSignal(payload).catch(() => setError("voiceError.signal"));
    };
    const onVisualSubscriberState = (payload: {
      roomId: string;
      viewerUserId: string;
      subscribedKinds: VisualMediaKind[];
    }) => {
      if (roomRef.current !== payload.roomId) return;
      viewerVisualSubscriptionsRef.current.set(payload.viewerUserId, new Set(payload.subscribedKinds));
      const peer = ensurePeer(payload.viewerUserId);
      if (!peer) return;
      syncLocalTracks(peer, payload.viewerUserId);
      void sendOffer(payload.viewerUserId, peer).catch(() => setError("voiceError.updateMedia"));
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
  }, [
    applyVoiceSnapshot,
    ensureInitialOffer,
    ensurePeer,
    handleSignal,
    recoverPeer,
    schedulePeerRecovery,
    sendOffer,
    socket,
    syncLocalTracks
  ]);

  useEffect(() => {
    if (!user) {
      leave();
      voiceDiagnostics.clear();
    }
  }, [leave, user]);

  useEffect(() => {
    let observedInput: MicrophoneInput | null = null;
    let state: MicrophoneHealthState = { faultSince: null, warning: false };
    let unwatch = () => {};
    const check = () => {
      const input = microphoneInputRef.current;
      if (!input || !roomRef.current) {
        unwatch();
        observedInput = null;
        return;
      }
      if (input !== observedInput) {
        unwatch();
        observedInput = input;
        state = { faultSince: null, warning: false };
        const tracks = [...input.rawStream.getAudioTracks(), ...input.voiceStream.getAudioTracks()];
        const changed = () => {
          if (microphoneInputRef.current === input) check();
        };
        for (const track of tracks) {
          track.addEventListener("mute", changed);
          track.addEventListener("unmute", changed);
          track.addEventListener("ended", changed);
        }
        unwatch = () => {
          for (const track of tracks) {
            track.removeEventListener("mute", changed);
            track.removeEventListener("unmute", changed);
            track.removeEventListener("ended", changed);
          }
        };
      }
      const track = input.rawStream.getAudioTracks()[0];
      const publication = input.voiceStream.getAudioTracks()[0];
      state = stepMicrophoneHealth(state, {
        expected:
          controlsRef.current.mic.on &&
          !controlsRef.current.deafen.on &&
          !moderationRef.current.muted &&
          !micLockedByRoom() &&
          desktopMicrophone.allows() &&
          !pendingCaptures.isPending() &&
          !pendingJoin.isPending() &&
          publication?.enabled !== false,
        visible: document.visibilityState === "visible",
        live: track?.readyState === "live" && publication?.readyState === "live",
        unavailable: track?.muted === true,
        contextState: input.diagnostics?.().contextState ?? "running",
        now: Date.now()
      });
      setMicrophoneHealthWarning(state.warning);
    };
    const timer = window.setInterval(check, 1_000);
    return () => {
      window.clearInterval(timer);
      unwatch();
    };
  }, []);

  const getDesktopCallState = useCallback(() => {
    const report = desktopCallState({
      inVoice: Boolean(roomRef.current),
      streams: localStreamsRef.current,
      pendingJoin: pendingJoin.isPending(),
      pendingCapture: pendingCaptures.isPending()
    });
    const media = effectiveVoiceMediaState(controlsRef.current, localStreamsRef.current);
    return {
      ...report,
      microphone: media.mic,
      camera: media.camera,
      screen: media.screen,
      computerAudio: media.screen && report.computerAudio
    };
  }, [pendingJoin, pendingCaptures]);

  return {
    getDesktopCallState,
    activeRoomId,
    joinPending,
    isJoinPending: pendingJoin.isPending,
    controls,
    error,
    errorRevision,
    join,
    leave,
    localPreviews,
    microphoneMonitorStream,
    microphoneHealthWarning,
    peerConnections,
    screenReceivers,
    recoverPeer,
    confirmPeerAudioRecovered,
    requestSnapshot,
    remoteStreams,
    setDeafened,
    toggleDeafen,
    peerConnectionStates,
    screenPlaybackStates,
    noteScreenPlayback,
    retryScreenPlayback,
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
