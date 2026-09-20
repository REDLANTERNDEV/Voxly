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
  "public/brand/web/favicon-dark.svg",
  "public/brand/web/favicon-light.svg",
  "public/brand/web/favicon.svg",
  "public/brand/web/favicon.ico",
  "public/brand/web/og-image-1200x630.png",
  "public/brand/web/voxly-mark-192x192.png",
  "public/brand/web/voxly-mark-512x512.png",
  "public/brand/pwa/icon-primary-192x192.png",
  "public/brand/pwa/icon-primary-512x512.png",
  "public/brand/pwa/icon-512x512.png",
  "public/brand/pwa/icon-maskable-192x192.png",
  "public/brand/pwa/icon-maskable-512x512.png",
];

describe("brand asset hierarchy", () => {
  it("keeps all browser entry-point assets in the canonical directories", () => {
    for (const asset of webAssets) {
      assert.equal(existsSync(asset), true, asset);
    }

    const html = readFileSync("index.html", "utf8");
    assert.match(html, /brand\/web\/favicon-dark\.svg/);
    assert.match(html, /brand\/web\/favicon-light\.svg/);
    assert.match(html, /brand\/web\/favicon\.ico/);
    assert.match(html, /brand\/web\/favicon-32x32\.png/);
    assert.match(html, /manifest\.webmanifest/);
    assert.match(html, /brand\/web\/og-image-1200x630\.png/);
    assert.match(html, /<meta name="color-scheme" content="light dark" \/>/);
    assert.match(html, /<meta name="theme-color" content="#0B0F14" \/>/);

    const manifest = readFileSync("public/manifest.webmanifest", "utf8");
    assert.match(manifest, /brand\/pwa\/icon-primary-512x512\.png/);
    assert.match(manifest, /brand\/pwa\/icon-maskable-512x512\.png/);
    assert.match(manifest, /"background_color": "#FBFBFA"/);
    assert.match(manifest, /"theme_color": "#0B0F14"/);
    assert.match(manifest, /"display": "standalone"/);

    const canonical = readFileSync("public/brand/svg/voxly-mark-canonical.svg", "utf8");
    assert.equal((canonical.match(/id="voice-bar-/g) ?? []).length, 5);

    const favicon = readFileSync("public/brand/web/favicon.svg", "utf8");
    assert.match(favicon, /viewBox="40 40 440 440"/);

    const navigation = readFileSync("src/components/ui/Navigation.tsx", "utf8");
    assert.match(navigation, /brand-mark-image-on-light/);
    assert.match(navigation, /brand-mark-image-on-dark/);

    const styles = readFileSync("src/styles.css", "utf8");
    assert.match(styles, /\.brand-mark \{[\s\S]*background: var\(--rail-bg\);/);
    assert.match(styles, /brand-mark-image-on-dark/);
  });

  it("keeps the future Tauri bundle inputs available outside the web public tree", () => {
    assert.equal(existsSync("../desktop/branding/tauri/icons/icon.ico"), true);
    assert.equal(existsSync("../desktop/branding/tauri/icons/icon.icns"), true);
    assert.equal(existsSync("../desktop/branding/tauri/source/app-icon-monochrome.png"), true);
    assert.equal(existsSync("../desktop/branding/tauri/tauri.conf.json"), true);
  });
});
