import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("screen share control", () => {
  it("uses the supplied monitor upload geometry inline", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");
    const icon = app.match(/function\s+ScreenIcon[\s\S]*?\n}/)?.[0] ?? "";

    assert.match(icon, /viewBox="0\s+0\s+256\s+256"/);
    assert.match(icon, /className="ui-icon\s+screen-icon"/);
    assert.match(styles, /\.screen-icon\s*\{[^}]*stroke-width:\s*18/s);
    assert.match(icon, /x="32"\s+y="48"\s+width="192"\s+height="144"\s+rx="16"/);
    assert.match(icon, /points="104\s+112\s+128\s+88\s+152\s+112"/);
    assert.match(icon, /x1="128"\s+y1="88"\s+x2="128"\s+y2="152"/);
  });

  it("keeps every compact media control visually symmetric", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");
    const visual = readFileSync("src/visual-refresh.css", "utf8");

    assert.doesNotMatch(app, /className="screen-share-control"/);
    assert.match(styles, /\.dock-controls\s+\.control-icon\s*\{[^}]*height:\s*44px[^}]*width:\s*44px/s);
    assert.match(styles, /\.dock-controls\s+\.control-icon\s+\.ui-icon\s*\{[^}]*height:\s*24px[^}]*width:\s*24px/s);
    assert.match(visual, /\.dock-controls\s+\.control-icon\s*\{[^}]*height:\s*44px;[^}]*width:\s*44px;/s);
    assert.match(
      visual,
      /@media\s+\(max-width:\s+900px\)\s+\{[\s\S]*?\.dock-controls\s+\.control-icon\s+\{\s+height:\s+40px;\s+min-height:\s+40px;\s+width:\s+40px;\s+\}/
    );
    assert.doesNotMatch(styles, /\.dock-controls\s+\.screen-share-control/);
  });

  it("shows the cancellation stroke only while the local share is active", () => {
    const app = readAppSource();
    const dock = app.match(/function\s+VoiceDock[\s\S]*?\n}\n\nfunction\s+ConfirmDialog/)?.[0] ?? "";

    assert.match(dock, /<ScreenIcon\s+off=\{props\.controls\.screenShare\.on\}\s+\/>/);
    assert.doesNotMatch(dock, /<ScreenIcon\s+off=\{!props\.controls\.screenShare\.on\}\s+\/>/);
  });
});
