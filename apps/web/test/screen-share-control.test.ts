import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("screen share control", () => {
  it("uses the supplied monitor upload geometry inline", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");
    const icon = app.match(/function ScreenIcon[\s\S]*?\n}/)?.[0] ?? "";

    assert.match(icon, /viewBox="0 0 256 256"/);
    assert.match(icon, /className="ui-icon screen-icon"/);
    assert.match(styles, /\.screen-icon\s*\{[^}]*stroke-width:\s*18/s);
    assert.match(icon, /x="32" y="48" width="192" height="144" rx="16"/);
    assert.match(icon, /points="104 112 128 88 152 112"/);
    assert.match(icon, /x1="128" y1="88" x2="128" y2="152"/);
  });

  it("keeps every compact media control visually symmetric", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    assert.doesNotMatch(app, /className="screen-share-control"/);
    assert.match(styles, /\.dock-controls \.control-icon\s*\{[^}]*height:\s*44px[^}]*width:\s*44px/s);
    assert.match(styles, /\.dock-controls \.control-icon \.ui-icon\s*\{[^}]*height:\s*24px[^}]*width:\s*24px/s);
    assert.doesNotMatch(styles, /\.dock-controls \.screen-share-control/);
  });

  it("shows the cancellation stroke only while the local share is active", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const dock = app.match(/function VoiceDock[\s\S]*?\n}\n\nfunction ConfirmDialog/)?.[0] ?? "";

    assert.match(dock, /<ScreenIcon off=\{props\.controls\.screenShare\.on\} \/>/);
    assert.doesNotMatch(dock, /<ScreenIcon off=\{!props\.controls\.screenShare\.on\} \/>/);
  });
});
