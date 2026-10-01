import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { desktopSettingsAvailable, desktopKeyboardBinding, desktopMouseBinding, rememberCompletedDesktopAuthentication, type DesktopSettingsBridge } from "../src/lib/desktopSettings.js";
import { DesktopPreferences, DesktopMicrophoneSettings, DesktopShortcutSettings } from "../src/components/DesktopSettings.js";
import { translate } from "../src/lib/i18n.js";

describe("desktop-only settings", () => {
  it("shows no native controls in an ordinary browser", () => {
    assert.equal(desktopSettingsAvailable({}), false);
    for (const language of ["en", "tr"] as const) {
      const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
      assert.equal(renderToStaticMarkup(createElement(DesktopPreferences, { t })), "");
      assert.equal(renderToStaticMarkup(createElement(DesktopMicrophoneSettings, { t, onShortcuts() {} })), "");
      assert.equal(renderToStaticMarkup(createElement(DesktopShortcutSettings, { t, onAudio() {} })), "");
    }
  });
  it("records physical modified shortcuts without accepting typing or repeats", () => {
    const key = { code: "KeyM", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false };
    assert.equal(desktopKeyboardBinding(key), "Control+Shift+KeyM");
    assert.equal(desktopKeyboardBinding({ ...key, code: "KeyD" }), "Control+Shift+KeyD");
    assert.equal(desktopKeyboardBinding({ ...key, ctrlKey: false }), null);
    assert.equal(desktopKeyboardBinding({ ...key, repeat: true }), null);
    assert.equal(desktopKeyboardBinding({ ...key, code: "F25" }), null);
    const mouse = { button: 3, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    assert.equal(desktopMouseBinding(mouse), "Mouse4");
    assert.equal(desktopMouseBinding({ ...mouse, button: 4 }), "Mouse5");
    assert.equal(desktopMouseBinding({ ...mouse, button: 0 }), null);
  });
  it("only remembers successful current browser approval and tolerates local storage failure", async () => {
    const operations: unknown[] = [];
    const target = { __VOXLY_DESKTOP_SETTINGS_V1__: { version: 1, async apply(operation) { operations.push(operation); throw new Error("storage_failed"); } } as DesktopSettingsBridge };
    for (const state of ["pending", "refused", "expired", "cancelled"]) await rememberCompletedDesktopAuthentication(target, state, () => true);
    await rememberCompletedDesktopAuthentication(target, "approved", () => false);
    assert.deepEqual(operations, []);
    await rememberCompletedDesktopAuthentication(target, "approved", () => true);
    assert.deepEqual(operations, [{ kind: "authenticationCompleted" }]);
  });
});
