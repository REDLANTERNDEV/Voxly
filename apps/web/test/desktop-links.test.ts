import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { desktopOpenLink } from "../src/lib/desktopLinks.js";
import { OpenInDesktop } from "../src/components/OpenInDesktop.js";
import { translate } from "../src/lib/i18n.js";

describe("Open in desktop links", () => {
  it("carries only a canonical origin, never the current page or authentication state", () => {
    assert.equal(desktopOpenLink("https://chat.example"), "voxly://open?origin=https%3A%2F%2Fchat.example");
    assert.equal(desktopOpenLink("http://localhost:3000"), "voxly://open?origin=http%3A%2F%2Flocalhost%3A3000");
    assert.equal(desktopOpenLink("http://[::1]:3000"), "voxly://open?origin=http%3A%2F%2F%5B%3A%3A1%5D%3A3000");
    for (const value of ["https://user:secret@chat.example", "https://chat.example/invite/secret", "https://chat.example?token=secret",
      "https://chat.example#token=secret", "https://chat.example/", "http://chat.example", "tauri://localhost",
      "https://tauri.localhost", "https://ipc.localhost", "javascript:alert(1)", "https://chat.example\n",
      "https:\\chat.example", "https://CHAT.example", "a".repeat(2049)]) {
      assert.equal(desktopOpenLink(value), null, value);
    }
    assert.equal(desktopOpenLink("https://chat.example", true), null);
  });

  it("renders keyboard-accessible localized links and hides them inside desktop", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    const target = { location: { origin: "https://chat.example", pathname: "/invite/private", hash: "#token=private" },
      __VOXLY_DESKTOP_V1__: undefined as { version: number } | undefined };
    Object.defineProperty(globalThis, "window", { configurable: true, value: target });
    try {
      for (const language of ["en", "tr"] as const) {
        const html = renderToStaticMarkup(createElement(OpenInDesktop, { t: (key) => translate(language, key) }));
        assert.ok(html.startsWith("<a "));
        assert.ok(html.includes(`href="${desktopOpenLink(target.location.origin)}"`));
        assert.ok(html.includes(translate(language, "desktop.open")));
        assert.ok(html.includes(translate(language, "desktop.openHint")));
        assert.ok(!html.includes("private"));
      }
      target.__VOXLY_DESKTOP_V1__ = { version: 1 };
      assert.equal(renderToStaticMarkup(createElement(OpenInDesktop, { t: (key) => translate("en", key) })), "");
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
