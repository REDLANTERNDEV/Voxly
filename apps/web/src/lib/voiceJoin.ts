import type { VoiceJoinAck, VoiceJoinRequest } from "@voxly/shared";
import type { VoxlySocket } from "../socket.js";

export const voiceJoinTimeoutMs = 5_000;

export type VoiceJoinResult = VoiceJoinAck | { ok: false; error: "timeout" };

export function requestVoiceJoin(
  socket: VoxlySocket,
  request: VoiceJoinRequest,
  timeoutMs = voiceJoinTimeoutMs
): Promise<VoiceJoinResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: VoiceJoinResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    socket.emit("voice:join", request, finish);
  });
}
