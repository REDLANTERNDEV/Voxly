import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";

function harness(origin = "https://chat.example", topFrame = true) {
  const window = new EventTarget() as EventTarget & Record<string, any>;
  const location = { origin, href: `${origin}/`, pathname: "/" };
  let documentTraversals = 0;
  let nativePushes = 0;
  let state: unknown = null;
  const replaceState = (next: unknown, _title: string, path?: string) => {
    if (path) {
      const url = new URL(path, location.href);
      if (url.origin !== location.origin) throw new Error("cross-origin navigation");
      Object.assign(location, { href: url.href, pathname: url.pathname });
    }
    state = structuredClone(next);
  };
  const history = {
    get state() { return state; }, replaceState,
    pushState: (...args: Parameters<typeof replaceState>) => { nativePushes++; replaceState(...args); },
    back: () => { documentTraversals++; }, forward: () => { documentTraversals++; },
    go: (_delta?: number) => { documentTraversals++; }
  };
  Object.assign(window, { location, history, top: topFrame ? window : {} });
  class PopStateEvent extends Event { state: unknown; constructor(type: string, options: { state: unknown }) { super(type); this.state = options.state; } }
  const sourcePath = "src-tauri/src/navigation.js";
  const source = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "(() => {})";
  runInNewContext(`${source}("https://chat.example");`, { window, URL, PopStateEvent });
  const mouse = (button: number) => {
    for (const type of ["mousedown", "mouseup", "auxclick"]) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperty(event, "button", { value: button });
      window.dispatchEvent(event);
      if (type === "mouseup" && !event.defaultPrevented) documentTraversals++;
    }
  };
  return { window, location, history, mouse, get documentTraversals() { return documentTraversals; }, get nativePushes() { return nativePushes; } };
}

describe("desktop page history", () => {
  it("records side-button shortcuts without navigating, even after recording ends before release", () => {
    const h = harness();
    h.history.pushState(null, "", "/app/server/s/text/a");
    h.history.pushState(null, "", "/app/server/s/text/b");
    h.window.__VOXLY_DESKTOP_SETTINGS_V1__ = { recording: true };
    const down = new Event("mousedown", { cancelable: true });
    Object.defineProperty(down, "button", { value: 3 });
    h.window.dispatchEvent(down);
    h.window.__VOXLY_DESKTOP_SETTINGS_V1__.recording = false;
    for (const type of ["mouseup", "auxclick"]) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperty(event, "button", { value: 3 });
      h.window.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    assert.equal(h.location.pathname, "/app/server/s/text/b");
    h.mouse(3);
    assert.equal(h.location.pathname, "/app/server/s/text/a");
  });

  it("changes viewed routes without document traversal at both boundaries", () => {
    const h = harness();
    const viewed: string[] = [];
    h.window.addEventListener("popstate", () => viewed.push(h.location.pathname));
    h.history.pushState(null, "", "/app/server/s/text/a");
    h.history.pushState(null, "", "/app/server/s/voice/call-a");
    h.history.pushState(null, "", "/app/server/s/voice/call-b");
    h.mouse(3);
    assert.equal(h.location.pathname, "/app/server/s/voice/call-a");
    h.mouse(3);
    for (let i = 0; i < 30; i++) h.mouse(3);
    assert.equal(h.location.pathname, "/app/server/s/text/a");
    h.mouse(4);
    h.mouse(4);
    for (let i = 0; i < 30; i++) h.mouse(4);
    assert.equal(h.location.pathname, "/app/server/s/voice/call-b");
    assert.equal(h.documentTraversals, 0, "history must never replace the live call document");
    assert.equal(h.nativePushes, 0, "native document history must not own desktop routes");
    assert.deepEqual(viewed, ["/app/server/s/voice/call-a", "/app/server/s/text/a", "/app/server/s/voice/call-a", "/app/server/s/voice/call-b"]);
  });

  it("discards forward pages after a new navigation and supports programmatic traversal", () => {
    const h = harness();
    h.history.pushState(null, "", "/app/server/s/text/a");
    h.history.pushState(null, "", "/app/server/s/text/b");
    h.history.back();
    h.history.pushState(null, "", "/app/server/s/text/c");
    h.history.forward();
    assert.equal(h.location.pathname, "/app/server/s/text/c");
    h.history.go(-100);
    assert.equal(h.location.pathname, "/app/server/s/text/c");
    h.history.back();
    assert.equal(h.location.pathname, "/app/server/s/text/a");
  });

  it("handles browser keys, clones history state, and preserves replaceState", () => {
    const h = harness();
    const state = { selected: "a" };
    h.history.pushState(state, "", "/app/server/s/text/a");
    state.selected = "changed";
    h.history.pushState(null, "", "/app/server/s/text/b");
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { code: "ArrowLeft", altKey: true });
    h.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.history.state, { selected: "a" });
    h.history.replaceState(null, "", "/app/server/s/text/replaced");
    h.history.forward();
    h.history.back();
    assert.equal(h.location.pathname, "/app/server/s/text/replaced");
  });

  it("does not install on other origins or subframes and rejects cross-origin entries", () => {
    for (const h of [harness("https://other.example"), harness("https://chat.example", false)]) {
      h.history.pushState(null, "", "/app/server/s/text/a");
      assert.equal(h.nativePushes, 1);
    }
    const h = harness();
    h.history.pushState(null, "", "/app/server/s/text/a");
    assert.throws(() => h.history.pushState(null, "", "https://other.example/"));
    h.history.back();
    assert.equal(h.location.pathname, "/app/server/s/text/a");
  });

  it("removes earlier authentication pages on entry to the authenticated app", () => {
    const h = harness();
    h.history.pushState(null, "", "/invite");
    h.history.pushState(null, "", "/recover");
    h.history.pushState(null, "", "/app/server/s/text/a");
    h.history.back();
    assert.equal(h.location.pathname, "/app/server/s/text/a");
    assert.equal(h.documentTraversals, 0);
  });
});
