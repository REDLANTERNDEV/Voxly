import type { VisualTarget, VoiceSetVisualSubscriptionsAck } from "@voxly/shared";
import type { VoxlySocket } from "../socket.js";

export const voiceRecoveryRetryDelayMs = 2_000;
export const visualSubscriptionTimeoutMs = 5_000;

export interface VisualSubscriptionRequest {
  roomId: string;
  targets: VisualTarget[];
}

export type VisualSubscriptionResult = VoiceSetVisualSubscriptionsAck | { ok: false; error: "timeout" };

export function requestVisualSubscriptions(
  socket: VoxlySocket,
  request: VisualSubscriptionRequest,
  timeoutMs = visualSubscriptionTimeoutMs
): Promise<VisualSubscriptionResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: VisualSubscriptionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    socket.emit("voice:setVisualSubscriptions", request, (response) => finish(response));
  });
}
