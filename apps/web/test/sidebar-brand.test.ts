import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("sidebar brand identity", () => {
  it("reserves the channel rail brand for the Voxly name", () => {
    const app = readAppSource();
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelDeleteControl/)?.[0] ?? "";
    const brand = app.match(/function BrandLockup[\s\S]*?\n}\n\nfunction NavLink/)?.[0] ?? "";

    assert.match(rail, /<BrandLockup[^>]*subtitle=""/);
    assert.match(brand, /\{subtitle \? <span>\{subtitle\}<\/span> : null\}/);
  });
});
