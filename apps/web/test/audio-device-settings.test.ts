import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("audio device settings permission flow", () => {
  it("opens a portal popover without expanding the sidebar flow", () => {
    const source = readFileSync("src/components/AudioDeviceSettings.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(source, /createPortal\(/);
    assert.match(source, /role="dialog"/);
    assert.match(source, /closeButtonRef\.current\?\.focus\(\)/);
    assert.match(source, /props\.onOpen\(\)\.catch\(\(\) => undefined\)/);
    assert.doesNotMatch(source, /<details/);
    assert.match(styles, /\.audio-device-popover\s*\{[^}]*position:\s*fixed[^}]*max-height:/s);
  });

  it("offers general input, output, and microphone monitoring controls", () => {
    const source = readFileSync("src/components/AudioDeviceSettings.tsx", "utf8");

    assert.match(source, /value=\{props\.inputVolume\}/);
    assert.match(source, /value=\{props\.outputVolume\}/);
    assert.match(source, /props\.microphoneTestActive \? props\.labels\.stopTest : props\.labels\.startTest/);
    assert.match(source, /props\.onClose\(\)/);
  });

  it("exposes noise suppression as a switch that disables when unsupported", () => {
    const source = readFileSync("src/components/AudioDeviceSettings.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(source, /role="switch"/);
    assert.match(source, /aria-checked=\{props\.noiseSuppression\}/);
    // A hardcoded id would collide if the popover ever mounts more than once.
    assert.match(source, /const noiseSuppressionLabelId = useId\(\)/);
    assert.match(source, /aria-labelledby=\{noiseSuppressionLabelId\}/);
    assert.match(source, /disabled=\{!props\.noiseSuppressionSupported\}/);
    assert.match(source, /props\.onNoiseSuppressionChange\(!props\.noiseSuppression\)/);
    assert.match(source, /props\.noiseSuppressionSupported \? props\.labels\.noiseSuppressionHint : props\.labels\.noiseSuppressionUnsupported/);
    assert.match(styles, /\.audio-switch\s*\{/);
  });
});
