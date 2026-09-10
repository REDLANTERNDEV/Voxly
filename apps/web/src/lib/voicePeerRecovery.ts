export const voicePeerRecoveryGraceMs = 3_000;
export const voicePeerConnectionTimeoutMs = 10_000;

const rebuildBackoffMs = [0, 1_000, 2_000, 5_000] as const;

export type PeerRecoveryPhase = "idle" | "stable" | "grace" | "restarting" | "rebuilding";
export type PeerRecoveryAction = "wait" | "restart_ice" | "rebuild_peer" | "cancel";

export interface PeerRecoveryState {
  phase: PeerRecoveryPhase;
  attempt: number;
  nextRetryAt: number | null;
}

export type PeerRecoveryEvent =
  | { type: "disconnected" }
  | { type: "grace_elapsed" }
  | { type: "failed" }
  | { type: "connected" }
  | { type: "member_left" }
  | { type: "restart_succeeded" }
  | { type: "restart_failed" };

export function initialPeerRecoveryState(): PeerRecoveryState {
  return { phase: "stable", attempt: 0, nextRetryAt: null };
}

export function advancePeerRecovery(
  state: PeerRecoveryState,
  event: PeerRecoveryEvent,
  now: number
): { state: PeerRecoveryState; action: PeerRecoveryAction } {
  if (event.type === "member_left") {
    return { state: { phase: "idle", attempt: state.attempt, nextRetryAt: null }, action: "cancel" as const };
  }

  if (event.type === "connected" || event.type === "restart_succeeded") {
    return { state: { phase: "stable", attempt: 0, nextRetryAt: null }, action: "cancel" as const };
  }

  if (event.type === "disconnected") {
    return {
      state: { phase: "grace", attempt: state.attempt, nextRetryAt: now + voicePeerRecoveryGraceMs },
      action: "wait" as const
    };
  }

  if (event.type === "grace_elapsed") {
    return {
      state: { phase: "restarting", attempt: state.attempt, nextRetryAt: null },
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
        nextRetryAt: now + delay
      },
      action: "rebuild_peer" as const
    };
  }

  return { state, action: "wait" as const };
}
