export const voicePeerRecoveryGraceMs = 3_000;
export const voicePeerConnectionTimeoutMs = 10_000;

/** ICE connectivity only proves a candidate route. Media is ready after the
 * peer connection itself reaches connected, which includes DTLS completion. */
export function isPeerConnectionReady(connectionState: string) {
  return connectionState === "connected";
}

const rebuildBackoffMs = [0, 1_000, 2_000, 5_000] as const;

export type PeerRecoveryPhase = "idle" | "stable" | "grace" | "restarting" | "rebuilding";
export type PeerRecoveryAction = "wait" | "restart_ice" | "rebuild_peer" | "cancel";

export interface PeerRecoveryState {
  phase: PeerRecoveryPhase;
  attempt: number;
  nextRetryAt: number | null;
  reason: "quality" | "transport" | null;
}

export type PeerRecoveryEvent =
  | { type: "disconnected" }
  | { type: "grace_elapsed" }
  | { type: "quality_degraded" }
  | { type: "quality_restored" }
  | { type: "recovery_requested" }
  | { type: "failed" }
  | { type: "connected" }
  | { type: "member_left" }
  | { type: "restart_succeeded" }
  | { type: "restart_failed" };

export function initialPeerRecoveryState(): PeerRecoveryState {
  return { phase: "stable", attempt: 0, nextRetryAt: null, reason: null };
}

export function advancePeerRecovery(
  state: PeerRecoveryState,
  event: PeerRecoveryEvent,
  now: number
): { state: PeerRecoveryState; action: PeerRecoveryAction } {
  if (event.type === "member_left") {
    return { state: { phase: "idle", attempt: state.attempt, nextRetryAt: null, reason: null }, action: "cancel" as const };
  }

  if (event.type === "quality_restored") {
    if (state.phase !== "restarting" || state.reason !== "quality") return { state, action: "wait" };
    return { state: initialPeerRecoveryState(), action: "cancel" };
  }

  if (event.type === "connected" || event.type === "restart_succeeded") {
    // ICE can remain connected throughout an audio fault and its restart.
    // Only a fresh clear decoder sample can confirm a quality recovery.
    if (state.phase === "restarting" && state.reason === "quality") return { state, action: "wait" };
    return { state: initialPeerRecoveryState(), action: "cancel" as const };
  }

  if (event.type === "disconnected") {
    return {
      state: { phase: "grace", attempt: state.attempt, nextRetryAt: now + voicePeerRecoveryGraceMs, reason: "transport" },
      action: "wait" as const
    };
  }

  if (event.type === "grace_elapsed") {
    return {
      state: { phase: "restarting", attempt: state.attempt, nextRetryAt: null, reason: "transport" },
      action: "restart_ice" as const
    };
  }

  if (event.type === "quality_degraded" || event.type === "recovery_requested") {
    if (state.phase !== "stable") return { state, action: "wait" as const };
    return {
      state: {
        phase: "restarting",
        attempt: state.attempt,
        nextRetryAt: null,
        reason: event.type === "quality_degraded" ? "quality" : "transport"
      },
      action: "restart_ice" as const
    };
  }

  if (event.type === "restart_failed" || event.type === "failed") {
    const attemptIndex = Math.min(state.attempt, rebuildBackoffMs.length - 1);
    const delay = rebuildBackoffMs[attemptIndex];
    return {
      state: {
        phase: "rebuilding",
        attempt: Math.min(state.attempt + 1, rebuildBackoffMs.length - 1),
        nextRetryAt: now + delay,
        reason: state.reason
      },
      action: "rebuild_peer" as const
    };
  }

  return { state, action: "wait" as const };
}
