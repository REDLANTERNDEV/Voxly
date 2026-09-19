import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const webAssets = [
  "public/brand/svg/voxly-logo-horizontal-dark.svg",
  "public/brand/svg/voxly-logo-horizontal-light.svg",
  "public/brand/svg/voxly-logo-stacked-dark.svg",
  "public/brand/svg/voxly-logo-stacked-light.svg",
  "public/brand/svg/voxly-mark-monochrome-dark.svg",
  "public/brand/svg/voxly-mark-monochrome-light.svg",
  "public/brand/svg/voxly-mark-primary.svg",
  "public/brand/svg/voxly-wordmark-dark.svg",
  "public/brand/svg/voxly-wordmark-light.svg",
  "public/brand/web/apple-touch-icon.png",
  "public/brand/web/favicon.ico",
  "public/brand/web/voxly-og-light-1200x630.png",
  "public/brand/pwa/voxly-pwa-icon-192x192.png",
  "public/brand/pwa/voxly-pwa-icon-512x512.png",
  "public/brand/pwa/voxly-pwa-icon-maskable-192x192.png",
  "public/brand/pwa/voxly-pwa-icon-maskable-512x512.png",
];

describe("brand asset hierarchy", () => {
  it("keeps all browser entry-point assets in the canonical directories", () => {
    for (const asset of webAssets) {
      assert.equal(existsSync(asset), true, asset);
    }

    const html = readFileSync("index.html", "utf8");
    assert.match(html, /brand\/web\/favicon\.ico/);
    assert.match(html, /brand\/web\/voxly-favicon-32x32\.png/);
    assert.match(html, /brand\/svg\/voxly-mark-primary\.svg/);
    assert.match(html, /brand\/web\/voxly-og-light-1200x630\.png/);

    const manifest = readFileSync("public/manifest.webmanifest", "utf8");
    assert.match(manifest, /brand\/pwa\/voxly-pwa-icon-maskable-512x512\.png/);
  });

  it("keeps the future Tauri bundle inputs available outside the web public tree", () => {
    assert.equal(existsSync("../desktop/branding/tauri/icons/icon.ico"), true);
    assert.equal(existsSync("../desktop/branding/tauri/icons/icon.icns"), true);
    assert.equal(existsSync("../desktop/branding/tauri/source/icon-manifest.json"), true);
  });
});
