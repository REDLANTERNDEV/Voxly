import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { LiveStreamPopover, liveStreamCardPosition } from "../src/components/LiveStreamPopover.js";

describe("LIVE stream hover card", () => {
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
