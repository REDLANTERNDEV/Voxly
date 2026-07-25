import assert from "node:assert/strict";
import { existsSync,readFileSync } from "node:fs";
import { describe,it } from "node:test";

describe("browser compatibility gate", () => {
  it("blocks Steam GameOverlay before mounting the application", () => {
    const gatePath = "src/components/BrowserCompatibilityGate.tsx";
    assert.equal(existsSync(gatePath), true);
    if (!existsSync(gatePath)) return;

    const gate = readFileSync(gatePath, "utf8");
    const main = readFileSync("src/main.tsx", "utf8");

    assert.match(gate, /isSteamGameOverlay\(userAgent\)/);
    assert.match(gate, /<SteamOverlayWarning/);
    assert.match(gate, /return children/);
    assert.match(main, /<BrowserCompatibilityGate userAgent=\{navigator\.userAgent\}>[\s\S]*?<App \/>[\s\S]*?<\/BrowserCompatibilityGate>/);
  });

  it("renders a localized non-dismissible warning", () => {
    const gatePath = "src/components/BrowserCompatibilityGate.tsx";
    assert.equal(existsSync(gatePath), true);
    if (!existsSync(gatePath)) return;

    const gate = readFileSync(gatePath, "utf8");
    assert.match(gate, /browser\.steamOverlayTitle/);
    assert.match(gate, /browser\.steamOverlayCopy/);
    assert.match(gate, /<LanguageSwitch/);
    assert.doesNotMatch(gate, /onDismiss|onContinue|sessionStorage/);
  });
});
