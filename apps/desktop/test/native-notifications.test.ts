import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync("src-tauri/src/native-notifications.js", "utf8");
type Handle = { delivery: Promise<string>; close(): void; onclick: ((e: unknown) => void) | null; onclose: ((e: unknown) => void) | null; onfailure: (() => void) | null };
function boot(origin = "https://chat.example", top = true, send: Promise<string> = Promise.resolve("shown")) {
  const calls: unknown[][] = [];
  let receive: (event: unknown) => void = () => {};
  const window = {
    top: null as unknown, location: { origin }, crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
    __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => { calls.push(args); return args[0] === "show_desktop_notification" ? send : Promise.resolve(); } },
    addEventListener: (_: string, handler: (e: unknown) => void) => { receive = handler; },
    __VOXLY_DESKTOP_TOASTS_V1__: undefined as { version: 1; create(kind: string, language: string, ...args: unknown[]): Handle } | undefined
  };
  window.top = top ? window : {};
  runInNewContext(`${source}("https://chat.example");`, { window });
  return { window, calls, receive: (event: unknown) => receive(event) };
}
describe("finite native notification bridge", () => {
  it("sends only a generated id, finite kind and language, never caller content or routes", async () => {
    const f = boot();
    assert.equal(Object.isFrozen(f.window.__VOXLY_DESKTOP_TOASTS_V1__), true);
    const handle = f.window.__VOXLY_DESKTOP_TOASTS_V1__!.create("message", "tr", { body: "private", path: "/voice" });
    assert.equal(await handle.delivery, "shown");
    assert.equal(JSON.stringify(f.calls), JSON.stringify([["show_desktop_notification", { request: { id: "12345678123412341234123456789abc", kind: "message", language: "tr" } }]]));
    assert.throws(() => f.window.__VOXLY_DESKTOP_TOASTS_V1__!.create("unknown", "en"));
    assert.throws(() => f.window.__VOXLY_DESKTOP_TOASTS_V1__!.create("message", "de"));
  });
  it("does not install on other origins/subframes and rejects navigation away", () => {
    assert.equal(boot("https://evil.example").window.__VOXLY_DESKTOP_TOASTS_V1__, undefined);
    assert.equal(boot("https://chat.example", false).window.__VOXLY_DESKTOP_TOASTS_V1__, undefined);
    const f = boot(); f.window.location.origin = "https://evil.example";
    assert.throws(() => f.window.__VOXLY_DESKTOP_TOASTS_V1__!.create("message", "en"));
    assert.equal(f.calls.length, 0);
  });
  it("closes an eventual toast when cancelled during delivery and ignores retired events", async () => {
    let resolve!: (result: string) => void;
    const f = boot(undefined, undefined, new Promise((r) => { resolve = r; }));
    const handle = f.window.__VOXLY_DESKTOP_TOASTS_V1__!.create("message", "en");
    let clicks = 0; handle.onclick = () => { clicks++; };
    handle.close(); handle.close(); resolve("shown");
    await handle.delivery; await Promise.resolve();
    assert.equal(JSON.stringify(f.calls[1]), JSON.stringify(["close_desktop_notification", { id: "12345678123412341234123456789abc" }]));
    f.receive({ detail: { id: "12345678123412341234123456789abc", event: "click" } });
    assert.equal(clicks, 0); assert.equal(f.calls.length, 2);
  });
  it("contains native failures and ignores foreign ids and event types", async () => {
    const f = boot(undefined, undefined, Promise.reject(Error("unavailable")));
    const handle = f.window.__VOXLY_DESKTOP_TOASTS_V1__!.create("message", "en");
    assert.equal(await handle.delivery, "fallback");
    let clicks = 0; handle.onclick = () => { clicks++; };
    f.receive({ detail: { id: "foreign", event: "click" } });
    f.receive({ detail: { id: "12345678123412341234123456789abc", event: "quit_app" } });
    assert.equal(clicks, 0);
  });
});
