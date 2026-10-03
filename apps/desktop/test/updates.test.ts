import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { installVerifiedUpdate } from "../src/updates.js";
import { english, turkish } from "../src/i18n.js";

test("update cancellation retains calls and chooser capture, including unavailable state", async () => {
  for (const fails of [false, true]) {
    const events: string[] = [];
    const installed = await installVerifiedUpdate({ report: async () => {
      if (fails) throw new Error("offline");
      return null;
    }, confirm: async (report) => { assert.equal(report, null); events.push("confirm"); return false; },
    stop: () => events.push("stop"), install: async () => { events.push("install"); } });
    assert.equal(installed, false);
    assert.deepEqual(events, ["confirm"]);
  }
});

test("idle updates also require confirmation and stop chooser media before installation", async () => {
  const events: string[] = [];
  const installed = await installVerifiedUpdate({ report: async () => {
    events.push("report");
    return { version: 1, inVoice: false, microphone: false, camera: false, screen: false, computerAudio: false, capture: false, pendingJoin: false, pendingCapture: false, microphoneTest: false };
  }, confirm: async () => { events.push("confirm"); return true; }, stop: () => events.push("stop"),
  install: async () => { events.push("install"); } });
  assert.equal(installed, true);
  assert.deepEqual(events, ["report", "confirm", "stop", "install"]);
});

test("updater authority and trust remain bundled, with explicit native consent before teardown", () => {
  const main = readFileSync("src-tauri/src/shell/update_commands.rs", "utf8");
  const install = main.slice(main.indexOf("async fn install_shell_update"));
  assert.ok(install.indexOf('if !confirmed') < install.indexOf('remote.destroy()'));
  assert.ok(install.indexOf('remote.destroy()') < install.indexOf('prepared.launch()'));
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  assert.equal(config.plugins.updater, undefined);
  assert.equal(config.bundle.createUpdaterArtifacts, undefined);
  for (const key of Object.keys(english).filter((key) => key.startsWith("update"))) {
    assert.ok(turkish[key as keyof typeof turkish], key);
  }
});
