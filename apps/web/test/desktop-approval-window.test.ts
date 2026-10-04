import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopApprovalWindow } from "../src/lib/desktopApprovalWindow.js";
import type { DesktopSettingsSnapshot } from "../src/lib/desktopSettings.js";

function fixture() {
  const calls: string[] = [];
  let current = true;
  const target = {
    __VOXLY_DESKTOP_ACTIVATION_V1__: { version: 1 as const, minimize: async () => { calls.push("minimize"); return true; }, show: async () => { calls.push("show"); return true; } },
    __VOXLY_DESKTOP_SETTINGS_V1__: { version: 1 as const, apply: async (operation: { kind: string }) => { calls.push(operation.kind); return {} as DesktopSettingsSnapshot; } }
  };
  return { target, calls, stale() { current = false; }, controller: createDesktopApprovalWindow(target, () => current) };
}

test("browser approval waits for readiness, minimizes once and restores once", async () => {
  const { controller, calls } = fixture();
  const first = controller.minimize();
  assert.equal(controller.minimize(), first);
  assert.equal(await first, true);
  await Promise.all([controller.restore(), controller.restore()]);
  assert.deepEqual(calls, ["ready", "minimize", "show"]);
});

test("approval waits for an in-flight minimize before restoring the window", async () => {
  const { controller, target, calls } = fixture();
  let complete!: (value: boolean) => void;
  target.__VOXLY_DESKTOP_ACTIVATION_V1__.minimize = () => { calls.push("minimize"); return new Promise(resolve => { complete = resolve; }); };
  const minimizing = controller.minimize();
  await Promise.resolve();
  const restoring = controller.restore();
  assert.deepEqual(calls, ["ready", "minimize"]);
  complete(true);
  await Promise.all([minimizing, restoring]);
  assert.deepEqual(calls, ["ready", "minimize", "show"]);
});

test("a stale attempt cannot minimize after readiness or restore after a late native result", async () => {
  const early = fixture();
  const minimizing = early.controller.minimize();
  early.stale();
  assert.equal(await minimizing, false);
  await early.controller.restore();
  assert.deepEqual(early.calls, ["ready"]);

  const late = fixture();
  let complete!: (value: boolean) => void;
  late.target.__VOXLY_DESKTOP_ACTIVATION_V1__.minimize = () => { late.calls.push("minimize"); return new Promise(resolve => { complete = resolve; }); };
  const pending = late.controller.minimize();
  await Promise.resolve();
  late.stale();
  complete(true);
  await pending;
  await late.controller.restore();
  assert.deepEqual(late.calls, ["ready", "minimize"]);
});

test("completion before readiness prevents a delayed minimize", async () => {
  const { controller, calls } = fixture();
  const minimizing = controller.minimize();
  const restoring = controller.restore();
  assert.equal(await minimizing, false);
  await restoring;
  assert.deepEqual(calls, ["ready"]);
  assert.equal(await controller.minimize(), false);
});

test("ordinary browsers and older activation bridges leave sign-in usable", async () => {
  for (const target of [{}, { __VOXLY_DESKTOP_ACTIVATION_V1__: { version: 1 as const, show: async () => { assert.fail("must not change focus"); return false; } } }]) {
    const controller = createDesktopApprovalWindow(target, () => true);
    assert.equal(await controller.minimize(), false);
    await controller.restore();
  }
});

test("native failures do not break sign-in or claim a failed minimize needs restoration", async () => {
  const denied = fixture();
  denied.target.__VOXLY_DESKTOP_ACTIVATION_V1__.minimize = async () => { throw Error("denied"); };
  assert.equal(await denied.controller.minimize(), false);
  await denied.controller.restore();
  assert.deepEqual(denied.calls, ["ready"]);
  const failedReady = fixture();
  failedReady.target.__VOXLY_DESKTOP_SETTINGS_V1__.apply = async () => { throw Error("not ready"); };
  assert.equal(await failedReady.controller.minimize(), false);
  await failedReady.controller.restore();
  assert.deepEqual(failedReady.calls, []);
  const failedRestore = fixture();
  failedRestore.target.__VOXLY_DESKTOP_ACTIVATION_V1__.show = async () => { throw Error("denied"); };
  assert.equal(await failedRestore.controller.minimize(), true);
  await failedRestore.controller.restore();
});
