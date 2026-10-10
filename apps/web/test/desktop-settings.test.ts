import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import {
  desktopSettingsAvailable,
  desktopKeyboardBinding,
  desktopMouseBinding,
  rememberCompletedDesktopAuthentication,
  type DesktopSettingsBridge
} from "../src/lib/desktopSettings.js";
import {
  DesktopGeneralSettings,
  DesktopHomeButton,
  DesktopMicrophoneSettings,
  DesktopShortcutSettings
} from "../src/components/DesktopSettings.js";
import { translate } from "../src/lib/i18n.js";

describe("desktop-only settings", () => {
  it("shows no native controls in an ordinary browser", () => {
    assert.equal(desktopSettingsAvailable({}), false);
    for (const language of ["en", "tr"] as const) {
      const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
      assert.equal(renderToStaticMarkup(createElement(DesktopHomeButton, { t })), "");
      assert.equal(renderToStaticMarkup(createElement(DesktopMicrophoneSettings, { t, onShortcuts() {} })), "");
      assert.equal(renderToStaticMarkup(createElement(DesktopShortcutSettings, { t, onAudio() {} })), "");
    }
  });
  it("offers separate media recovery actions and disables them on older shells", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    try {
      for (const supported of [false, true]) {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: {
            __VOXLY_DESKTOP_SETTINGS_V1__: { version: 1, apply: async () => ({}) },
            ...(supported
              ? {
                  __VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__: {
                    version: 1,
                    resetMicrophone: async () => true,
                    resetCamera: async () => true
                  }
                }
              : {})
          }
        });
        for (const language of ["en", "tr"] as const) {
          const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
          const html = renderToStaticMarkup(createElement(DesktopMicrophoneSettings, { t, onShortcuts() {} }));
          assert.ok(html.includes(t("desktopSettings.microphoneReset")));
          assert.ok(html.includes(t("desktopSettings.cameraReset")));
          assert.equal(html.includes(t("desktopSettings.updateRequired")), !supported);
          const actions = html.split("desktop-permission-recovery")[1];
          assert.equal((actions.match(/disabled=""/g) ?? []).length, supported ? 0 : 2);
        }
      }
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  it("records physical modified shortcuts without accepting typing or repeats", () => {
    const key = { code: "KeyM", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false };
    assert.equal(desktopKeyboardBinding(key), "Control+Shift+KeyM");
    for (const [modifier, flag] of [
      ["Control", "ctrlKey"],
      ["Alt", "altKey"],
      ["Shift", "shiftKey"]
    ] as const) {
      for (const side of ["Left", "Right"]) {
        const event = {
          code: modifier + side,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          metaKey: false,
          repeat: false,
          [flag]: true
        };
        assert.equal(desktopKeyboardBinding(event), modifier);
        assert.equal(desktopKeyboardBinding({ ...event, repeat: true }), null);
      }
    }
    assert.equal(desktopKeyboardBinding({ ...key, shiftKey: false, code: "ControlLeft" }), "Control");
    assert.equal(desktopKeyboardBinding({ ...key, shiftKey: false, code: "ControlRight" }), "Control");
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
    const target = {
      __VOXLY_DESKTOP_SETTINGS_V1__: {
        version: 1,
        async apply(operation) {
          operations.push(operation);
          throw new Error("storage_failed");
        }
      } as DesktopSettingsBridge
    };
    for (const state of ["pending", "refused", "expired", "cancelled"])
      await rememberCompletedDesktopAuthentication(target, state, () => true);
    await rememberCompletedDesktopAuthentication(target, "approved", () => false);
    assert.deepEqual(operations, []);
    await rememberCompletedDesktopAuthentication(target, "approved", () => true);
    assert.deepEqual(operations, [{ kind: "authenticationCompleted" }]);
  });
});

describe("desktop settings presentation", () => {
  it("associates the close-window switch with its full translated title and description", () => {
    for (const language of ["en", "tr"] as const) {
      const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
      const html = renderToStaticMarkup(createElement(DesktopGeneralSettings, { t }));
      const labelId = html.match(/aria-labelledby="([^"]+)"/)?.[1];
      const descriptionId = html.match(/aria-describedby="([^"]+)"/)?.[1];
      assert.ok(labelId);
      assert.ok(descriptionId);
      assert.ok(html.includes(`id="${labelId}"`));
      assert.ok(html.includes(`id="${descriptionId}"`));
      assert.ok(html.includes(t("desktopSettings.quitOnClose")));
      assert.ok(html.includes(t("desktopSettings.quitOnCloseHint")));
      assert.match(html, /role="switch"\s+aria-checked="false"/);
      assert.match(html, /disabled=""/);
    }
  });
  it("keeps recording in one button and places audio links inside held-shortcut rows", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/DesktopSettings.tsx", "utf8");
    assert.doesNotMatch(source, /saveButton|desktopSettings\.save|DesktopPreferences/);
    assert.match(source, /desktopSettings\.stopRecording/);
    assert.match(source, /action\s+===\s+"pushToTalk"\s+\|\|\s+action\s+===\s+"pushToMute"/);
    assert.match(source, /kind:\s+"recording",\s+enabled:\s+false/);
    assert.match(source, /event\.key\s+===\s+"Escape"[\s\S]*?onRecording\(\s*null\s*\)/);
    const settings = readFileSync("src/components/shell/SettingsDialog.tsx", "utf8");
    assert.match(settings, /desktop\s+\?\s+\(?\s*\[\s*"general",\s+\.\.\.sections,\s+"shortcuts"\s*\]/);
    assert.match(settings, /section\s+===\s+"general"\s+&&\s+desktop/);
    assert.doesNotMatch(settings, /section\s+===\s+"desktop"/);
    assert.match(settings, /DesktopHomeButton/);
    assert.match(settings, /settings-nav-footer/);
    assert.match(settings, /section\s+===\s+"notifications"/);
  });
});
