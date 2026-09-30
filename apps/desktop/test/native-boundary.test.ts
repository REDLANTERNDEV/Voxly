import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("desktop native trust boundary", () => {
  it("keeps bundled capabilities local and denies plugin-wide permissions", () => {
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
    const commands = [...native.matchAll(/#\[tauri::command\]\s*async fn (\w+)\((?:(?!#\[tauri::command\])[\s\S])*?\{\s*trusted_shell\(&window\)\?;/g)].map((match) => match[1]);
    assert.equal(commands.length + 2, (native.match(/#\[tauri::command\]/g) ?? []).length);
    assert.match(native, /async fn report_call_state/);
    assert.match(native, /report_caller_matches\(/);
    assert.match(native, /same_origin\(origin, url\)/);
    assert.match(native, /shell.reports.receive\(generation, request, report\)/);
    assert.match(native, /async fn activate_installation/);
    assert.match(native, /window\.unminimize\(\)/);
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
    assert.match(source, /add_capability/);
    assert.match(source, /\.local\(false\)/);
    assert.match(source, /\.remote\(format!/);
    assert.match(source, /\.webview\(&label\)/);
    assert.match(source, /\.permission\("allow-report-call-state"\)/);
    assert.match(source, /\.permission\("allow-activate-installation"\)/);
    assert.match(source, /installation_label\(generation\)/);
    assert.doesNotMatch(source, /permission\(".*(?:updater|opener|shortcut|filesystem)/);
    assert.match(source, /initialization_script\(&bootstrap\)/);
    const bootstrap = readFileSync("src-tauri/src/voice-bridge.js", "utf8");
    assert.doesNotMatch(bootstrap, /invoke|ipc|postMessage|__TAURI__/);
    assert.match(readFileSync("src-tauri/src/main.rs", "utf8"), /open_js_links_on_click\(false\)/);
  });
});
