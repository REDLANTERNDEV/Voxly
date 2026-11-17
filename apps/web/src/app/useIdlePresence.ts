import { useEffect, useRef, type RefObject } from "react";
import type { AfkTimeoutMinutes, PresenceStatus, VoiceSnapshot } from "@voxly/shared";
import { subscribeDesktopSystemActivity } from "../lib/desktopVoice.js";
import {
  afkActivityEvents,
  afkIdleCheckIntervalMs,
  afkMoveTarget,
  afkTimeoutFor,
  afkTimeoutMs
} from "../lib/idleActivity.js";
import type { VoxlySocket } from "../socket.js";

/**
 * Marks a member Idle once they have gone long enough without interacting, and
 * in the desktop app parks them in the AFK room after a longer idle.
 *
 * A browser marks and does not move. It can only observe input inside its own
 * window, so someone playing a fullscreen game with their microphone muted
 * produces exactly the same signal as someone who left the room — no events, no
 * speech. The two are indistinguishable here, and the costs of confusing them
 * are not symmetric: failing to flag an absent member leaves a stale name in a
 * list, while moving a present one pulls them out of the conversation and mutes
 * them, in a window they are not looking at. So the only consequence of the
 * guess is a dot.
 *
 * The desktop app narrows the guess: it reports input anywhere on the machine,
 * so the game player above stays present, and it reports a locked or sleeping
 * machine, which is as close to proof of absence as anything here gets. With
 * that signal the guess is no longer a guess, so a desktop member idle past the
 * Server's AFK timeout, and never sooner than half an hour, is moved to the AFK
 * room through the same join an owner's move uses (ADR-0040). A browser has
 * neither signal, keeps relying on its own window, and is never moved.
 */
export function useIdlePresence({
  roomServerIdsRef,
  afkTimeoutsByServerRef,
  afkRoomIdsByServerRef,
  voice,
  speaking,
  socket
}: {
  roomServerIdsRef: RefObject<Record<string, string>>;
  afkTimeoutsByServerRef: RefObject<Record<string, AfkTimeoutMinutes>>;
  afkRoomIdsByServerRef: RefObject<Record<string, string>>;
  /** `moveTo` is the ordinary join, the same one an owner's move runs through. */
  voice: { activeRoomId: string | null; moveTo: (roomId: string) => Promise<unknown> };
  speaking: boolean;
  socket: VoxlySocket | null;
}) {
  const activeVoiceRoomId = voice.activeRoomId;
  const lastActivityAtRef = useRef(Date.now());
  /** Real input only. A lock marks Idle at once but does not hurry a move. */
  const lastInputAtRef = useRef(Date.now());
  /**
   * Set by the first desktop signal. The desktop bridge exists on every
   * platform but only Windows samples, so its presence alone proves nothing.
   */
  const machineWideRef = useRef(false);
  const moveToAfkRoomRef = useRef(voice.moveTo);
  moveToAfkRoomRef.current = voice.moveTo;
  const reportedStatusRef = useRef<PresenceStatus>("online");
  const socketRef = useRef(socket);
  const activeVoiceRoomIdRef = useRef(activeVoiceRoomId);
  socketRef.current = socket;
  activeVoiceRoomIdRef.current = activeVoiceRoomId;

  /** Only transitions are sent; the socket is not a heartbeat. */
  const publishStatus = (status: PresenceStatus) => {
    if (reportedStatusRef.current === status) return;
    reportedStatusRef.current = status;
    socketRef.current?.emit("presence:setStatus", status);
  };

  useEffect(() => {
    const markActive = () => {
      lastActivityAtRef.current = Date.now();
      lastInputAtRef.current = Date.now();
      publishStatus("online");
    };
    for (const event of afkActivityEvents) {
      // Capture phase, so a handler that stops propagation cannot make the
      // person look absent.
      window.addEventListener(event, markActive, { capture: true, passive: true });
    }
    return () => {
      for (const event of afkActivityEvents) {
        window.removeEventListener(event, markActive, { capture: true });
      }
    };
  }, []);

  useEffect(
    () =>
      subscribeDesktopSystemActivity(window, (signal) => {
        machineWideRef.current = true;
        if (signal === "active") {
          lastActivityAtRef.current = Date.now();
          lastInputAtRef.current = Date.now();
          publishStatus("online");
          return;
        }
        // Backdated rather than flagged, so the next real input clears it the
        // same way it clears an idle that ran out on its own.
        lastActivityAtRef.current = 0;
        publishStatus("idle");
      }),
    []
  );

  // A new connection starts out online on the server, whatever the previous
  // one had said, so an idle that is still true has to be said again.
  useEffect(() => {
    if (!socket) return;
    const restate = () => {
      if (reportedStatusRef.current === "idle") socket.emit("presence:setStatus", "idle");
    };
    socket.on("connect", restate);
    return () => {
      socket.off("connect", restate);
    };
  }, [socket]);

  // Talking counts as being present. Only the transition into speaking is
  // observed, which is enough: the check runs on a minute-scale interval.
  useEffect(() => {
    if (!speaking) return;
    lastActivityAtRef.current = Date.now();
    lastInputAtRef.current = Date.now();
    publishStatus("online");
  }, [speaking]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const timeoutMinutes = afkTimeoutFor(
        roomServerIdsRef.current,
        afkTimeoutsByServerRef.current,
        activeVoiceRoomIdRef.current
      );
      publishStatus(Date.now() - lastActivityAtRef.current >= afkTimeoutMs(timeoutMinutes) ? "idle" : "online");
      const afkRoomId = afkMoveTarget({
        machineWide: machineWideRef.current,
        activeVoiceRoomId: activeVoiceRoomIdRef.current,
        roomServerIds: roomServerIdsRef.current,
        afkRoomIdsByServer: afkRoomIdsByServerRef.current,
        timeoutsByServer: afkTimeoutsByServerRef.current,
        idleForMs: Date.now() - lastInputAtRef.current
      });
      if (afkRoomId) void moveToAfkRoomRef.current(afkRoomId);
    }, afkIdleCheckIntervalMs);
    return () => window.clearInterval(interval);
  }, [afkRoomIdsByServerRef, afkTimeoutsByServerRef, roomServerIdsRef]);
}

/** Whether this member is speaking in the voice room they are connected to. */
export function selfSpeaking(
  voice: { activeRoomId: string | null; voiceSnapshots: Record<string, VoiceSnapshot> },
  userId: string | undefined
) {
  if (!voice.activeRoomId) return false;
  const self = voice.voiceSnapshots[voice.activeRoomId]?.members.find((member) => member.user.userId === userId);
  return Boolean(self?.media.speaking);
}
