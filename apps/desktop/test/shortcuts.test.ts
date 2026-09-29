import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { bindingFromKey, bindingFromMouse, bindingLabel, mountShortcutSettings } from "../src/shortcuts.js";

const key = { code: "KeyM", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, repeat: false };
const source = readFileSync("src-tauri/src/voice-bridge.js", "utf8");
interface Bridge { version: number; dispatchMute(): void; subscribeMute(handler: () => void): () => void }
function boot(origin = "https://chat.example", topFrame = true) {
  const window: { top?: unknown; location: { origin: string }; __VOXLY_DESKTOP_V1__?: Bridge } = { location: { origin } };
  window.top = topFrame ? window : {};
  runInNewContext(`${source}("https://chat.example");`, { window });
  return window;
}

describe("desktop shortcut registration and bridge", () => {
  it("records physical key combinations and avoids ordinary typing and repeat", () => {
    assert.equal(bindingFromKey(key), "Control+KeyM");
    assert.equal(bindingLabel("Control+Alt+KeyM"), "Ctrl + Alt + M");
    assert.equal(bindingLabel("Super+Digit9"), "Win + 9");
    assert.equal(bindingFromKey({ ...key, altKey: true, shiftKey: true, metaKey: true }), "Control+Alt+Shift+Super+KeyM");
    assert.equal(bindingFromKey({ ...key, ctrlKey: false, code: "F8" }), "F8");
    for (const event of [{ ...key, repeat: true }, { ...key, ctrlKey: false }, { ...key, ctrlKey: false, shiftKey: true }, { ...key, code: "ControlLeft" }, { ...key, code: "F25" }]) {
      assert.equal(bindingFromKey(event), null);
    }
  });

  it("records middle and side mouse buttons with optional modifiers", () => {
    const mouse = { button: 3, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    assert.equal(bindingFromMouse(mouse), "Mouse4");
    assert.equal(bindingFromMouse({ ...mouse, button: 1 }), "Mouse3");
    assert.equal(bindingFromMouse({ ...mouse, button: 4, ctrlKey: true, shiftKey: true }), "Control+Shift+Mouse5");
    assert.equal(bindingLabel("Control+Mouse4"), "Ctrl + Mouse 4");
    assert.equal(bindingLabel("Mouse5", "Fare"), "Fare 5");
    assert.equal(bindingFromMouse({ ...mouse, button: 0 }), null);
    assert.equal(bindingFromMouse({ ...mouse, button: 2 }), null);
  });

  it("captures a side button anywhere in the chooser and suppresses its navigation click", () => {
    class Element extends EventTarget {
      disabled = false;
      textContent = "";
      value = "";
      focused = false;
      focus() { this.focused = true; }
    }
    const elements = new Map(["mute-shortcut", "record-shortcut", "save-shortcut", "clear-shortcut", "shortcut-status"]
      .map((id) => [id, new Element()] as const));
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const window = new EventTarget();
    Object.assign(globalThis, { document: { getElementById: (id: string) => elements.get(id) }, window });
    try {
      const settings = mountShortcutSettings({ t: (key) => key === "mouseButton" ? "Mouse" : key, save: async () => {} });
      settings.render({ preferences: { muteShortcut: null }, registeredMuteShortcut: null, shortcutError: null }, true);
      elements.get("record-shortcut")!.dispatchEvent(new Event("click"));
      const sideButton = (type: string) => Object.assign(new Event(type, { cancelable: true }),
        { button: 3, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
      const down = sideButton("mousedown");
      window.dispatchEvent(down);
      assert.equal(down.defaultPrevented, true);
      assert.equal(elements.get("mute-shortcut")!.value, "Mouse 4");
      assert.equal(elements.get("save-shortcut")!.disabled, false);
      assert.equal(elements.get("save-shortcut")!.focused, true);
      const up = sideButton("mouseup");
      window.dispatchEvent(up);
      assert.equal(up.defaultPrevented, true);
      const click = sideButton("auxclick");
      window.dispatchEvent(click);
      assert.equal(click.defaultPrevented, true);
    } finally {
      Object.assign(globalThis, { document: previousDocument, window: previousWindow });
    }
  });

  it("bootstraps only in the selected origin and top frame", () => {
    assert.equal(boot("https://evil.example").__VOXLY_DESKTOP_V1__, undefined);
    assert.equal(boot("https://chat.example", false).__VOXLY_DESKTOP_V1__, undefined);
    const window = boot();
    assert.equal(window.__VOXLY_DESKTOP_V1__?.version, 1);
    assert.equal(Object.isFrozen(window.__VOXLY_DESKTOP_V1__), true);
    assert.equal(Object.getOwnPropertyDescriptor(window, "__VOXLY_DESKTOP_V1__")?.writable, false);
  });

  it("discards stale subscriptions and intent after an origin change", () => {
    const window = boot();
    const bridge = window.__VOXLY_DESKTOP_V1__!;
    let calls = 0;
    bridge.dispatchMute(); // An old web client has no receiver.
    const first = bridge.subscribeMute(() => assert.fail("stale receiver"));
    const second = bridge.subscribeMute(() => { calls += 1; });
    first(); bridge.dispatchMute();
    assert.equal(calls, 1);
    window.location.origin = "https://evil.example";
    bridge.dispatchMute();
    assert.equal(calls, 1);
    window.location.origin = "https://chat.example";
    second(); bridge.dispatchMute();
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(bridge).sort(), ["dispatchMute", "subscribeMute", "version"]);
  });
});
