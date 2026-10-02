import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("desktop link native boundary", () => {
  it("registers only Voxly and forwards through the first single-instance plugin", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    assert.deepEqual(config.plugins["deep-link"].desktop.schemes, ["voxly"]);
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
    assert.match(cargo, /tauri-plugin-single-instance = .*features = \["deep-link"\]/);
    const source = readFileSync("src-tauri/src/shell/runtime.rs", "utf8");
    assert.ok(source.indexOf(".plugin(tauri_plugin_single_instance") < source.indexOf(".plugin(tauri_plugin_deep_link"));
    assert.equal((source.match(/deep_links::from_args/g) ?? []).length, 2);
  });

  it("offers links locally and sends only a public sign-in signal to a matching window", () => {
    const source = readFileSync("src-tauri/src/shell/installation.rs", "utf8");
    const offer = source.split("fn offer_desktop_link(")[1].split("#[cfg(test)]")[0];
    assert.match(offer, /restores_active/);
    assert.match(offer, /if ready\s*&& deep_links::restores_active/);
    assert.match(offer, /serde_json::to_string\(id\)/);
    assert.match(offer, /voxly:desktop-launch/);
    assert.match(offer, /show_current\(app\)/);
    assert.match(offer, /emit_to\("shell", "shell:desktop-link", \(\)\)/);
    assert.doesNotMatch(offer, /destroy|navigate|connect_installation|check_health|persist|voice_generation\.fetch/);
    const remote = readFileSync("src-tauri/src/platform.rs", "utf8");
    assert.doesNotMatch(remote, /allow-take-desktop-link|deep-link:/);
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/shell.json", "utf8"));
    assert.ok(capability.permissions.includes("allow-take-desktop-link"));
    assert.ok(!capability.permissions.some((value: string) => value.startsWith("deep-link:")));
    const ui = readFileSync("src/main.ts", "utf8");
    assert.ok(ui.indexOf('await listen("shell:desktop-link"') < ui.lastIndexOf("await receiveDesktopLink()"));
    const receive = ui.split("async function receiveDesktopLink()")[1].split('element("desktop-link-review")')[0];
    const intake = receive.split("async function openDesktopLink")[0];
    assert.match(intake, /state\?\.preferences\.installations\.some/);
    assert.match(intake, /if \(busy\) deferredDesktopLink = target/);
    assert.match(ui, /const target = deferredDesktopLink; deferredDesktopLink = null/);
    assert.doesNotMatch(intake, /save_installation|stopMedia|location\./);
    assert.match(receive, /await transition/);
  });
});
