import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("desktop native trust boundary", () => {
  it("gives only the local shell a capability and no plugin-wide permissions", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/shell.json", "utf8"));
    assert.deepEqual(config.app.security.capabilities, ["local-shell"]);
    assert.deepEqual(capability.windows, ["shell"]);
    assert.deepEqual(capability.webviews, ["shell"]);
    assert.equal(capability.local, true);
    assert.equal(capability.remote, undefined);
    assert.equal(config.app.withGlobalTauri, false);
    assert.ok(capability.permissions.every((permission: string) => !permission.includes("default") && !permission.includes("opener:") && !permission.includes("updater:") && !permission.includes("shell:") && !permission.includes("global-shortcut:")));
  });

  it("generates ACL permissions and checks the caller for every custom command", () => {
    const native = readFileSync("src-tauri/src/main.rs", "utf8");
    const build = readFileSync("src-tauri/build.rs", "utf8");
    assert.match(build, /AppManifest::new\(\)\.commands/);
    const commands = [...native.matchAll(/#\[tauri::command\]\s*async fn (\w+)\([\s\S]*?\{\s*trusted_shell\(&window\)\?;/g)].map((match) => match[1]);
    assert.equal(commands.length, (native.match(/#\[tauri::command\]/g) ?? []).length);
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/shell.json", "utf8"));
    for (const command of commands) {
      assert.ok(build.includes(`"${command}"`));
      assert.ok(capability.permissions.includes(`allow-${command.replaceAll("_", "-")}`));
    }
  });

  it("keeps the voice intent bridge separate from native authority", () => {
    const source = readFileSync("src-tauri/src/platform.rs", "utf8");
    assert.match(source, /\.data_directory\(data\.join\("profiles"\)\.join\(&saved.id\)\)/);
    assert.match(source, /\.on_navigation/);
    assert.match(source, /same_origin/);
    assert.match(source, /NewWindowResponse::Deny/);
    assert.doesNotMatch(source, /add_capability/);
    assert.match(source, /initialization_script\(&bootstrap\)/);
    const bootstrap = readFileSync("src-tauri/src/voice-bridge.js", "utf8");
    assert.doesNotMatch(bootstrap, /invoke|ipc|postMessage|__TAURI__/);
    assert.match(readFileSync("src-tauri/src/main.rs", "utf8"), /open_js_links_on_click\(false\)/);
  });
});
