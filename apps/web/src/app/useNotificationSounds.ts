import type { ChatMessage, PublicUser, VoiceSnapshot } from "@voxly/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createNotificationSoundPlayer,
  type NotificationSoundPlayer
} from "../lib/notificationSoundPlayer.js";
import {
  advanceVoiceRoster,
  clampNotificationVolume,
  DEFAULT_NOTIFICATION_SOUNDS,
  EMPTY_VOICE_ROSTER,
  notificationSoundAllowed,
  readNotificationSounds,
  shouldPlayMessageSound,
  writeNotificationSounds,
  type NotificationSoundKey,
  type NotificationSoundPreferences,
  type VoiceRosterState
} from "../lib/notificationSounds.js";
import type { VoiceControls } from "../lib/voiceControls.js";

interface VoiceControlSample {
  roomId: string | null;
  mic: boolean;
  deafen: boolean;
}

function windowFocused() {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== "visible") return false;
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

export function useNotificationSounds({ user, activeVoiceRoomId, voiceSnapshot, controls, deafened, connectionInterrupted, activeTextRoomIdRef }: {
  user: PublicUser | null;
  activeVoiceRoomId: string | null;
  voiceSnapshot: VoiceSnapshot | undefined;
  controls: VoiceControls;
  deafened: boolean;
  connectionInterrupted: boolean;
  activeTextRoomIdRef: React.RefObject<string | null>;
}) {
  const [preferences, setPreferences] = useState<NotificationSoundPreferences>(DEFAULT_NOTIFICATION_SOUNDS);
  const playerRef = useRef<NotificationSoundPlayer | null>(null);
  const preferencesRef = useRef(preferences);
  const deafenedRef = useRef(deafened);
  const rosterRef = useRef<VoiceRosterState>(EMPTY_VOICE_ROSTER);
  const voiceRoomRef = useRef<string | null>(null);
  const controlSampleRef = useRef<VoiceControlSample | null>(null);
  const interruptedRef = useRef(connectionInterrupted);
  preferencesRef.current = preferences;
  deafenedRef.current = deafened;

  useEffect(() => {
    setPreferences(user ? readNotificationSounds(user.id) : { ...DEFAULT_NOTIFICATION_SOUNDS });
  }, [user?.id]);

  // Warm the cues as soon as there is a session rather than on the first one
  // that fires. Building the element lazily meant the very first join, mute, or
  // message cue waited on its own download before it could sound, which is the
  // case where being late is most noticeable.
  useEffect(() => {
    if (!user) return;
    playerRef.current ??= createNotificationSoundPlayer();
    playerRef.current.prime();
  }, [user?.id]);

  useEffect(() => () => {
    playerRef.current?.dispose();
    playerRef.current = null;
  }, []);

  const play = useCallback((key: NotificationSoundKey) => {
    if (!notificationSoundAllowed(key, preferencesRef.current, { deafened: deafenedRef.current })) return false;
    playerRef.current ??= createNotificationSoundPlayer();
    return playerRef.current.play(key, preferencesRef.current.volume);
  }, []);

  const changeNotificationSounds = useCallback((patch: Partial<NotificationSoundPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch, volume: clampNotificationVolume(patch.volume ?? current.volume) };
      if (user) writeNotificationSounds(user.id, next);
      return next;
    });
  }, [user?.id]);

  // Joining, moving, and leaving are all observable as a change of the active
  // room. Reconnect keeps the room, so recovery stays silent.
  useEffect(() => {
    const previous = voiceRoomRef.current;
    voiceRoomRef.current = activeVoiceRoomId;
    if (previous === activeVoiceRoomId) return;
    if (activeVoiceRoomId) play("voiceJoin");
    else if (previous) play("voiceLeave");
  }, [activeVoiceRoomId, play]);

  useEffect(() => {
    const currentUserId = user?.id;
    const userIds = activeVoiceRoomId && voiceSnapshot?.roomId === activeVoiceRoomId
      ? voiceSnapshot.members.map((member) => member.user.userId).filter((userId) => userId !== currentUserId)
      : null;
    const { state, joined, left } = advanceVoiceRoster(rosterRef.current, { roomId: activeVoiceRoomId, userIds });
    rosterRef.current = state;
    if (joined.length > 0) play("voicePeerJoin");
    if (left.length > 0) play("voicePeerLeave");
  }, [activeVoiceRoomId, play, user?.id, voiceSnapshot]);

  // Deafen also turns the microphone off, so its cue wins and the implied mute
  // stays silent.
  useEffect(() => {
    const previous = controlSampleRef.current;
    const current: VoiceControlSample = { roomId: activeVoiceRoomId, mic: controls.mic.on, deafen: controls.deafen.on };
    controlSampleRef.current = current;
    if (!activeVoiceRoomId || !previous || previous.roomId !== activeVoiceRoomId) return;
    if (previous.deafen !== current.deafen) {
      play(current.deafen ? "deafen" : "undeafen");
      return;
    }
    if (previous.mic !== current.mic) play(current.mic ? "unmute" : "mute");
  }, [activeVoiceRoomId, controls.deafen.on, controls.mic.on, play]);

  useEffect(() => {
    const previous = interruptedRef.current;
    interruptedRef.current = connectionInterrupted;
    if (previous === connectionInterrupted) return;
    play(connectionInterrupted ? "connectionLost" : "connectionRestored");
  }, [connectionInterrupted, play]);

  const notifyMessage = useCallback((message: ChatMessage) => {
    if (!user) return false;
    const allowed = shouldPlayMessageSound(message, {
      currentUserId: user.id,
      activeTextRoomId: activeTextRoomIdRef.current,
      windowFocused: windowFocused()
    });
    return allowed ? play("message") : false;
  }, [activeTextRoomIdRef, play, user?.id]);

  return { notificationSounds: preferences, changeNotificationSounds, notifyMessage };
}
