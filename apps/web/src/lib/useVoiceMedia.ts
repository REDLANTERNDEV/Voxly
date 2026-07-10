import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser, RtcSignal, VoiceMediaState, VoiceSetMediaAck, VoiceSnapshot } from "@voxly/shared";
import type { VoxlySocket } from "../socket.js";
import { createInitialVoiceControls, toggleVoiceControl, type VoiceControlKey, type VoiceControls } from "./voiceControls.js";
import { mediaConstraintsFor, micConstraints } from "./voiceMedia.js";
import { shouldOfferToJoiningMember } from "./voiceNegotiation.js";
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

export function useVoiceMedia({ socket, user, iceServers }: UseVoiceMediaInput) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [controls, setControls] = useState<VoiceControls>(() => createInitialVoiceControls());
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStreamState[]>([]);
  const [localPreviews, setLocalPreviews] = useState<LocalPreviewState[]>([]);
  const [error, setError] = useState("");
  const localStreamsRef = useRef<Partial<Record<LocalStreamKind, MediaStream>>>({});
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamKindsRef = useRef<Map<string, Map<string, RemoteMediaKind>>>(new Map());
  const speakingRef = useRef(false);
  const speakingCleanupRef = useRef<(() => void) | null>(null);
  const roomRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    userIdRef.current = user?.id ?? null;
  }, [user?.id]);

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
    setRemoteStreams([]);
  }, []);

  const localStreamDescriptors = useCallback((): SignalStreamDescriptor[] => {
    const descriptors: SignalStreamDescriptor[] = [];
    if (localStreamsRef.current.mic) {
      descriptors.push({ id: localStreamsRef.current.mic.id, kind: "audio" });
    }
    if (localStreamsRef.current.camera) {
      descriptors.push({ id: localStreamsRef.current.camera.id, kind: "camera" });
    }
    if (localStreamsRef.current.screen) {
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

  const syncLocalTracks = useCallback((peer: RTCPeerConnection) => {
    const currentTracks = new Set<MediaStreamTrack>();
    for (const stream of Object.values(localStreamsRef.current)) {
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
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit("rtc:signal", {
      roomId: roomRef.current,
      toUserId: peerUserId,
      signal: { type: "offer", sdp: offer.sdp ?? "", streams: localStreamDescriptors() }
    });
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
    syncLocalTracks(peer);
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
        setRemoteStreams((current) => current.filter((item) => item.userId !== peerUserId || item.kind !== kind));
      }, { once: true });
    };

    return peer;
  }, [iceServers, socket, syncLocalTracks]);

  const renegotiatePeers = useCallback(() => {
    for (const [peerUserId, peer] of peersRef.current) {
      syncLocalTracks(peer);
      void sendOffer(peerUserId, peer).catch(() => setError("Could not update media."));
    }
  }, [sendOffer, syncLocalTracks]);

  const join = useCallback(async (roomId: string) => {
    if (!socket || !user) {
      setError("Socket is not connected.");
      return;
    }
    setError("");
    try {
      const mic = await navigator.mediaDevices.getUserMedia(micConstraints);
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
      socket.emit("voice:snapshot", roomId, setSnapshot);
    } catch {
      setError("Microphone permission is required to join voice.");
      stopStream("mic");
    }
  }, [emitMediaState, socket, startSpeakingMonitor, stopStream, user]);

  const leave = useCallback(() => {
    if (socket && roomRef.current) {
      socket.emit("voice:leave", roomRef.current);
    }
    stopStream("mic");
    stopStream("camera");
    stopStream("screen");
    closePeers();
    roomRef.current = null;
    setActiveRoomId(null);
    setSnapshot(null);
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
    socket.emit("voice:snapshot", roomId, setSnapshot);
  }, [socket]);

  const handleSignal = useCallback(async (payload: { fromUserId: string; signal: RtcSignal }) => {
    const signal = payload.signal as PeerSignal;
    const peer = ensurePeer(payload.fromUserId);
    if (!peer) return;
    if (signal.type === "offer") {
      rememberRemoteStreamKinds(payload.fromUserId, signal.streams);
      await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (socket && roomRef.current) {
        socket.emit("rtc:signal", {
          roomId: roomRef.current,
          toUserId: payload.fromUserId,
          signal: { type: "answer", sdp: answer.sdp ?? "", streams: localStreamDescriptors() }
        });
      }
      return;
    }
    if (signal.type === "answer") {
      rememberRemoteStreamKinds(payload.fromUserId, signal.streams);
      await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      return;
    }
    if (signal.type === "candidate") {
      await peer.addIceCandidate(signal.candidate);
    }
  }, [ensurePeer, localStreamDescriptors, rememberRemoteStreamKinds, socket]);

  useEffect(() => {
    if (!socket) return;
    const onSnapshot = (nextSnapshot: VoiceSnapshot) => {
      setSnapshot(nextSnapshot);
      setRemoteStreams((current) => pruneRemoteStreamsForSnapshot(current, nextSnapshot.members));
      if (roomRef.current === nextSnapshot.roomId) {
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
    socket.on("voice:snapshot", onSnapshot);
    socket.on("voice:joined", onVoiceJoined);
    socket.on("rtc:signal", onSignal);
    return () => {
      socket.off("voice:snapshot", onSnapshot);
      socket.off("voice:joined", onVoiceJoined);
      socket.off("rtc:signal", onSignal);
    };
  }, [ensurePeer, handleSignal, sendOffer, socket]);

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
    snapshot,
    toggleControl
  };
}
