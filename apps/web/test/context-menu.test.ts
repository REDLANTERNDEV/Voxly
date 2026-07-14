import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampContextMenuPosition,
  contextMenuReducer,
  createContextMenuDescriptor
} from "../src/lib/contextMenu.js";

describe("context menu state", () => {
  it("replaces the previously open menu and closes to null", () => {
    const channel = createContextMenuDescriptor({
      key: "channel:a",
      x: 20,
      y: 30,
      menuWidth: 160,
      menuHeight: 48,
      viewportWidth: 1000,
      viewportHeight: 800,
      trigger: null
    });
    const member = createContextMenuDescriptor({
      key: "member:b",
      x: 40,
      y: 50,
      menuWidth: 220,
      menuHeight: 180,
      viewportWidth: 1000,
      viewportHeight: 800,
      trigger: null
    });

    const first = contextMenuReducer(null, { type: "open", menu: channel });
    const second = contextMenuReducer(first, { type: "open", menu: member });

    assert.equal(second?.key, "member:b");
    assert.equal(contextMenuReducer(second, { type: "close" }), null);
  });

  it("keeps overlay coordinates inside the viewport margin", () => {
    assert.deepEqual(
      clampContextMenuPosition({ x: 990, y: 790, menuWidth: 160, menuHeight: 96, viewportWidth: 1000, viewportHeight: 800 }),
      { x: 832, y: 696 }
    );
  });
});
