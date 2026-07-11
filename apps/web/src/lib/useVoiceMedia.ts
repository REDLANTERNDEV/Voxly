import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PublicUser,
  RtcSignal,
  VisualMediaKind,
  VisualTarget,
  VoiceMediaState,
  VoiceSetMediaAck,
  VoiceSetVisualSubscriptionsAck,
  VoiceSnapshot
} from "@voxly/shared";
import type { VoxlySocket } from "../socket.js";
import { createInitialVoiceControls, toggleVoiceControl, type VoiceControlKey, type VoiceControls } from "./voiceControls.js";
import { mediaConstraintsFor, replaceMicrophoneTrack } from "./voiceMedia.js";
import { buildMicrophoneConstraints } from "./audioDevices.js";
import { shouldOfferToJoiningMember, type PeerConnectionState } from "./voiceNegotiation.js";
import { clearVoiceResume, readVoiceResume, voiceResumeWindowMs, writeVoiceResume } from "./voiceResume.js";
import {
  pruneRemoteStreamsForSnapshot,
  upsertRemoteStream,
  type RemoteMediaKind,
  type RemoteStreamState
} from "./voiceStreams.js";

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

export function useVoiceMedia({ socket, user, iceServers, voiceRoomIds, microphoneDeviceId = "" }: UseVoiceMediaInput) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [controls, setControls] = useState<VoiceControls>(() => createInitialVoiceControls());
  const [voiceSnapshots, setVoiceSnapshots] = useState<Record<string, VoiceSnapshot>>({});
  const [visualTargets, setVisualTargets] = useState<VisualTarget[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStreamState[]>([]);
  const [peerConnectionStates, setPeerConnectionStates] = useState<Record<string, PeerConnectionState>>({});
  const [localPreviews, setLocalPreviews] = useState<LocalPreviewState[]>([]);
  const [error, setError] = useState("");
  const localStreamsRef = useRef<Partial<Record<LocalStreamKind, MediaStream>>>({});
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamKindsRef = useRef<Map<string, Map<string, RemoteMediaKind>>>(new Map());
  const viewerVisualSubscriptionsRef = useRef<Map<string, Set<VisualMediaKind>>>(new Map());
  const visualTargetsRef = useRef<VisualTarget[]>([]);
  const makingOfferPeersRef = useRef<Set<string>>(new Set());
  const pendingOfferPeersRef = useRef<Set<string>>(new Set());
  const peerRecoveryTimersRef = useRef<Map<string, number>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const microphoneSwitchRef = useRef(0);
  const microphoneSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ignoredOfferPeersRef = useRef<Set<string>>(new Set());
  const recoverPeerRef = useRef<(peerUserId: string) => void>(() => undefined);
  const resumeAttemptRef = useRef(false);
  const recoveryInProgressRef = useRef(false);
  const resumeDeadlineRef = useRef<number | null>(null);
  const resumeDeadlineTimerRef = useRef<number | null>(null);
  const controlsRef = useRef(controls);
  const voiceRoomIdsRef = useRef(voiceRoomIds);
  const speakingRef = useRef(false);
  const speakingCleanupRef = useRef<(() => void) | null>(null);
  const roomRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    userIdRef.current = user?.id ?? null;
  }, [user?.id]);

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  const persistVoiceResume = useCallback((targets = visualTargetsRef.current, resetDeadline = false) => {
    if (!roomRef.current) return;
    const storage = voiceResumeStorage();
    const now = Date.now();
    const expiresAt = resetDeadline || !resumeDeadlineRef.current || resumeDeadlineRef.current <= now
      ? now + voiceResumeWindowMs
      : resumeDeadlineRef.current;
    resumeDeadlineRef.current = expiresAt;
    if (storage) writeVoiceResume(storage, roomRef.current, targets, now, expiresAt);
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
      analyser.fftSize = 512;
      const samples = new Uint8Array(analyser.fftSize);
      source.connect(analyser);

      const interval = window.setInterval(() => {
        const micIsLive = localStreamsRef.current.mic?.getAudioTracks().some((track) => track.enabled && track.readyState === "live") ?? false;
        if (!micIsLive) {
          setLocalSpeaking(false);
          return;
        }

        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        setLocalSpeaking(Math.sqrt(sum / samples.length) > 0.045);
      }, 220);

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
    stream?.getTracks().forEach((track) => track.stop());
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
    pendingOfferPeersRef.current.clear();
    for (const timer of peerRecoveryTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    peerRecoveryTimersRef.current.clear();
    pendingCandidatesRef.current.clear();
    ignoredOfferPeersRef.current.clear();
    setRemoteStreams([]);
    setPeerConnectionStates({});
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
        if (!peer.getSenders().some((sender) => sender.track === track)) {
          peer.addTrack(track, stream);
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
    try {
      const offer = await peer.createOffer();
      if (peer.signalingState !== "stable" || !roomRef.current) return;
      await peer.setLocalDescription(offer);
      socket.emit("rtc:signal", {
        roomId: roomRef.current,
        toUserId: peerUserId,
        signal: { type: "offer", sdp: offer.sdp ?? "", streams: localStreamDescriptors(peerUserId) }
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

    const peer = new RTCPeerConnection({ iceServers });
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
      const [stream] = event.streams;
      if (!stream) return;
      const kind = remoteStreamKindsRef.current.get(peerUserId)?.get(stream.id) ?? (event.track.kind === "audio" ? "audio" : "camera");
      setRemoteStreams((current) => {
        return upsertRemoteStream(current, peerUserId, kind, stream);
      });
      event.track.addEventListener("ended", () => {
        if (kind === "screen" && event.track.kind === "audio") return;
        setRemoteStreams((current) => current.filter((item) => item.userId !== peerUserId || item.kind !== kind));
      }, { once: true });
    };
    peer.onconnectionstatechange = () => {
      const state: PeerConnectionState = peer.connectionState === "connected"
        ? "connected"
        : peer.connectionState === "failed"
          ? "failed"
          : "connecting";
      setPeerConnectionStates((current) => ({ ...current, [peerUserId]: state }));
      if (peer.connectionState !== "failed" || peersRef.current.get(peerUserId) !== peer) return;
      peer.close();
      peersRef.current.delete(peerUserId);
      pendingCandidatesRef.current.delete(peerUserId);
      ignoredOfferPeersRef.current.delete(peerUserId);
      const previousTimer = peerRecoveryTimersRef.current.get(peerUserId);
      if (previousTimer) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(() => {
        peerRecoveryTimersRef.current.delete(peerUserId);
        recoverPeerRef.current(peerUserId);
      }, 300);
      peerRecoveryTimersRef.current.set(peerUserId, timer);
    };

    return peer;
  }, [iceServers, socket, syncLocalTracks]);

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

  const renegotiatePeers = useCallback(() => {
    for (const [peerUserId, peer] of peersRef.current) {
      syncLocalTracks(peer, peerUserId);
      void sendOffer(peerUserId, peer).catch(() => setError("Could not update media."));
    }
  }, [sendOffer, syncLocalTracks]);

  const setVisualSubscriptions = useCallback((targets: VisualTarget[]) => {
    if (!socket || !roomRef.current) {
      return Promise.resolve<VoiceSetVisualSubscriptionsAck>({ ok: false, error: "not_in_voice_room" });
    }
    return new Promise<VoiceSetVisualSubscriptionsAck>((resolve) => {
      socket.emit("voice:setVisualSubscriptions", { roomId: roomRef.current as string, targets }, (response) => {
        if (response.ok) {
          visualTargetsRef.current = response.targets;
          setVisualTargets(response.targets);
          persistVoiceResume(response.targets);
        }
        resolve(response);
      });
    });
  }, [persistVoiceResume, socket]);

  const join = useCallback(async (roomId: string, restoredTargets: VisualTarget[] = []) => {
    if (!socket || !user) {
      setError("Socket is not connected.");
      return;
    }
    setError("");
    try {
      const mic = localStreamsRef.current.mic ?? await navigator.mediaDevices.getUserMedia(buildMicrophoneConstraints(microphoneDeviceId));
      localStreamsRef.current.mic = mic;
      startSpeakingMonitor(mic);
      roomRef.current = roomId;
      setActiveRoomId(roomId);
      setControls((current) => ({
        ...current,
        mic: { ...current.mic, on: true },
        deafen: { ...current.deafen, on: false }
      }));
      socket.emit("voice:join", roomId);
      await emitMediaState({ mic: true, deafened: false, speaking: false });
      socket.emit("voice:snapshot", roomId, (nextSnapshot) => {
        setVoiceSnapshots((current) => ({ ...current, [nextSnapshot.roomId]: nextSnapshot }));
      });
      if (restoredTargets.length > 0) {
        await setVisualSubscriptions(restoredTargets);
      } else {
        persistVoiceResume([]);
      }
    } catch {
      setError("Microphone permission is required to join voice.");
      stopStream("mic");
    }
  }, [emitMediaState, microphoneDeviceId, persistVoiceResume, setVisualSubscriptions, socket, startSpeakingMonitor, stopStream, user]);

  useEffect(() => {
    const previousStream = localStreamsRef.current.mic;
    if (!roomRef.current || !previousStream) return;
    const requestId = ++microphoneSwitchRef.current;
    let cancelled = false;

    void navigator.mediaDevices.getUserMedia(buildMicrophoneConstraints(microphoneDeviceId))
      .then((nextStream) => {
        const nextTrack = nextStream.getAudioTracks()[0];
        if (!nextTrack || cancelled || requestId !== microphoneSwitchRef.current) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }
        microphoneSwitchQueueRef.current = microphoneSwitchQueueRef.current.then(async () => {
          if (cancelled || requestId !== microphoneSwitchRef.current) {
            nextStream.getTracks().forEach((track) => track.stop());
            return;
          }
          const activeStream = localStreamsRef.current.mic;
          const previousTrack = activeStream?.getAudioTracks()[0];
          if (!roomRef.current || !activeStream || !previousTrack) {
            nextStream.getTracks().forEach((track) => track.stop());
            return;
          }
          nextTrack.enabled = controlsRef.current.mic.on && !controlsRef.current.deafen.on;
          try {
            await replaceMicrophoneTrack(peersRef.current.values(), previousTrack, nextTrack);
          } catch (cause) {
            await replaceMicrophoneTrack(peersRef.current.values(), nextTrack, previousTrack).catch(() => undefined);
            nextStream.getTracks().forEach((track) => track.stop());
            throw cause;
          }
          if (!roomRef.current || requestId !== microphoneSwitchRef.current) {
            await replaceMicrophoneTrack(peersRef.current.values(), nextTrack, previousTrack).catch(() => undefined);
            nextStream.getTracks().forEach((track) => track.stop());
            return;
          }
          activeStream.getTracks().forEach((track) => track.stop());
          localStreamsRef.current.mic = nextStream;
          startSpeakingMonitor(nextStream);
          setError("");
        }).catch(() => {
          nextStream.getTracks().forEach((track) => track.stop());
          setError("The selected microphone could not be opened. Using the previous microphone.");
        });
      })
      .catch(() => {
        if (!cancelled && requestId === microphoneSwitchRef.current) {
          setError("The selected microphone could not be opened. Using the previous microphone.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [microphoneDeviceId, startSpeakingMonitor]);

  const leave = useCallback(() => {
    microphoneSwitchRef.current += 1;
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
  }, [closePeers, socket, stopStream]);

  const toggleMic = useCallback(async () => {
    const stream = localStreamsRef.current.mic;
    if (!stream || controls.deafen.on) return;
    const next = !controls.mic.on;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    if (!next) {
      setLocalSpeaking(false);
    }
    setControls((current) => ({ ...current, mic: { ...current.mic, on: next } }));
    await emitMediaState({ mic: next, speaking: next ? speakingRef.current : false });
  }, [controls.deafen.on, controls.mic.on, emitMediaState, setLocalSpeaking]);

  const toggleDeafen = useCallback(async () => {
    const next = !controls.deafen.on;
    if (next) {
      localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      setLocalSpeaking(false);
      setControls((current) => toggleVoiceControl(current, "deafen"));
      await emitMediaState({ deafened: true, mic: false, speaking: false });
      return;
    }

    localStreamsRef.current.mic?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    setControls((current) => toggleVoiceControl(current, "deafen"));
    await emitMediaState({ deafened: false, mic: true, speaking: false });
  }, [controls.deafen.on, emitMediaState, setLocalSpeaking]);

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
      localStreamsRef.current.screen = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
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
      setVoiceSnapshots((current) => ({ ...current, [nextSnapshot.roomId]: nextSnapshot }));
    });
  }, [socket]);

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
      if (peer.signalingState !== "stable") {
        const isPolitePeer = (userIdRef.current ?? "") > payload.fromUserId;
        if (!isPolitePeer) {
          ignoredOfferPeersRef.current.add(payload.fromUserId);
          pendingCandidatesRef.current.delete(payload.fromUserId);
          return;
        }
        await peer.setLocalDescription({ type: "rollback" });
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
    const requestKnownSnapshots = () => {
      for (const roomId of voiceRoomIdsRef.current) requestSnapshot(roomId);
    };
    const onConnect = () => {
      requestKnownSnapshots();
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
        socket.emit("voice:join", activeRoomId);
        void emitMediaState({
          mic: Boolean(localStreamsRef.current.mic),
          camera: false,
          screen: false,
          deafened: controlsRef.current.deafen.on,
          speaking: false
        });
        void setVisualSubscriptions(visualTargetsRef.current);
        recoveryInProgressRef.current = false;
        resumeDeadlineRef.current = null;
        return;
      }

      const storage = voiceResumeStorage();
      const record = storage ? readVoiceResume(storage) : null;
      if (!record || resumeAttemptRef.current) return;
      resumeDeadlineRef.current = record.expiresAt;
      recoveryInProgressRef.current = true;
      resumeAttemptRef.current = true;
      void join(record.roomId, record.targets).finally(() => {
        if (roomRef.current === record.roomId) {
          recoveryInProgressRef.current = false;
          resumeDeadlineRef.current = null;
        }
        resumeAttemptRef.current = false;
      });
    };
    const onDisconnect = () => {
      if (!roomRef.current) return;
      persistVoiceResume(visualTargetsRef.current, !recoveryInProgressRef.current);
      recoveryInProgressRef.current = true;
      if (resumeDeadlineTimerRef.current) window.clearTimeout(resumeDeadlineTimerRef.current);
      const delay = Math.max(0, (resumeDeadlineRef.current ?? Date.now()) - Date.now());
      resumeDeadlineTimerRef.current = window.setTimeout(() => {
        resumeDeadlineTimerRef.current = null;
        if (!socket.connected && roomRef.current) leave();
      }, delay);
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
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [emitMediaState, join, leave, persistVoiceResume, requestSnapshot, setVisualSubscriptions, socket, stopStream]);

  useEffect(() => {
    if (!socket) return;
    const onSnapshot = (nextSnapshot: VoiceSnapshot) => {
      setVoiceSnapshots((current) => ({ ...current, [nextSnapshot.roomId]: nextSnapshot }));
      if (roomRef.current === nextSnapshot.roomId) {
        setRemoteStreams((current) => pruneRemoteStreamsForSnapshot(current, nextSnapshot.members));
        const membersByUserId = new Map(nextSnapshot.members.map((member) => [member.user.userId, member.media]));
        const availableTargets = visualTargetsRef.current.filter((target) => membersByUserId.get(target.publisherUserId)?.[target.kind]);
        if (availableTargets.length !== visualTargetsRef.current.length) {
          visualTargetsRef.current = availableTargets;
          setVisualTargets(availableTargets);
          persistVoiceResume(availableTargets);
        }
        for (const member of nextSnapshot.members) {
          ensurePeer(member.user.userId);
        }
      }
    };
    const onVoiceJoined = ({ roomId, user: joinedUser }: { roomId: string; user: { userId: string } }) => {
      if (roomRef.current !== roomId) {
        return;
      }
      const peer = ensurePeer(joinedUser.userId);
      const currentUserId = userIdRef.current;
      if (!peer || !currentUserId || !shouldOfferToJoiningMember(currentUserId, joinedUser.userId, joinedUser.userId)) {
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
  }, [ensurePeer, handleSignal, persistVoiceResume, sendOffer, socket, syncLocalTracks]);

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
    requestSnapshot,
    remoteStreams,
    peerConnectionStates,
    setVisualSubscriptions,
    visualTargets,
    voiceSnapshots,
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
