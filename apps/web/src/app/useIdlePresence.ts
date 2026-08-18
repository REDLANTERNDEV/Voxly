import { useEffect, useRef, type RefObject } from "react";
import type { AfkTimeoutMinutes, PresenceStatus } from "@voxly/shared";
import {
  afkActivityEvents,
  afkIdleCheckIntervalMs,
  afkTimeoutFor,
  afkTimeoutMs
} from "../lib/idleActivity.js";

/**
 * Marks a member away once they have gone long enough without interacting.
 *
 * It marks and does not move. A browser can only observe input inside its own
 * window, so someone playing a fullscreen game with their microphone muted
 * produces exactly the same signal as someone who left the room — no events, no
 * speech. The two are indistinguishable here, and the costs of confusing them
 * are not symmetric: failing to flag an absent member leaves a stale name in a
 * list, while moving a present one pulls them out of the conversation and mutes
 * them, in a window they are not looking at. So the only consequence of the
 * guess is a dot.
 */
export function useIdlePresence({ roomServerIdsRef, afkTimeoutsByServerRef, activeVoiceRoomId, speaking, reportStatus }: {
  roomServerIdsRef: RefObject<Record<string, string>>;
  afkTimeoutsByServerRef: RefObject<Record<string, AfkTimeoutMinutes>>;
  activeVoiceRoomId: string | null;
  speaking: boolean;
  reportStatus: (status: PresenceStatus) => void;
}) {
  const lastActivityAtRef = useRef(Date.now());
  const reportedStatusRef = useRef<PresenceStatus>("online");
  const reportStatusRef = useRef(reportStatus);
  const activeVoiceRoomIdRef = useRef(activeVoiceRoomId);
  reportStatusRef.current = reportStatus;
  activeVoiceRoomIdRef.current = activeVoiceRoomId;

  /** Only transitions are sent; the socket is not a heartbeat. */
  const publishStatus = (status: PresenceStatus) => {
    if (reportedStatusRef.current === status) return;
    reportedStatusRef.current = status;
    reportStatusRef.current(status);
  };

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
      const timeoutMinutes = afkTimeoutFor(
        roomServerIdsRef.current,
        afkTimeoutsByServerRef.current,
        activeVoiceRoomIdRef.current
      );
      publishStatus(Date.now() - lastActivityAtRef.current >= afkTimeoutMs(timeoutMinutes) ? "idle" : "online");
    }, afkIdleCheckIntervalMs);
    return () => window.clearInterval(interval);
  }, [afkTimeoutsByServerRef, roomServerIdsRef]);
}
