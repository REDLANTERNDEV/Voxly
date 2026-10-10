import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { startupInstallation } from "../src/home.js";

test("startup opens only the selected default and yields to handoff, disabled startup, and active calls", () => {
  const first = { id: "first", origin: "https://first.example" };
  const last = { id: "last", origin: "https://last.example" };
  const state = {
    active: null,
    preferences: { installations: [first, last], defaultInstallationId: "last", openOnStartup: true }
  };
  assert.deepEqual(startupInstallation(state, null), last);
  assert.equal(startupInstallation(state, { origin: first.origin }), null);
  assert.equal(startupInstallation({ ...state, active: first }, null), null);
  assert.equal(
    startupInstallation({ ...state, preferences: { ...state.preferences, openOnStartup: false } }, null),
    null
  );
  assert.equal(
    startupInstallation({ ...state, preferences: { ...state.preferences, defaultInstallationId: "missing" } }, null),
    null
  );
});

test("settings bridge refuses subframes and origin changes and contains no updater/file command", async () => {
  const source = readFileSync("src-tauri/src/settings-bridge.js", "utf8");
  const calls: unknown[] = [];
  const window: any = {
    location: { origin: "https://chat.example" },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, arguments_: unknown) => {
        calls.push([command, arguments_]);
        return {};
      }
    }
  };
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
  assert.equal(config.bundle.windows.nsis.installerIcon, "../branding/tauri/icons/setup-package.ico");
  assert.equal(config.bundle.windows.nsis.uninstallerIcon, "../branding/tauri/icons/setup-dark.ico");
  assert.equal(config.bundle.windows.nsis.installerHooks, "windows/installer-hooks.nsh");
  assert.match(readFileSync("src-tauri/windows/installer-hooks.nsh", "utf8"), /MUI_CUSTOMFUNCTION_GUIINIT/);
  const ui = readFileSync("src/main.ts", "utf8");
  assert.match(ui, /import.meta.env.DEV && new URLSearchParams\(location.search\).has\("diagnostics"\)/);
});

test("startup reveals only ready installation windows, supports cancellation, and keeps Quit last in the tray", () => {
  const platform = readFileSync("src-tauri/src/platform.rs", "utf8");
  assert.match(platform, /\.visible\(false\)/);
  assert.match(platform, /\.background_color\(/);
  const settings = readFileSync("src-tauri/src/shell/settings.rs", "utf8");
  assert.match(settings, /inner\.loading_attempt != shell\.launch_sequence\.load/);
  assert.match(settings, /!shell\.home_requested\.load/);
  const native = readFileSync("src-tauri/src/shell/installation.rs", "utf8");
  const cancel = native.split("async fn cancel_connection")[1].split("#[tauri::command]")[0];
  assert.ok(cancel.indexOf("launch_sequence.fetch_add") < cancel.indexOf("shell.inner.lock().await"));
  assert.match(cancel, /if inner\.loading/);
  const tray = readFileSync("src-tauri/src/shell/tray.rs", "utf8");
  assert.match(tray, /\[&show, &installations, &update, &separator, &quit\]/);
  assert.match(tray, /"update" => check_from_tray\(app\)/);
  assert.doesNotMatch(tray, /CARGO_PKG_VERSION|Update and restart/);
  const update = readFileSync("src-tauri/src/shell/update_commands.rs", "utf8");
  const check = update.split("fn check_from_tray")[1].split("fn tray_check_needed")[0];
  assert.match(check, /check_requested\(&app\)\.await/);
  assert.match(check, /request\.begin_pending\(\)/);
  assert.match(update, /Err\("update_busy"\) => Ok\(updates\.snapshot\(\)\)/);
  assert.match(readFileSync("src/main.ts", "utf8"), /take_tray_update_check/);
  assert.doesNotMatch(check, /install_shell_update|confirmed|destroy/);
});

test("startup includes a decorative circular indicator and honors reduced motion", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /<body class="is-loading">/);
  assert.match(html, /class="startup-indicator" aria-hidden="true"/);
  assert.match(html, /class="startup-spinner"/);
  assert.match(html, /id="loading-status" role="status" aria-live="polite"/);
  const styles = readFileSync("src/home.css", "utf8");
  assert.match(styles, /\.startup-spinner\s*\{[^}]*animation: startup-spinner-spin 0\.9s linear infinite/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.startup-spinner\s*\{\s*animation: none/);
});
