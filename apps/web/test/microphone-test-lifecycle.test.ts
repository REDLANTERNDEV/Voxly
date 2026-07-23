import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { readAppSource } from "./app-source.js";

describe("microphone test lifecycle integration", () => {
  it("requires acknowledged deafen before monitoring in a voice room", () => {
    const app = readAppSource();
    const voice = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(app, /await voice\.setDeafened\(true\)/);
    assert.match(app, /await microphoneTest\.start\(\)/);
    assert.match(app, /shouldRestoreMicrophoneTestDeafen/);
    assert.match(voice, /const setDeafened = useCallback\(async \(deafened: boolean\)/);
    assert.match(voice, /setDeafened,/);
  });

  it("keeps the deafen control locked while microphone monitoring is active", () => {
    const app = readAppSource();

    assert.match(app, /enabled=\{props\.controls\.deafen\.enabled && !props\.microphoneTestActive && props\.socketState === "live"\}/);
  });
});
