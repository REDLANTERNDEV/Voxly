import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("notification presentation", () => {
  const notifications = () => readFileSync("src/components/ui/Notifications.tsx", "utf8");
  const chrome = () => readFileSync("src/components/shell/AppChrome.tsx", "utf8");
  const css = () => readFileSync("src/styles.css", "utf8");

  it("renders dismissible grouped notifications outside the application layout", () => {
    assert.match(notifications(), /aria-label=\{t\("notification\.dismiss"\)\}/);
    assert.match(notifications(), /notification\.occurrences/);
    assert.match(chrome(), /<NotificationViewport/);
    assert.doesNotMatch(chrome(), /<Toast\b/);
    assert.match(css(), /\.notification-region\s*\{[\s\S]*position: fixed;/);
  });

  it("keeps modal-open notifications queued and moves them above the dock on phones", () => {
    assert.match(chrome(), /suspended=\{settingsOpen\}/);
    assert.match(css(), /\.notification-region\.is-suspended/);
    assert.match(css(), /@media \(max-width: 900px\)[\s\S]*\.notification-region\s*\{[\s\S]*bottom: calc\(var\(--dock\)/);
  });

  it("moves an actionable voice error into dismissible audio settings context", () => {
    const settings = readFileSync("src/components/shell/SettingsDialog.tsx", "utf8");
    const audio = readFileSync("src/components/AudioDeviceSettings.tsx", "utf8");
    const devices = readFileSync("src/components/DeviceSettings.tsx", "utf8");
    const recovery = readFileSync("src/components/RecoverySettings.tsx", "utf8");

    assert.match(chrome(), /openSettings\("audio", item\.messageKey\)/);
    assert.match(settings, /initialSection\?: SettingsSection/);
    assert.match(settings, /contextError=\{props\.contextError \? props\.t\(props\.contextError\) : ""\}/);
    assert.match(audio, /<InlineAlert/);
    assert.match(devices, /<InlineAlert[\s\S]*occurrences=\{errorOccurrence\?\.count\}/);
    assert.match(recovery, /<InlineAlert[\s\S]*occurrences=\{errorOccurrence\?\.count\}/);
    assert.match(notifications(), /occurrences > 1[\s\S]*className="notification-count"/);
  });
});
