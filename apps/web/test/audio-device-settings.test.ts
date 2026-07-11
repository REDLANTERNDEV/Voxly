import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("audio device settings permission flow", () => {
  it("refreshes named devices when the settings panel is opened", () => {
    const source = readFileSync("src/components/AudioDeviceSettings.tsx", "utf8");

    assert.match(source, /onToggle=\{\(event\) => \{[\s\S]*event\.currentTarget\.open[\s\S]*props\.onOpen\(\)\.catch\(\(\) => undefined\)/);
  });
});
