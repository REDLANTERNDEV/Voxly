import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync("src-tauri/src/activation.js", "utf8");
function boot(origin = "https://chat.example", top = true, fail = false) {
  const calls: unknown[][] = [];
  const window = {
    location: { origin }, top: null as unknown,
    __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => {
      calls.push(args);
      return fail ? Promise.reject(Error("denied")) : Promise.resolve();
    } },
    __VOXLY_DESKTOP_ACTIVATION_V1__: undefined as { version: number; show(...args: unknown[]): Promise<boolean>; minimize(...args: unknown[]): Promise<boolean> } | undefined
  };
  window.top = top ? window : {};
  runInNewContext(`${source}("https://chat.example");`, { window });
  return { window, calls };
}
describe("desktop activation boundary", () => {
  it("only requests showing the current window and sends no caller-supplied payload", async () => {
    const { window, calls } = boot();
    const bridge = window.__VOXLY_DESKTOP_ACTIVATION_V1__!;
    assert.equal(bridge.version, 1);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(await bridge.show({ origin: "https://evil.example", path: "/voice", command: "quit_app" }), true);
    assert.deepEqual(calls, [["activate_installation"]]);
  });
  it("refuses other origins, subframes and navigation away from the selected origin", async () => {
    assert.equal(boot("https://evil.example").window.__VOXLY_DESKTOP_ACTIVATION_V1__, undefined);
    assert.equal(boot("https://chat.example", false).window.__VOXLY_DESKTOP_ACTIVATION_V1__, undefined);
    const { window, calls } = boot();
    window.location.origin = "https://evil.example";
    assert.equal(await window.__VOXLY_DESKTOP_ACTIVATION_V1__!.show(), false);
    assert.equal(calls.length, 0);
  });
  it("contains native denial without pretending focus succeeded", async () => {
    assert.equal(await boot("https://chat.example", true, true).window.__VOXLY_DESKTOP_ACTIVATION_V1__!.show(), false);
  });
  it("minimizes only its own window without a caller-supplied payload", async () => {
    const { window, calls } = boot();
    assert.equal(await window.__VOXLY_DESKTOP_ACTIVATION_V1__!.minimize({ command: "quit_app", origin: "https://evil.example" }), true);
    assert.deepEqual(calls, [["minimize_installation"]]);
  });
  it("contains minimize denial and refuses navigation away or a subframe", async () => {
    assert.equal(await boot("https://chat.example", true, true).window.__VOXLY_DESKTOP_ACTIVATION_V1__!.minimize(), false);
    const { window, calls } = boot();
    window.location.origin = "https://evil.example";
    assert.equal(await window.__VOXLY_DESKTOP_ACTIVATION_V1__!.minimize(), false);
    window.location.origin = "https://chat.example";
    window.top = {};
    assert.equal(await window.__VOXLY_DESKTOP_ACTIVATION_V1__!.minimize(), false);
    assert.equal(calls.length, 0);
  });
});
