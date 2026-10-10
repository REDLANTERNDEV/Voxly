import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync("src-tauri/src/update-bridge.js", "utf8");
function boot(origin = "https://chat.example", top = true) {
  const calls: unknown[][] = [];
  const window = {
    location: { origin },
    top: null as unknown,
    __TAURI_INTERNALS__: {
      invoke: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ currentVersion: "0.1.0" });
      }
    },
    __VOXLY_DESKTOP_UPDATES_V1__: undefined as
      | undefined
      | {
          version: number;
          read(...args: unknown[]): Promise<unknown>;
          review(...args: unknown[]): Promise<boolean>;
          subscribe(handler: (value: unknown) => void): () => void;
          dispatch(value: unknown): void;
        }
  };
  window.top = top ? window : {};
  runInNewContext(`${source}("https://chat.example");`, { window });
  return { window, calls };
}
test("Installation update bridge only reads state and opens trusted local review", async () => {
  const { window, calls } = boot();
  const bridge = window.__VOXLY_DESKTOP_UPDATES_V1__!;
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.read({ endpoint: "https://evil.example" });
  assert.equal(await bridge.review({ confirmed: true, command: "install_shell_update" }), true);
  assert.deepEqual(calls, [["read_desktop_update"], ["review_desktop_update"]]);
  const updates: unknown[] = [];
  const stop = bridge.subscribe((value) => updates.push(value));
  bridge.dispatch("ready");
  stop();
  bridge.dispatch("later");
  assert.deepEqual(updates, ["ready"]);
});
test("update bridge refuses subframes, other origins and navigation away", async () => {
  assert.equal(boot("https://evil.example").window.__VOXLY_DESKTOP_UPDATES_V1__, undefined);
  assert.equal(boot("https://chat.example", false).window.__VOXLY_DESKTOP_UPDATES_V1__, undefined);
  const { window, calls } = boot();
  window.location.origin = "https://evil.example";
  assert.equal(await window.__VOXLY_DESKTOP_UPDATES_V1__!.read(), null);
  assert.equal(await window.__VOXLY_DESKTOP_UPDATES_V1__!.review(), false);
  assert.deepEqual(calls, []);
});
