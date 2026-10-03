import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desktopSurfaceReady, startupSurface } from "../src/lib/startupSurface.js";

describe("startup surface", () => {
  it("reveals desktop only after session and protected-route bootstrap, while allowing recovery screens", () => {
    const state = { routeName: "text" as const, authState: "ready" as const, desktopLaunch: false, existingDesktopSession: false, authenticated: true, rtcConfigReady: true };
    assert.equal(desktopSurfaceReady(state), true);
    assert.equal(desktopSurfaceReady({ ...state, workspaceReady: false }), false);
    assert.equal(desktopSurfaceReady({ ...state, workspaceReady: false, workspaceError: true }), true);
    assert.equal(desktopSurfaceReady({ ...state, routeName: "landing", workspaceReady: false }), false);
    assert.equal(desktopSurfaceReady({ ...state, authState: "loading" }), false);
    assert.equal(desktopSurfaceReady({ ...state, rtcConfigReady: false }), false);
    assert.equal(desktopSurfaceReady({ ...state, authState: "error", rtcConfigReady: false }), true);
    assert.equal(desktopSurfaceReady({ ...state, routeName: "link-device", desktopLaunch: true, existingDesktopSession: true }), false);
    assert.equal(desktopSurfaceReady({ ...state, routeName: "link-device", desktopLaunch: true, authenticated: false, rtcConfigReady: false }), true);
  });
  it("defers the landing page while authentication is loading", () => {
    assert.equal(startupSurface("landing", "loading"), "entry-loading");
  });

  it("defers invite forms until authentication resolves", () => {
    assert.equal(startupSurface("invite", "loading"), "entry-loading");
  });

  it("uses the application shell skeleton for protected routes", () => {
    assert.equal(startupSurface("text", "loading"), "shell-skeleton");
    assert.equal(startupSurface("voice", "loading"), "shell-skeleton");
    assert.equal(startupSurface("owner", "loading"), "shell-skeleton");
  });

  it("waits for the desktop profile session before starting browser-initiated sign-in", () => {
    assert.equal(startupSurface("link-device", "loading", true), "shell-skeleton");
    assert.equal(startupSurface("link-device", "ready", true), "route");
    assert.equal(startupSurface("link-device", "loading", false), "entry-loading");
  });

  it("uses the resolved route after authentication completes", () => {
    assert.equal(startupSurface("text", "ready"), "route");
  });
});
