import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("sidebar brand identity", () => {
  it("reserves the channel rail brand for the Voxly name", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelDeleteControl/)?.[0] ?? "";
    const brand = app.match(/function BrandLockup[\s\S]*?\n}\n\nfunction NavLink/)?.[0] ?? "";

    assert.match(rail, /<BrandLockup[^>]*subtitle=""/);
    assert.match(brand, /\{subtitle \? <span>\{subtitle\}<\/span> : null\}/);
  });
});
