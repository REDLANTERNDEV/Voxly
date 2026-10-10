import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { runInNewContext } from "node:vm";

it("syncs finite Voxly themes and OS changes, and refuses other origins", () => {
  const source = readFileSync("src-tauri/src/appearance.js", "utf8");
  const calls: Array<{ command: string; theme: string }> = [];
  const events = new Map<string, () => void>();
  let selected: string | null = "light";
  const system = { matches: true, addEventListener: (_: string, fn: () => void) => events.set("system", fn) };
  const contrast = { addEventListener: (_: string, fn: () => void) => events.set("contrast", fn) };
  const window = {
    top: null as unknown,
    location: { origin: "https://chat.example" },
    localStorage: { getItem: () => "auto" },
    matchMedia: (query: string) => (query.includes("prefers") ? system : contrast),
    addEventListener: (event: string, fn: () => void) => events.set(event, fn),
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: { theme: string }) => {
        calls.push({ command, theme: args.theme });
        return Promise.resolve();
      }
    }
  };
  window.top = window;
  const document = { documentElement: { getAttribute: () => selected }, addEventListener: () => {} };
  class MutationObserver {
    constructor(fn: () => void) {
      events.set("theme", fn);
    }
    observe() {}
  }
  runInNewContext(`${source}("https://chat.example");`, { window, document, MutationObserver });
  assert.deepEqual(calls, [{ command: "set_installation_theme", theme: "light" }]);
  selected = "dark";
  events.get("theme")!();
  selected = null;
  system.matches = false;
  events.get("system")!();
  events.get("contrast")!();
  assert.deepEqual(
    calls.map((c) => c.theme),
    ["light", "dark", "light", "light"]
  );
  window.location.origin = "https://evil.example";
  selected = "dark";
  events.get("theme")!();
  assert.equal(calls.length, 4);
});
