import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("sidebar brand identity", () => {
  it("keeps a server name and invite in the header without a duplicate selector", () => {
    const app = readAppSource();
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelDeleteControl/)?.[0] ?? "";
    const brand = app.match(/function BrandLockup[\s\S]*?\n}\n\nfunction NavLink/)?.[0] ?? "";

    assert.doesNotMatch(rail, /<BrandLockup|<ServerSwitcher/);
    assert.match(rail, /className="rail-head"[\s\S]*?<strong className="rail-server-name"[\s\S]*?<InviteQuickAction/);
    assert.match(brand, /\{subtitle \? <span>\{subtitle\}<\/span> : null\}/);
  });
});
