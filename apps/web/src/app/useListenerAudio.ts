import type { PublicUser } from "@voxly/shared";
import { useCallback,useEffect,useRef,useState } from "react";
import { DEFAULT_AUDIO_LEVELS,readAudioLevels,writeAudioLevels,type AudioLevels } from "../lib/audioLevels.js";
import { subscribeBlockedAudioOutputs } from "../lib/audioOutput.js";
import { claimMicrophoneTestDeafen,shouldRestoreMicrophoneTestDeafen,type MicrophoneTestDeafenLease } from "../lib/microphoneTestIsolation.js";
import { useAudioDevices } from "../lib/useAudioDevices.js";
import { useConnectionHealth } from "../lib/useConnectionHealth.js";
import { useMicrophoneTest } from "../lib/useMicrophoneTest.js";
import { useVoiceMedia } from "../lib/useVoiceMedia.js";
import { clampVolumePercent,pruneVolumes,readUserVolumes,setVolume,writeUserVolumes } from "../lib/voiceVolume.js";
import type { VoxlySocket } from "../socket.js";
import type { LiveWatchRequest } from "./types.js";

export function useListenerAudio({ socket, user, iceServers, voiceRoomIds, activeVoiceRoomRef, leaveVoiceRef }: {
  socket: VoxlySocket | null;
  user: PublicUser | null;
  iceServers: RTCIceServer[];
  voiceRoomIds: string[];
  activeVoiceRoomRef: React.RefObject<string | null>;
  leaveVoiceRef: React.RefObject<() => void>;
}) {
  const audioDevices = useAudioDevices({ userId: user?.id });
  const [audioLevels, setAudioLevels] = useState<AudioLevels>(DEFAULT_AUDIO_LEVELS);
  const voice = useVoiceMedia({
    socket,
    user,
    iceServers,
    voiceRoomIds,
    microphoneDeviceId: audioDevices.selectedInputId,
    microphoneVolume: audioLevels.input
  });
  const connectionHealth = useConnectionHealth(socket);
  const microphoneTest = useMicrophoneTest(audioDevices.selectedInputId, audioLevels.input, voice.microphoneMonitorStream);
  const microphoneTestDeafenRef = useRef<MicrophoneTestDeafenLease | null>(null);
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>({});
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [pendingLiveWatch, setPendingLiveWatch] = useState<LiveWatchRequest | null>(null);

  useEffect(() => {
    if (voice.activeRoomId) void audioDevices.refresh(false).catch(() => undefined);
  }, [audioDevices.refresh, voice.activeRoomId]);
  useEffect(() => subscribeBlockedAudioOutputs(setAudioPlaybackBlocked), []);
  useEffect(() => {
    activeVoiceRoomRef.current = voice.activeRoomId;
    leaveVoiceRef.current = voice.leave;
  }, [voice.activeRoomId, voice.leave]);
  useEffect(() => setMemberVolumes(user ? readUserVolumes(user.id) : {}), [user?.id]);
  useEffect(() => setAudioLevels(user ? readAudioLevels(user.id) : { ...DEFAULT_AUDIO_LEVELS }), [user?.id]);
  useEffect(() => {
    const ids = voice.remoteStreams.filter((item) => item.kind === "screen").map((item) => item.stream.id);
    setScreenVolumes((current) => pruneVolumes(current, ids));
  }, [voice.remoteStreams]);

  const changeAudioLevel = useCallback((kind: keyof AudioLevels, volume: number) => {
    setAudioLevels((current) => {
      const next = { ...current, [kind]: clampVolumePercent(volume) };
      if (user) writeAudioLevels(user.id, next);
      return next;
    });
  }, [user?.id]);

  const isolateMicrophoneTest = useCallback(async () => {
    const roomId = voice.activeRoomId;
    if (!roomId) {
      microphoneTestDeafenRef.current = null;
      return true;
    }
    if (microphoneTestDeafenRef.current?.roomId === roomId) return true;
    const claim = claimMicrophoneTestDeafen(roomId, voice.controls.deafen.on);
    if (claim.shouldDeafen && !(await voice.setDeafened(true))) return false;
    microphoneTestDeafenRef.current = claim.lease;
    return true;
  }, [voice.activeRoomId, voice.controls.deafen.on, voice.setDeafened]);

  const stopMicrophoneTest = useCallback(async () => {
    microphoneTest.stop();
    const lease = microphoneTestDeafenRef.current;
    microphoneTestDeafenRef.current = null;
    if (shouldRestoreMicrophoneTestDeafen(lease, voice.activeRoomId)) await voice.setDeafened(false);
  }, [microphoneTest.stop, voice.activeRoomId, voice.setDeafened]);

  const startMicrophoneTest = useCallback(async () => {
    if (!(await isolateMicrophoneTest())) return;
    if (!(await microphoneTest.start())) await stopMicrophoneTest();
  }, [isolateMicrophoneTest, microphoneTest.start, stopMicrophoneTest]);

  const toggleMicrophoneTest = useCallback(async () => {
    if (microphoneTest.active) await stopMicrophoneTest();
    else await startMicrophoneTest();
  }, [microphoneTest.active, startMicrophoneTest, stopMicrophoneTest]);

  useEffect(() => {
    if (!microphoneTest.active) return;
    if (!voice.activeRoomId) {
      microphoneTestDeafenRef.current = null;
      return;
    }
    if (microphoneTestDeafenRef.current?.roomId === voice.activeRoomId) return;
    void isolateMicrophoneTest().then((isolated) => { if (!isolated) microphoneTest.stop(); });
  }, [isolateMicrophoneTest, microphoneTest.active, microphoneTest.stop, voice.activeRoomId]);

  const changeMemberVolume = useCallback((userId: string, volume: number) => {
    if (!user) return;
    setMemberVolumes((current) => {
      const next = setVolume(current, userId, volume);
      writeUserVolumes(user.id, next);
      return next;
    });
  }, [user]);
  const changeScreenVolume = useCallback((streamId: string, volume: number) => {
    setScreenVolumes((current) => setVolume(current, streamId, volume));
  }, []);

  return {
    voice, connectionHealth, audioDevices, audioLevels, microphoneTest,
    memberVolumes, screenVolumes, audioPlaybackBlocked, pendingLiveWatch,
    activeVoiceRoomRef, leaveVoiceRef, setPendingLiveWatch,
    changeMemberVolume, changeScreenVolume, changeAudioLevel,
    toggleMicrophoneTest, stopMicrophoneTest
  };
}
