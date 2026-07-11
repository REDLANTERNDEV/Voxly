import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startupSurface } from "../src/lib/startupSurface.js";

describe("startup surface", () => {
  it("renders the landing page while authentication is loading", () => {
    assert.equal(startupSurface("landing", "loading"), "route");
  });

  it("renders the invite page while authentication is loading", () => {
    assert.equal(startupSurface("invite", "loading"), "route");
  });

  it("uses the application shell skeleton for protected routes", () => {
    assert.equal(startupSurface("text", "loading"), "shell-skeleton");
    assert.equal(startupSurface("voice", "loading"), "shell-skeleton");
    assert.equal(startupSurface("owner", "loading"), "shell-skeleton");
  });

  it("uses the resolved route after authentication completes", () => {
    assert.equal(startupSurface("text", "ready"), "route");
  });
});
