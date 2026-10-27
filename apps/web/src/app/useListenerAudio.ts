import type { PublicUser } from "@voxly/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_AUDIO_LEVELS, readAudioLevels, writeAudioLevels, type AudioLevels } from "../lib/audioLevels.js";
import { subscribeBlockedAudioOutputs } from "../lib/audioOutput.js";
import { subscribeDesktopCallState } from "../lib/desktopCallState.js";
import { createDesktopDeafenReceiver, subscribeDesktopDeafen } from "../lib/desktopVoice.js";
import {
  claimMicrophoneTestDeafen,
  shouldRestoreMicrophoneTestDeafen,
  type MicrophoneTestDeafenLease
} from "../lib/microphoneTestIsolation.js";
import {
  browserSupportsNoiseSuppression,
  DEFAULT_NOISE_SUPPRESSION,
  readNoiseSuppression,
  writeNoiseSuppression
} from "../lib/noiseSuppression.js";
import { useAudioDevices } from "../lib/useAudioDevices.js";
import { useConnectionHealth } from "../lib/useConnectionHealth.js";
import { useMicrophoneTest } from "../lib/useMicrophoneTest.js";
import { useVoiceMedia } from "../lib/useVoiceMedia.js";
import { useScreenConnectionQuality } from "../lib/useScreenConnectionQuality.js";
import { useVoiceQuality } from "../lib/useVoiceQuality.js";
import { clampVolumePercent, pruneVolumes, readUserVolumes, setVolume, writeUserVolumes } from "../lib/voiceVolume.js";
import type { VoxlySocket } from "../socket.js";
import type { LiveWatchRequest } from "./types.js";
import { useNotificationSounds } from "./useNotificationSounds.js";
import type { DesktopNotificationTarget } from "../lib/desktopNotifications.js";

