import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("landing presentation", () => {
  it("uses restrained social metadata without generated banner copy", () => {
    const html = readFileSync("index.html", "utf8");

    assert.match(html, /twitter:card" content="summary"/);
    assert.match(html, /brand\/logo-512x512\.png/);
    assert.doesNotMatch(html, /og-image\.png|twitter-card\.png/);
    assert.doesNotMatch(html, /Quiet by default|Centered V mark|Turquoise live signal/);
    assert.equal(existsSync("public/brand/og-image.png"), false);
    assert.equal(existsSync("public/brand/twitter-card.png"), false);
  });

  it("keeps the landing page as one hero and one principle row", () => {
    const appSource = readAppSource();

    assert.match(appSource, /className="landing-principles"/);
    assert.doesNotMatch(appSource, /landing-points|landing-point|reveal-block/);
  });

  it("shows the Voxly wordmark in the repository readme", () => {
    const readme = readFileSync("../../README.md", "utf8");

    assert.match(readme, /apps\/web\/public\/brand\/logo-wordmark\.svg/);
  });
});
