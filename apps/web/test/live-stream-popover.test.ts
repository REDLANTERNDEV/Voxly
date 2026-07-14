import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { LiveStreamPopover, liveStreamCardPosition } from "../src/components/LiveStreamPopover.js";

describe("LIVE stream hover card", () => {
  it("keeps the card open while the pointer crosses from trigger to card", () => {
    const component = readFileSync("src/components/LiveStreamPopover.tsx", "utf8");

    assert.match(component, /closeTimerRef/);
    assert.match(component, /const cancelScheduledClose/);
    assert.match(component, /const scheduleClose/);
    assert.match(component, /onMouseEnter=\{cancelScheduledClose\}/);
    assert.match(component, /onMouseLeave=\{scheduleClose\}/);
    assert.match(component, /window\.clearTimeout/);
  });

  it("renders LIVE as a filled red badge with white text", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const trigger = css.match(/\.voice-live-trigger \{[\s\S]*?\n}/)?.[0] ?? "";

    assert.match(trigger, /background:\s*var\(--danger\)/);
    assert.match(trigger, /color:\s*(?:white|#fff|var\(--on-danger\))/);
    assert.match(trigger, /border-radius:/);
    assert.match(trigger, /font-weight:\s*(?:6\d\d|7\d\d)/);
  });

  it("positions the compact card immediately beside the LIVE trigger", () => {
    assert.deepEqual(
      liveStreamCardPosition(
        { left: 100, right: 140, top: 80, height: 20 },
        { width: 500, height: 300 }
      ),
      { left: 148, top: 36 }
    );
  });

  it("renders an accessible one-click stream preview action", () => {
    const html = renderToStaticMarkup(createElement(LiveStreamPopover, {
      icon: createElement("span", null, "screen"),
      liveLabel: "LIVE",
      nickname: "Ada",
      watchAriaLabel: "Watch Ada's stream",
      watchLabel: "Watch stream",
      onWatch() {}
    }));

    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /Watch Ada&#x27;s stream/);
    assert.match(html, /Watch stream/);
    assert.match(html, /voice-live-card/);
  });
});
