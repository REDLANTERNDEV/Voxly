import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("voice stage layout", () => {
  it("keeps stage, sources, and participants in one natural scrolling flow", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const roomRule = styles.match(/\.voice-control-room\s*\{[^}]+\}/)?.[0] ?? "";

    assert.match(roomRule, /grid-auto-rows:\s*max-content/);
    assert.match(roomRule, /overflow-y:\s*auto/);
    assert.match(styles, /\.screen-stage\s*\{[\s\S]*?block-size:\s*clamp\(220px,\s*58dvh,\s*640px\)/);
    assert.doesNotMatch(styles, /\.visual-source-rail\s*\{[^}]*overflow(?:-y)?:\s*auto/);
    assert.doesNotMatch(styles, /\.voice-participants\s*\{[^}]*overflow(?:-y)?:\s*auto/);
  });
});
