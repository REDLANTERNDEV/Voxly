import type { ChatMessage, PublicUser, VoiceSnapshot } from "@voxly/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createNotificationSoundPlayer, type NotificationSoundPlayer } from "../lib/notificationSoundPlayer.js";
import {
  activeVoiceScreenMembers,
  activeVoiceRosterUserIds,
  advanceVoiceScreenRoster,
  advanceVoiceRoster,
  clampNotificationVolume,
  DEFAULT_NOTIFICATION_SOUNDS,
  EMPTY_VOICE_ROSTER,
  EMPTY_VOICE_SCREEN_ROSTER,
  notificationSoundAllowed,
  readNotificationSounds,
  shouldPlayMessageSound,
  writeNotificationSounds,
  type NotificationSoundKey,
  type NotificationSoundPreferences,
  type VoiceRosterState,
  type VoiceScreenRosterState
} from "../lib/notificationSounds.js";
import type { VoiceControls } from "../lib/voiceControls.js";
import {
  createDesktopNotificationDelivery,
  isDesktopNotificationKind,
  readDesktopNotifications,
  type DesktopNotificationTarget
} from "../lib/desktopNotifications.js";

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

export function useNotificationSounds({
  user,
  activeVoiceRoomId,
  voiceSnapshot,
  controls,
  deafened,
  connectionInterrupted,
  activeTextRoomIdRef,
  messagesSilenced,
  onNotificationActivate
}: {
  user: PublicUser | null;
  activeVoiceRoomId: string | null;
  voiceSnapshot: VoiceSnapshot | undefined;
  controls: VoiceControls;
  deafened: boolean;
  connectionInterrupted: boolean;
  activeTextRoomIdRef: React.RefObject<string | null>;
  messagesSilenced: boolean;
  onNotificationActivate(target: DesktopNotificationTarget): void;
}) {
  const accountId = user?.id;
  const [preferences, setPreferences] = useState<NotificationSoundPreferences>(DEFAULT_NOTIFICATION_SOUNDS);
  const playerRef = useRef<NotificationSoundPlayer | null>(null);
  const preferencesRef = useRef(preferences);
  const deafenedRef = useRef(deafened);
  const rosterRef = useRef<VoiceRosterState>(EMPTY_VOICE_ROSTER);
  const screenRosterRef = useRef<VoiceScreenRosterState>(EMPTY_VOICE_SCREEN_ROSTER);
  const voiceRoomRef = useRef<string | null>(null);
  const controlSampleRef = useRef<VoiceControlSample | null>(null);
  const interruptedRef = useRef(connectionInterrupted);
  const desktopDeliveryRef = useRef<ReturnType<typeof createDesktopNotificationDelivery> | null>(null);
  const activationRef = useRef({ userId: user?.id, activate: onNotificationActivate });
  activationRef.current = { userId: user?.id, activate: onNotificationActivate };
  preferencesRef.current = preferences;
  deafenedRef.current = deafened;
  const messagesSilencedRef = useRef(messagesSilenced);
  messagesSilencedRef.current = messagesSilenced;

  useEffect(() => {
    setPreferences(accountId ? readNotificationSounds(accountId) : { ...DEFAULT_NOTIFICATION_SOUNDS });
    return () => {
      desktopDeliveryRef.current?.dispose();
      desktopDeliveryRef.current = null;
    };
  }, [accountId]);

  // Warm the cues as soon as there is a session rather than on the first one
  // that fires. Building the element lazily meant the very first join, mute, or
  // message cue waited on its own download before it could sound, which is the
  // case where being late is most noticeable.
  useEffect(() => {
    if (!accountId) return;
    playerRef.current ??= createNotificationSoundPlayer();
    playerRef.current.prime();
  }, [accountId]);

  useEffect(
    () => () => {
      playerRef.current?.dispose();
      playerRef.current = null;
    },
    []
  );

  const play = useCallback(
    (key: NotificationSoundKey, target?: DesktopNotificationTarget) => {
      if (!notificationSoundAllowed(key, preferencesRef.current, { deafened: deafenedRef.current })) return false;
      if (accountId && isDesktopNotificationKind(key)) {
        desktopDeliveryRef.current ??= createDesktopNotificationDelivery(window);
        desktopDeliveryRef.current(key, {
          userId: accountId,
          enabled: readDesktopNotifications(accountId),
          focused: windowFocused(),
          deafened: deafenedRef.current,
          preferences: preferencesRef.current,
          target: target ?? (activeVoiceRoomId ? { roomId: activeVoiceRoomId, kind: "voice" } : undefined),
          isCurrent: () => activationRef.current.userId === accountId,
          activate: (destination) => activationRef.current.activate(destination)
        });
      }
      playerRef.current ??= createNotificationSoundPlayer();
      return playerRef.current.play(key, preferencesRef.current.volume);
    },
    [accountId, activeVoiceRoomId]
  );

  const changeNotificationSounds = useCallback(
    (patch: Partial<NotificationSoundPreferences>) => {
      setPreferences((current) => {
        const next = { ...current, ...patch, volume: clampNotificationVolume(patch.volume ?? current.volume) };
        if (accountId) writeNotificationSounds(accountId, next);
        return next;
      });
    },
    [accountId]
  );

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
    const userIds = activeVoiceRosterUserIds(activeVoiceRoomId, voiceSnapshot, currentUserId);
    const { state, joined, left } = advanceVoiceRoster(rosterRef.current, { roomId: activeVoiceRoomId, userIds });
    rosterRef.current = state;
    if (joined.length > 0) play("voicePeerJoin");
    if (left.length > 0) play("voicePeerLeave");
  }, [activeVoiceRoomId, play, user?.id, voiceSnapshot]);

  useEffect(() => {
    const currentUserId = user?.id;
    const members = activeVoiceScreenMembers(activeVoiceRoomId, voiceSnapshot, currentUserId);
    const { state, started, stopped } = advanceVoiceScreenRoster(screenRosterRef.current, {
      roomId: activeVoiceRoomId,
      members
    });
    screenRosterRef.current = state;
    if (started.length > 0) play("screenShareStart");
    if (stopped.length > 0) play("screenShareStop");
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

  const notifyMessage = useCallback(
    (message: ChatMessage) => {
      // Do Not Disturb stops the message's sound and its desktop alert
      // together, before either is decided; a call's own cues never pass here.
      if (!accountId || messagesSilencedRef.current) return false;
      const allowed = shouldPlayMessageSound(message, {
        currentUserId: accountId,
        activeTextRoomId: activeTextRoomIdRef.current,
        windowFocused: windowFocused()
      });
      return allowed ? play("message", { roomId: message.roomId, kind: "text" }) : false;
    },
    [activeTextRoomIdRef, play, accountId]
  );

  return { notificationSounds: preferences, changeNotificationSounds, notifyMessage };
}
