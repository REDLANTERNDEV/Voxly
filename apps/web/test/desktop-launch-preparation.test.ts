import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopLaunchPreparation } from "../src/lib/desktopLaunchPreparation.js";

test("preparation shares in-flight work, renews expiration, and cancels unused requests", async () => {
  let now = 0, count = 0;
  const cancelled: string[] = [];
  const preparation = new DesktopLaunchPreparation(async () => ({ id: String(++count), account: "Member" }), async (id) => { cancelled.push(id); }, () => now);
  const [first, duplicate] = await Promise.all([preparation.prepare(), preparation.prepare()]);
  assert.deepEqual(first, duplicate); assert.equal(count, 1);
  now = 149_999; assert.deepEqual(await preparation.prepare(), first);
  now = 150_000; assert.equal((await preparation.prepare())?.id, "2");
  assert.deepEqual(cancelled, ["1"]);
  preparation.clear(); assert.deepEqual(cancelled, ["1", "2"]);
});
test("closing or replacing preparation rejects a late response; completion avoids cancellation", async () => {
  let complete!: (value: { id: string; account: string }) => void;
  const cancelled: string[] = [];
  const preparation = new DesktopLaunchPreparation(() => new Promise(resolve => { complete = resolve; }), async id => { cancelled.push(id); });
  const pending = preparation.prepare(); preparation.clear(); complete({ id: "late", account: "Member" });
  assert.equal(await pending, null); assert.deepEqual(cancelled, ["late"]);
  const current = preparation.prepare(); complete({ id: "approved", account: "Member" }); await current;
  preparation.clear(true); assert.deepEqual(cancelled, ["late"]);
});
test("failed preparation is retryable without exposing an unusable correlation", async () => {
  let count = 0;
  const preparation = new DesktopLaunchPreparation(async () => { if (++count === 1) throw new Error("offline"); return { id: "retry", account: "Member" }; }, async () => {});
  await assert.rejects(preparation.prepare(), /offline/);
  assert.equal((await preparation.prepare())?.id, "retry");
});
