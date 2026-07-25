import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSteamGameOverlay } from "../src/lib/browserEnvironment.js";

describe("browser environment detection", () => {
  it("detects current and legacy Steam GameOverlay user agents", () => {
    assert.equal(isSteamGameOverlay("Mozilla/5.0 (Windows NT 10.0; Win64; x64; Valve Steam GameOverlay/default/1773426488) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"), true);
    assert.equal(isSteamGameOverlay("Mozilla/5.0 (Linux; U; X11; en-US; Valve Steam GameOverlay/1565656602; ) AppleWebKit/537.36 Chrome/72.0 Safari/537.36"), true);
    assert.equal(isSteamGameOverlay("mozilla/5.0 (valve steam gameoverlay/default/0)"), true);
  });

  it("does not block normal browsers or the regular Steam client", () => {
    assert.equal(isSteamGameOverlay("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"), false);
    assert.equal(isSteamGameOverlay("Mozilla/5.0 (Windows NT 10.0; Win64; x64; Valve Steam Client/default/1690583737) AppleWebKit/537.36"), false);
    assert.equal(isSteamGameOverlay(""), false);
  });
});
