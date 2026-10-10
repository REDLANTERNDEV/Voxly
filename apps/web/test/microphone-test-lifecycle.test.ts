import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { readAppSource } from "./app-source.js";

describe("microphone test lifecycle integration", () => {
  it("requires acknowledged deafen before monitoring in a voice room", () => {
    const app = readAppSource();
    const voice = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(app, /await\s+voice\.setDeafened\(\s*true\s*\)/);
    assert.match(app, /await\s+microphoneTest\.start\(\s*\s*\)/);
    assert.match(app, /shouldRestoreMicrophoneTestDeafen/);
    assert.match(voice, /const\s+setDeafened\s+=\s+useCallback\(\s*async\s+\(\s*deafened:\s+boolean\s*\)/);
    assert.match(voice, /setDeafened,/);
  });

  it("keeps the deafen control locked while microphone monitoring is active", () => {
    const app = readAppSource();

    assert.match(
      app,
      /enabled=\{\s*props\.controls\.deafen\.enabled\s+&&\s+!props\.microphoneTestActive\s+&&\s+props\.socketState\s+===\s+"live"\s*\}/
    );
  });

  it("stops microphone monitoring whenever the settings window closes", () => {
    const chrome = readFileSync("src/components/shell/AppChrome.tsx", "utf8");

    assert.match(
      chrome,
      /const\s+closeSettings\s+=\s+useCallback\(\s*\(\s*\s*\)\s+=>\s*\s+\{\s*[\s\S]*?props\.onCloseAudioSettings\(\s*\s*\);[\s\S]*?setSettingsOpen\(\s*false\s*\);[\s\S]*?\s*\},\s+\[props\.onCloseAudioSettings\]\s*\)/
    );
    assert.match(
      chrome,
      /<SettingsDialog\s+\{\s*\.\.\.props\s*\}\s+initialSection=\{\s*settingsSection\s*\}\s+contextError=\{\s*settingsContextError\s*\}\s+onClose=\{\s*closeSettings\s*\}\s+\/>\s*/
    );
  });
});
