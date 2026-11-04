/**
 * The Call length shown beside a voice room's name.
 *
 * The server sends how long a Call had run when it published the snapshot. The
 * browser anchors that to its own monotonic clock on arrival and counts up from
 * there, so nothing travels once a second and a wrong wall clock on this
 * computer changes nothing.
 */

/** How far a fresh snapshot may disagree with the anchor before it moves. */
const reanchorToleranceMs = 1_500;

/**
 * Where on this browser's monotonic clock the room's Call began, given the
 * anchor held so far and a snapshot that has just arrived; `undefined` when no
 * Call is running. Every snapshot arrives a little late, and by a different
 * amount each time, so re-anchoring on each one would nudge the seconds back
 * and forth whenever anybody in the room muted. Small disagreements keep the
 * anchor where it is.
 */
export function nextCallStart(
  previous: number | undefined,
  callLengthMs: number | undefined,
  receivedAt: number
): number | undefined {
  if (callLengthMs === undefined) return undefined;
  const start = receivedAt - callLengthMs;
  return previous !== undefined && Math.abs(previous - start) <= reanchorToleranceMs ? previous : start;
}

/** `4:07` under an hour and `1:04:07` from one; hours keep counting past a day. */
export function formatCallLength(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Whole minutes, for the accessible name, which must not change every second. */
export function callLengthMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}
