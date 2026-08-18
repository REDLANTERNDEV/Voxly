import { useEffect, useRef, type RefObject } from "react";
import type { AfkTimeoutMinutes, PresenceStatus } from "@voxly/shared";
import {
  afkActivityEvents,
  afkIdleCheckIntervalMs,
  afkRoomIdFor,
  afkTimeoutFor,
  afkTimeoutMs,
  shouldMoveToAfk
} from "../lib/idleActivity.js";

/**
 * Parks a member in their server's AFK room once they have gone long enough
 * without interacting.
 *
 * The move is an ordinary voice join, so the server needs no new authority for
 * it: leaving the previous room, presence, and media state all follow the paths
 * a manual channel change already uses.
 */
export function useIdleAfk({ roomServerIdsRef, afkRoomIdsByServerRef, afkTimeoutsByServerRef, activeVoiceRoomId, speaking, joinVoice, reportStatus }: {
  roomServerIdsRef: RefObject<Record<string, string>>;
  afkRoomIdsByServerRef: RefObject<Record<string, string>>;
  afkTimeoutsByServerRef: RefObject<Record<string, AfkTimeoutMinutes>>;
  activeVoiceRoomId: string | null;
  speaking: boolean;
  joinVoice: (roomId: string) => Promise<boolean>;
  /** Publishes the away state to the directory, independently of any move. */
  reportStatus: (status: PresenceStatus) => void;
}) {
  const lastActivityAtRef = useRef(Date.now());
  const movingRef = useRef(false);
  const reportedStatusRef = useRef<PresenceStatus>("online");
  const reportStatusRef = useRef(reportStatus);
  reportStatusRef.current = reportStatus;

  // Reported separately from the move, because being away is worth showing in
  // the directory whether or not the member is in a voice room to be moved out
  // of. Only transitions are sent; the socket is not a heartbeat.
  const publishStatus = (status: PresenceStatus) => {
    if (reportedStatusRef.current === status) return;
    reportedStatusRef.current = status;
    reportStatusRef.current(status);
  };
  const activeVoiceRoomIdRef = useRef(activeVoiceRoomId);
  const joinVoiceRef = useRef(joinVoice);
  activeVoiceRoomIdRef.current = activeVoiceRoomId;
  joinVoiceRef.current = joinVoice;

  useEffect(() => {
    const markActive = () => {
      lastActivityAtRef.current = Date.now();
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

  // Talking counts as being present. Only the transition into speaking is
  // observed, which is enough: the check runs on a minute-scale interval.
  useEffect(() => {
    if (!speaking) return;
    lastActivityAtRef.current = Date.now();
    publishStatus("online");
  }, [speaking]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (movingRef.current) return;
      const activeRoomId = activeVoiceRoomIdRef.current;
      const timeoutMinutes = afkTimeoutFor(roomServerIdsRef.current, afkTimeoutsByServerRef.current, activeRoomId);
      publishStatus(Date.now() - lastActivityAtRef.current >= afkTimeoutMs(timeoutMinutes) ? "idle" : "online");
      const afkRoomId = afkRoomIdFor(roomServerIdsRef.current, afkRoomIdsByServerRef.current, activeRoomId);
      if (!shouldMoveToAfk({
        lastActivityAt: lastActivityAtRef.current,
        now: Date.now(),
        activeVoiceRoomId: activeRoomId,
        afkRoomId,
        timeoutMinutes
      })) return;
      movingRef.current = true;
      // A failed move must not retry every tick; the next interaction resets
      // the clock and the next idle stretch tries again.
      lastActivityAtRef.current = Date.now();
      void joinVoiceRef.current(afkRoomId as string)
        .catch(() => undefined)
        .finally(() => { movingRef.current = false; });
    }, afkIdleCheckIntervalMs);
    return () => window.clearInterval(interval);
  }, [afkRoomIdsByServerRef, afkTimeoutsByServerRef, roomServerIdsRef]);
}
