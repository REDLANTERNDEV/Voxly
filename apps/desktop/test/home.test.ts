import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { startupInstallation } from "../src/home.js";

test("startup opens only the selected default and yields to handoff, disabled startup, and active calls", () => {
  const first = { id: "first", origin: "https://first.example" };
  const last = { id: "last", origin: "https://last.example" };
  const state = { active: null, preferences: { installations: [first, last], defaultInstallationId: "last", openOnStartup: true } };
  assert.deepEqual(startupInstallation(state, null), last);
  assert.equal(startupInstallation(state, { origin: first.origin }), null);
  assert.equal(startupInstallation({ ...state, active: first }, null), null);
  assert.equal(startupInstallation({ ...state, preferences: { ...state.preferences, openOnStartup: false } }, null), null);
  assert.equal(startupInstallation({ ...state, preferences: { ...state.preferences, defaultInstallationId: "missing" } }, null), null);
});

test("settings bridge refuses subframes and origin changes and contains no updater/file command", async () => {
  const source = readFileSync("src-tauri/src/settings-bridge.js", "utf8");
  const calls: unknown[] = [];
  const window: any = { location: { origin: "https://chat.example" }, __TAURI_INTERNALS__: { invoke: async (command: string, arguments_: unknown) => { calls.push([command, arguments_]); return {}; } } };
  window.top = window;
  vm.runInNewContext(`${source}("https://chat.example");`, { window });
  await window.__VOXLY_DESKTOP_SETTINGS_V1__.apply({ kind: "home" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["desktop_settings", { operation: { kind: "home" } }]]);
  window.location.origin = "https://other.example";
  await assert.rejects(window.__VOXLY_DESKTOP_SETTINGS_V1__.apply({ kind: "home" }), /forbidden/);
  assert.equal(calls.length, 1);
  const frame: any = { location: { origin: "https://chat.example" }, top: {} };
  vm.runInNewContext(`${source}("https://chat.example");`, { window: frame });
  assert.equal(frame.__VOXLY_DESKTOP_SETTINGS_V1__, undefined);
  assert.doesNotMatch(source, /updater|filesystem|opener|shell_update/);
});

test("release packaging uses Program Files and explicit brand icons; diagnostics require a development entry", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  assert.equal(config.bundle.windows.nsis.installMode, "perMachine");
  for (const key of ["installerIcon", "uninstallerIcon"]) assert.equal(config.bundle.windows.nsis[key], "../branding/tauri/icons/icon.ico");
  const ui = readFileSync("src/main.ts", "utf8");
  assert.match(ui, /import.meta.env.DEV && new URLSearchParams\(location.search\).has\("diagnostics"\)/);
});
