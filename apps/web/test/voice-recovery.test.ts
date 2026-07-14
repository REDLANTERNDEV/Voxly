import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VisualTarget, VoiceSetVisualSubscriptionsAck } from "@voxly/shared";
import { requestVisualSubscriptions, voiceRecoveryRetryDelayMs } from "../src/lib/voiceRecovery.js";
import type { VoxlySocket } from "../src/socket.js";

describe("voice recovery requests", () => {
  it("settles with the visual subscription acknowledgement", async () => {
    const targets: VisualTarget[] = [{ publisherUserId: "publisher", kind: "screen" }];
    const response: VoiceSetVisualSubscriptionsAck = { ok: true, targets };
    const socket = {
      emit: (_event: string, _request: unknown, ack: (value: VoiceSetVisualSubscriptionsAck) => void) => ack(response)
    } as unknown as VoxlySocket;

    assert.deepEqual(await requestVisualSubscriptions(socket, { roomId: "lobby", targets }, 25), response);
  });

  it("returns a deterministic timeout when the subscription ACK is lost", async () => {
    const socket = { emit: () => undefined } as unknown as VoxlySocket;

    assert.deepEqual(await requestVisualSubscriptions(socket, { roomId: "lobby", targets: [] }, 1), {
      ok: false,
      error: "timeout"
    });
  });

  it("uses a bounded delay between connected recovery attempts", () => {
    assert.equal(voiceRecoveryRetryDelayMs, 2_000);
  });
});
