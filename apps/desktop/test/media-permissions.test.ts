import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync("src-tauri/src/media-permissions.js", "utf8");
function boot(origin = "https://chat.example", top = true, fail = false) {
  const calls: unknown[][] = [];
  const window = {
    location: { origin },
    top: null as unknown,
    __TAURI_INTERNALS__: {
      invoke: (...args: unknown[]) => {
        calls.push(args);
        return fail ? Promise.reject(Error("denied")) : Promise.resolve();
      }
    },
    __VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__: undefined as
      | {
          version: number;
          resetMicrophone(...args: unknown[]): Promise<boolean>;
          resetCamera(...args: unknown[]): Promise<boolean>;
        }
      | undefined
  };
  window.top = top ? window : {};
  runInNewContext(`${source}("https://chat.example");`, { window });
  return { window, calls };
}
describe("desktop media recovery boundary", () => {
  it("only requests resetting only the selected microphone permission and sends no caller-supplied payload", async () => {
    const { window, calls } = boot();
    const bridge = window.__VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__!;
    assert.equal(bridge.version, 1);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(
      await bridge.resetMicrophone({ origin: "https://evil.example", path: "/voice", command: "quit_app" }),
      true
    );
    assert.deepEqual(calls, [["reset_microphone_permission"]]);
    assert.equal(await bridge.resetCamera({ origin: "https://evil.example" }), true);
    assert.deepEqual(calls, [["reset_microphone_permission"], ["reset_camera_permission"]]);
  });
  it("refuses other origins, subframes and navigation away from the selected origin", async () => {
    assert.equal(boot("https://evil.example").window.__VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__, undefined);
    assert.equal(boot("https://chat.example", false).window.__VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__, undefined);
    const { window, calls } = boot();
    window.location.origin = "https://evil.example";
    assert.equal(await window.__VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__!.resetMicrophone(), false);
    assert.equal(calls.length, 0);
  });
  it("contains native denial without pretending reset succeeded", async () => {
    assert.equal(
      await boot("https://chat.example", true, true).window.__VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__!.resetMicrophone(),
      false
    );
  });
});

it("does not acquire media or override microphone/camera permission requests", () => {
  assert.doesNotMatch(source, /getUserMedia|requestPermission|PermissionRequested/);
  const platform = readFileSync("src-tauri/src/platform.rs", "utf8");
  assert.match(platform, /PermissionToReset::Microphone =>\s*\{?\s*COREWEBVIEW2_PERMISSION_KIND_MICROPHONE/);
  assert.match(platform, /PermissionToReset::Camera => COREWEBVIEW2_PERMISSION_KIND_CAMERA/);
  assert.match(platform, /COREWEBVIEW2_PERMISSION_STATE_DEFAULT/);
  assert.match(platform, /same_origin\(&origin, &url\)/);
});
