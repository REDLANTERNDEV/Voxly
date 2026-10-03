import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopUpdateBridge, desktopUpdateNotice, desktopUpdateSnapshot, observeDesktopUpdates, type DesktopUpdateBridge } from "../src/lib/desktopUpdates.js";

const ready = { currentVersion: "0.1.0", phase: "ready", version: "0.2.0", error: null };
test("desktop update presentation distinguishes verified readiness, cancellation and invalid downloads", () => {
  assert.equal(desktopUpdateNotice(desktopUpdateSnapshot(ready)), "ready");
  assert.equal(desktopUpdateNotice(desktopUpdateSnapshot({ ...ready, phase: "available", error: "update_cancelled" })), null);
  assert.equal(desktopUpdateNotice(desktopUpdateSnapshot({ ...ready, phase: "available", error: "update_signature" })), "invalid");
  assert.equal(desktopUpdateNotice(desktopUpdateSnapshot({ ...ready, phase: "disabled" })), null);
  for (const value of [null, {}, { ...ready, phase: "unknown" }, { ...ready, version: "https://evil.example" }, { ...ready, currentVersion: "x" }]) assert.equal(desktopUpdateSnapshot(value), null);
  assert.equal(desktopUpdateBridge({}), null);
});

test("desktop observers ignore stale reads, serialize polls and stop after disposal", async () => {
  let push: ((value: unknown) => void) | null = null;
  let resolveRead: ((value: unknown) => void) | null = null;
  let tick: (() => void) | null = null;
  let reads = 0;
  let unsubscribed = false;
  let cleared = false;
  const values: unknown[] = [];
  const bridge: DesktopUpdateBridge = { version: 1, review: async () => true,
    read: () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); },
    subscribe: handler => { push = handler; return () => { unsubscribed = true; }; } };
  const timers = {
    setInterval: ((handler: () => void, interval: number) => { assert.equal(interval, 60_000); tick = handler; return 1; }) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => { cleared = true; }) as typeof globalThis.clearInterval
  };
  const stop = observeDesktopUpdates(bridge, snapshot => values.push(snapshot), timers);
  (tick as unknown as () => void)();
  assert.equal(reads, 1);
  (push as unknown as (value: unknown) => void)(ready);
  (resolveRead as unknown as (value: unknown) => void)({ ...ready, phase: "current", version: null });
  await Promise.resolve();
  assert.deepEqual(values, [ready]);
  (tick as unknown as () => void)();
  assert.equal(reads, 2);
  stop();
  (resolveRead as unknown as (value: unknown) => void)(ready);
  (push as unknown as (value: unknown) => void)(ready);
  await Promise.resolve();
  assert.equal(values.length, 1);
  assert.equal(unsubscribed && cleared, true);
});
