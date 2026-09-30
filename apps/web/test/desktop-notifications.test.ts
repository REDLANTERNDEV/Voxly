import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDesktopNotificationDelivery, desktopNotificationPermission, isDesktopNotificationKind,
  readDesktopNotifications, requestDesktopNotificationPermission, writeDesktopNotifications,
  type DesktopNotificationRuntime, type SystemNotificationApi
} from "../src/lib/desktopNotifications.js";
import { DEFAULT_NOTIFICATION_SOUNDS } from "../src/lib/notificationSounds.js";
import { DesktopNotificationSettings } from "../src/components/DesktopNotificationSettings.js";
import { translate } from "../src/lib/i18n.js";

function fixture() {
  const delivered: Array<{ title: string; options: NotificationOptions }> = [];
  let requests = 0;
  class Api {
    static permission: NotificationPermission = "default";
    static async requestPermission() { requests++; return this.permission; }
    get silent() { return true; }
    constructor(title: string, options: NotificationOptions) { delivered.push({ title, options }); }
    close() {}
  }
  const runtime: DesktopNotificationRuntime = {
    Notification: Api, __VOXLY_DESKTOP_V1__: { version: 1, subscribeMute: () => () => {} }
  };
  return { runtime, Api, delivered, requests: () => requests };
}
const context = {
  userId: "account", enabled: true, focused: false, deafened: false,
  preferences: { ...DEFAULT_NOTIFICATION_SOUNDS }, language: "en" as const
};

describe("desktop system notifications", () => {
  it("defaults off and persists independently per account, handling corrupt and unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    assert.equal(readDesktopNotifications("a", storage), false);
    assert.equal(writeDesktopNotifications("a", true, storage), true);
    assert.equal(readDesktopNotifications("a", storage), true);
    assert.equal(readDesktopNotifications("b", storage), false);
    storage.setItem("voxly:desktop-notifications:v1:a", "{} ");
    assert.equal(readDesktopNotifications("a", storage), false);
    const blocked = { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } };
    assert.equal(readDesktopNotifications("a", blocked), false);
    assert.equal(writeDesktopNotifications("a", true, blocked), false);
  });

  it("requests permission only explicitly and requires a desktop runtime with silent delivery", async () => {
    const f = fixture();
    const send = createDesktopNotificationDelivery(f.runtime);
    assert.equal(send("message", context), false);
    assert.equal(f.requests(), 0);
    assert.equal(await requestDesktopNotificationPermission(f.runtime), "default");
    assert.equal(f.requests(), 1);
    f.Api.permission = "denied";
    assert.equal(await requestDesktopNotificationPermission(f.runtime), "denied");
    assert.equal(f.requests(), 1);
    assert.equal(desktopNotificationPermission({ Notification: f.Api }), "unavailable");
    f.runtime.Notification = { permission: "granted", prototype: {} } as SystemNotificationApi;
    assert.equal(desktopNotificationPermission(f.runtime), "unavailable");
  });

  it("follows the master/category preferences, deafen, focus, and opt-in even after permission was granted", () => {
    const f = fixture(); f.Api.permission = "granted";
    const send = createDesktopNotificationDelivery(f.runtime);
    for (const patch of [{ enabled: false }, { focused: true }, { deafened: true },
      { preferences: { ...DEFAULT_NOTIFICATION_SOUNDS, enabled: false } },
      { preferences: { ...DEFAULT_NOTIFICATION_SOUNDS, message: false } }]) {
      assert.equal(send("message", { ...context, ...patch }), false);
    }
    assert.equal(send("voicePeerJoin", { ...context, preferences: { ...DEFAULT_NOTIFICATION_SOUNDS, voice: false } }), false);
    assert.equal(send("connectionLost", { ...context, preferences: { ...DEFAULT_NOTIFICATION_SOUNDS, connection: false } }), false);
    assert.equal(f.delivered.length, 0);
    assert.equal(send("message", context), true);
  });

  it("delivers only generic localized text, coalesces bursts, and never requests an OS sound", () => {
    const f = fixture(); f.Api.permission = "granted";
    let time = 0;
    const send = createDesktopNotificationDelivery(f.runtime, () => time);
    assert.equal(send("message", context), true);
    assert.equal(send("message", context), false);
    time = 1000;
    assert.equal(send("message", { ...context, language: "tr" }), true);
    assert.deepEqual(f.delivered, [
      { title: "Voxly", options: { body: "You have a new message.", tag: "voxly:message", silent: true } },
      { title: "Voxly", options: { body: "Yeni bir mesajınız var.", tag: "voxly:message", silent: true } }
    ]);
    for (const key of ["mute", "unmute", "deafen", "undeafen", "voiceJoin", "voiceLeave"] as const) assert.equal(isDesktopNotificationKind(key), false);
  });

  it("fails safely when permission or notification creation fails", async () => {
    const f = fixture();
    f.Api.requestPermission = async () => { throw Error("runtime"); };
    assert.equal(await requestDesktopNotificationPermission(f.runtime), "unavailable");
    class Broken extends f.Api { constructor(title: string, options: NotificationOptions) { super(title, options); throw Error("runtime"); } }
    Broken.permission = "granted"; f.runtime.Notification = Broken;
    assert.equal(createDesktopNotificationDelivery(f.runtime)("message", context), false);
  });

  it("keeps ordinary browser settings free of desktop controls and connects delivery to the existing cue path", () => {
    assert.equal(renderToStaticMarkup(createElement(DesktopNotificationSettings, { userId: "a", t: (key) => translate("en", key) })), "");
    const hook = readFileSync("src/app/useNotificationSounds.ts", "utf8");
    assert.match(hook, /desktopDeliveryRef.current\(key/);
    assert.match(hook, /enabled: readDesktopNotifications\(user.id\), focused: windowFocused\(\)/);
    assert.match(hook, /return allowed \? play\("message"\) : false/);
    const settings = readFileSync("src/components/shell/SettingsDialog.tsx", "utf8");
    assert.match(settings, /<DesktopNotificationSettings key=\{props.user.id\}/);
  });
});
