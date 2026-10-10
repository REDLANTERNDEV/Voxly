import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const source = readFileSync("src-tauri/src/diagnostics-bridge.js", "utf8");
describe("desktop diagnostics export boundary", () => {
  it("sends a finite report save intent only from the trusted top frame", async () => {
    const calls: unknown[] = [];
    const window: Record<string, any> = {
      location: { origin: "https://chat.example" },
      __TAURI_INTERNALS__: {
        invoke: async (...args: unknown[]) => {
          calls.push(args);
          return "cancelled";
        }
      }
    };
    window.top = window;
    vm.runInNewContext(`${source}("https://chat.example")`, { window });
    assert.equal(await window.__VOXLY_DESKTOP_DIAGNOSTICS_V1__.save('{"version":1,"calls":[]}'), "cancelled");
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ["save_voice_diagnostics", { report: '{"version":1,"calls":[]}' }]
    ]);
    window.location.origin = "https://other.example";
    await assert.rejects(window.__VOXLY_DESKTOP_DIAGNOSTICS_V1__.save("{}"), /forbidden/);
    assert.equal(calls.length, 1);
  });
  it("does not expose the bridge in subframes or other origins", () => {
    for (const origin of ["https://chat.example", "https://other.example"]) {
      const window: Record<string, any> = { top: {}, location: { origin } };
      vm.runInNewContext(`${source}("https://chat.example")`, { window });
      assert.equal(window.__VOXLY_DESKTOP_DIAGNOSTICS_V1__, undefined);
    }
  });
  it("registers only the export command, keeps downloads blocked, and rechecks authority after Save As", () => {
    const native = readFileSync("src-tauri/src/shell/diagnostics.rs", "utf8");
    const platform = readFileSync("src-tauri/src/platform.rs", "utf8");
    const build = readFileSync("src-tauri/build.rs", "utf8");
    assert.match(build, /"save_voice_diagnostics"/);
    assert.match(platform, /permission\("allow-save-voice-diagnostics"\)/);
    assert.match(platform, /on_download\(\|_, _\| false\)/);
    assert.match(
      native,
      /receiver.await[\s\S]*current_generation != generation[\s\S]*report_caller_matches[\s\S]*std::fs::write/
    );
    assert.match(native, /set_file_name\("voxly-voice-diagnostics.json"\)/);
    assert.doesNotMatch(source, /path|filename|writeFile|dialog:/i);
  });
});
