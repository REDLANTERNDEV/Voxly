import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { NotificationSoundSettings } from "../src/components/NotificationSoundSettings.js";
import { WorkspaceRail } from "../src/components/shell/WorkspaceRail.js";
import { AppRoutes } from "../src/app/AppRoutes.js";
import { translate } from "../src/lib/i18n.js";

describe("desktop UX polish", () => {
  it("renders recovery rather than a permanent skeleton when protected startup fails", () => {
    const html = renderToStaticMarkup(createElement(AppRoutes, {
      route: { name: "text", serverId: "fixture", roomId: "fixture" },
      user: { id: "fixture", nickname: "Mira", role: "member", bannedAt: null },
      authState: "error", rtcConfigReady: false, shellProps: null, messages: [],
      language: "en", timeFormat: "auto", t: (key, values) => translate("en", key, values),
      renderSurface: (surface) => surface, turnstileSiteKey: null, analytics: null, signedOutReason: "",
      completeAuthentication() {}, async loadAcceptedServer() {}, onOwnerClaimed() {}, onAccessClaimed() {},
      navigate() {}, changeLanguage() {}, textRoomOutbox: [], textRoomActions: null
    }));
    assert.doesNotMatch(html, /shell-skeleton/);
    assert.ok(html.includes(translate("en", "system.couldNotStart")));
  });
  it("keeps sound controls available in both languages and hides categories when disabled", () => {
    for (const language of ["en", "tr"] as const) {
      const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
      const preferences = { enabled: true, volume: 70, voice: true, message: true, connection: true };
      const enabled = renderToStaticMarkup(createElement(NotificationSoundSettings, { t, preferences, onChange() {} }));
      const disabled = renderToStaticMarkup(createElement(NotificationSoundSettings, { t, preferences: { ...preferences, enabled: false }, onChange() {} }));
      assert.equal((enabled.match(/role="switch"/g) ?? []).length, 4);
      assert.equal((disabled.match(/role="switch"/g) ?? []).length, 1);
      assert.match(enabled, /type="range"/);
      assert.doesNotMatch(disabled, /type="range"/);
      assert.ok(enabled.includes(t("audio.notificationMessage")));
    }
  });
  it("offers GitHub downloads only outside the desktop app", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    const target = { __VOXLY_DESKTOP_V1__: undefined as { version: number } | undefined };
    Object.defineProperty(globalThis, "window", { configurable: true, value: target });
    const props = { activeServerId: "", servers: [], rooms: { text: [], voice: [] }, roomHistory: {}, t: (key: Parameters<typeof translate>[1]) => translate("en", key), onNavigate() {}, async onSelectServer() {}, onOpenSettings() {}, onCloseDrawer() {} };
    try {
      const html = renderToStaticMarkup(createElement(WorkspaceRail, props));
      assert.match(html, /href="https:\/\/github.com\/REDLANTERNDEV\/Voxly\/releases"/);
      assert.match(html, /rel="noopener noreferrer"/);
      assert.match(html, /aria-label="Download desktop"/);
      target.__VOXLY_DESKTOP_V1__ = { version: 1 };
      assert.doesNotMatch(renderToStaticMarkup(createElement(WorkspaceRail, props)), /workspace-download/);
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  it("keeps approval in a modal dialog and readiness outside authentication bootstrap", () => {
    const modal = readFileSync("src/components/DesktopLaunchDialog.tsx", "utf8");
    assert.match(modal, /showModal\(\)/);
    assert.match(modal, /returnFocus\?\.focus\(\)/);
    assert.match(modal, /onCancel=\{\(event\) => \{ event\.preventDefault\(\)/);
    const auth = readFileSync("src/features/auth/DesktopBrowserSignIn.tsx", "utf8");
    assert.match(auth, /revision\.current !== requestRevision \|\| current\.current !== request/);
    assert.match(auth, /request\.expiresInSeconds \* 1000/);
    const composer = readFileSync("src/features/chat/TextRoomScreen.tsx", "utf8");
    assert.match(composer, /<footer className="composer" onMouseDown/);
    assert.match(composer, /event\.target === event\.currentTarget \|\| .*tagName === "FORM"/);
    assert.match(composer, /event\.preventDefault\(\); composerRef\.current\?\.focus\(\)/);
  });
});
