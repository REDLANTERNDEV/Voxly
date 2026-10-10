import assert from "node:assert/strict";
import { test } from "node:test";
import { menuPosition } from "../src/popover.js";

test("installation menus prefer above, fall back below and remain in the scaled viewport", () => {
  assert.deepEqual(
    menuPosition({ top: 400, bottom: 444, right: 700 }, { width: 180, height: 144 }, { width: 800, height: 600 }),
    { left: 520, top: 250, maxHeight: 584 }
  );
  assert.equal(
    menuPosition({ top: 12, bottom: 56, right: 50 }, { width: 180, height: 144 }, { width: 320, height: 520 }).top,
    62
  );
  const clamped = menuPosition(
    { top: 20, bottom: 64, right: 330 },
    { width: 180, height: 800 },
    { width: 320, height: 520 }
  );
  assert.deepEqual(clamped, { left: 132, top: 8, maxHeight: 504 });
});
