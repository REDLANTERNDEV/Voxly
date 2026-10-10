import assert from "node:assert/strict";
import { it } from "node:test";
import { observeSocketRoomChange } from "../src/socket.js";

it("contains a rejected room change instead of leaving an unhandled rejection", async (t) => {
  const failures: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => failures.push(args));
  const cause = new Error("adapter unavailable");
  observeSocketRoomChange(Promise.reject(cause));
  await Promise.resolve();
  assert.deepEqual(failures, [["socket room change failed", cause]]);
});

it("accepts synchronous and successful room changes without reporting failure", async (t) => {
  const failures: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => failures.push(args));
  observeSocketRoomChange(undefined);
  observeSocketRoomChange(Promise.resolve());
  await Promise.resolve();
  assert.deepEqual(failures, []);
});