export function useListenerAudio({
  socket,
  messagesSilenced,
  user,
  iceServers,
  voiceRoomIds,
  afkRoomIds,
  activeVoiceRoomRef,
  leaveVoiceRef,
  activeTextRoomIdRef,
  onNotificationActivate
}: {
  socket: VoxlySocket | null;
  /** Do Not Disturb: message cues and alerts stay quiet, call cues do not. */
  messagesSilenced: boolean;
  user: PublicUser | null;
  iceServers: RTCIceServer[];
  voiceRoomIds: string[];
  afkRoomIds: string[];
  activeVoiceRoomRef: React.RefObject<string | null>;
  leaveVoiceRef: React.RefObject<() => void>;
  activeTextRoomIdRef: React.RefObject<string | null>;
  onNotificationActivate(target: DesktopNotificationTarget): void;
}) {
  const accountId = user?.id;
  const audioDevices = useAudioDevices({ userId: accountId });
  const { refresh: refreshAudioDevices } = audioDevices;
  const [audioLevels, setAudioLevels] = useState<AudioLevels>(DEFAULT_AUDIO_LEVELS);
  const [noiseSuppression, setNoiseSuppression] = useState(DEFAULT_NOISE_SUPPRESSION);
  const [noiseSuppressionSupported] = useState(browserSupportsNoiseSuppression);
  const voice = useVoiceMedia({
    socket,
    user,
    iceServers,
    voiceRoomIds,
    afkRoomIds,
    microphoneDeviceId: audioDevices.selectedInputId,
    microphoneDevices: audioDevices.inputs,
    microphoneDeviceRevision: audioDevices.deviceRevision,
    microphoneVolume: audioLevels.input,
    noiseSuppression
  });
  const { recoverPeer, confirmPeerAudioRecovered, getDesktopCallState, setDeafened } = voice;
  const connectionHealth = useConnectionHealth(socket);
  // Only while there is a call to measure. Outside a voice room the signalling
  // round trip is the only connection a member has, and reporting on it is
  // exactly right; inside one it is the wrong path to be looking at.
  const screenConnectionWarnings = useScreenConnectionQuality(voice.activeRoomId ? voice.screenReceivers : null);
  const measuredQuality = useVoiceQuality(voice.activeRoomId ? voice.peerConnections : null);
  const voiceQuality = {
    ...measuredQuality,
    recovering: Object.values(voice.peerConnectionStates).some((state) => state === "reconnecting")
  };
  useEffect(() => {
    for (const request of voiceQuality.recoveryRequests) {
      recoverPeer(request.peerUserId, request.peer);
    }
    for (const { userId, peer } of voiceQuality.clearPeers) {
      confirmPeerAudioRecovered(userId, peer);
    }
  }, [recoverPeer, confirmPeerAudioRecovered, voiceQuality.recoveryRequests, voiceQuality.clearPeers]);
  const notifications = useNotificationSounds({
    user,
    activeVoiceRoomId: voice.activeRoomId,
    voiceSnapshot: voice.activeRoomId ? voice.voiceSnapshots[voice.activeRoomId] : undefined,
    controls: voice.controls,
    deafened: voice.controls.deafen.on || voice.voiceModeration.deafened,
    connectionInterrupted: connectionHealth.overlayVisible,
    activeTextRoomIdRef,
    messagesSilenced,
    onNotificationActivate
  });
  const microphoneTest = useMicrophoneTest(
    audioDevices.selectedInputId,
    audioLevels.input,
    voice.microphoneMonitorStream,
    noiseSuppression
  );
  const { isBusy: isMicrophoneTestBusy, stop: stopTest, start: startTest } = microphoneTest;
  const microphoneTestDeafenRef = useRef<MicrophoneTestDeafenLease | null>(null);
  const microphoneTestStartingRef = useRef(false);
  useEffect(
    () =>
      subscribeDesktopCallState(window, () => ({
        ...getDesktopCallState(),
        microphoneTest:
          isMicrophoneTestBusy() || microphoneTestStartingRef.current || Boolean(microphoneTestDeafenRef.current)
      })),
    [getDesktopCallState, isMicrophoneTestBusy]
  );
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>({});
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [pendingLiveWatch, setPendingLiveWatch] = useState<LiveWatchRequest | null>(null);

  useEffect(() => {
    if (voice.activeRoomId) void refreshAudioDevices(false).catch(() => undefined);
  }, [refreshAudioDevices, voice.activeRoomId]);
  useEffect(() => subscribeBlockedAudioOutputs(setAudioPlaybackBlocked), []);
  useEffect(() => {
    activeVoiceRoomRef.current = voice.activeRoomId;
    leaveVoiceRef.current = voice.leave;
  }, [voice.activeRoomId, voice.leave, activeVoiceRoomRef, leaveVoiceRef]);
  useEffect(() => setMemberVolumes(accountId ? readUserVolumes(accountId) : {}), [accountId]);
  useEffect(() => setAudioLevels(accountId ? readAudioLevels(accountId) : { ...DEFAULT_AUDIO_LEVELS }), [accountId]);
  useEffect(
    () => setNoiseSuppression(accountId ? readNoiseSuppression(accountId) : DEFAULT_NOISE_SUPPRESSION),
    [accountId]
  );
  useEffect(() => {
    const ids = voice.remoteStreams.filter((item) => item.kind === "screen").map((item) => item.stream.id);
    setScreenVolumes((current) => pruneVolumes(current, ids));
  }, [voice.remoteStreams]);

  const changeAudioLevel = useCallback(
    (kind: keyof AudioLevels, volume: number) => {
      setAudioLevels((current) => {
        const next = { ...current, [kind]: clampVolumePercent(volume) };
        if (accountId) writeAudioLevels(accountId, next);
        return next;
      });
    },
    [accountId]
  );

  const changeNoiseSuppression = useCallback(
    (enabled: boolean) => {
      setNoiseSuppression(enabled);
      if (accountId) writeNoiseSuppression(accountId, enabled);
    },
    [accountId]
  );

  const isolateMicrophoneTest = useCallback(async () => {
    const roomId = voice.activeRoomId;
    if (!roomId) {
      microphoneTestDeafenRef.current = null;
      return true;
    }
    if (microphoneTestDeafenRef.current?.roomId === roomId) return true;
    const claim = claimMicrophoneTestDeafen(roomId, voice.controls.deafen.on);
    if (claim.shouldDeafen && !(await setDeafened(true))) return false;
    microphoneTestDeafenRef.current = claim.lease;
    return true;
  }, [voice.activeRoomId, voice.controls.deafen.on, setDeafened]);

  const stopMicrophoneTest = useCallback(async () => {
    stopTest();
    const lease = microphoneTestDeafenRef.current;
    if (shouldRestoreMicrophoneTestDeafen(lease, voice.activeRoomId)) await setDeafened(false);
    if (microphoneTestDeafenRef.current === lease) microphoneTestDeafenRef.current = null;
  }, [stopTest, voice.activeRoomId, setDeafened]);

  const startMicrophoneTest = useCallback(async () => {
    microphoneTestStartingRef.current = true;
    try {
      if (!(await isolateMicrophoneTest())) return;
      if (!(await startTest())) await stopMicrophoneTest();
    } finally {
      microphoneTestStartingRef.current = false;
    }
  }, [isolateMicrophoneTest, startTest, stopMicrophoneTest]);

  const toggleMicrophoneTest = useCallback(async () => {
    if (microphoneTest.active) await stopMicrophoneTest();
    else await startMicrophoneTest();
  }, [microphoneTest.active, startMicrophoneTest, stopMicrophoneTest]);

  useEffect(
    () =>
      subscribeDesktopDeafen(
        window,
        createDesktopDeafenReceiver(
          () => ({
            inVoice: Boolean(voice.activeRoomId),
            connected: Boolean(socket?.connected),
            ownerDeafened: voice.voiceModeration.deafened,
            microphoneTest:
              microphoneTest.active || microphoneTestStartingRef.current || Boolean(microphoneTestDeafenRef.current)
          }),
          voice.toggleDeafen
        )
      ),
    [socket, voice.activeRoomId, voice.voiceModeration.deafened, voice.toggleDeafen, microphoneTest.active]
  );

  useEffect(() => {
    if (!microphoneTest.active) return;
    if (!voice.activeRoomId) {
      microphoneTestDeafenRef.current = null;
      return;
    }
    if (microphoneTestDeafenRef.current?.roomId === voice.activeRoomId) return;
    void isolateMicrophoneTest().then((isolated) => {
      if (!isolated) stopTest();
    });
  }, [isolateMicrophoneTest, microphoneTest.active, stopTest, voice.activeRoomId]);

  const changeMemberVolume = useCallback(
    (userId: string, volume: number) => {
      if (!accountId) return;
      setMemberVolumes((current) => {
        const next = setVolume(current, userId, volume);
        writeUserVolumes(accountId, next);
        return next;
      });
    },
    [accountId]
  );
  const changeScreenVolume = useCallback((streamId: string, volume: number) => {
    setScreenVolumes((current) => setVolume(current, streamId, volume));
  }, []);

  return {
    voice,
    connectionHealth,
    voiceQuality,
    screenConnectionWarnings,
    audioDevices,
    audioLevels,
    microphoneTest,
    noiseSuppression,
    noiseSuppressionSupported,
    notificationSounds: notifications.notificationSounds,
    notifyMessage: notifications.notifyMessage,
    memberVolumes,
    screenVolumes,
    audioPlaybackBlocked,
    pendingLiveWatch,
    activeVoiceRoomRef,
    leaveVoiceRef,
    setPendingLiveWatch,
    changeMemberVolume,
    changeScreenVolume,
    changeAudioLevel,
    changeNoiseSuppression,
    changeNotificationSounds: notifications.changeNotificationSounds,
    toggleMicrophoneTest,
    stopMicrophoneTest
  };
}
