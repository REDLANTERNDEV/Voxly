import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("theme contrast", () => {
  it("uses the onyx palette without the former brown base", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const lightTokens = styles.match(/^:root\s*\{[\s\S]*?^\}/m)?.[0] ?? "";

    assert.match(lightTokens, /--black:\s*#0a0a09/i);
    assert.doesNotMatch(styles, /#b7ad99/i);
  });

  it("keeps the light rail white with explicit readable foreground tokens", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const lightTokens = styles.match(/^:root\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    const rail = styles.match(/^\.rail\s*\{[\s\S]*?^\}/m)?.[0] ?? "";

    assert.match(lightTokens, /--rail-bg:\s*#fff(?:fff)?/i);
    assert.match(lightTokens, /--rail-fg:\s*var\(--black\)/);
    assert.match(lightTokens, /--rail-muted:\s*#[0-9a-f]{6}/i);
    assert.match(rail, /background:\s*var\(--rail-bg\)/);
    assert.match(rail, /color:\s*var\(--rail-fg\)/);
  });

  it("switches the rail to onyx in explicit and automatic dark mode", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const explicitDark = styles.match(/^:root\[data-theme="dark"\]\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    const automaticDark = styles.match(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?^  \}/m)?.[0] ?? "";

    for (const tokens of [explicitDark, automaticDark]) {
      assert.match(tokens, /--rail-bg:\s*var\(--black\)/);
      assert.match(tokens, /--rail-fg:\s*var\(--ivory\)/);
      assert.match(tokens, /--rail-muted:\s*#[0-9a-f]{6}/i);
    }
  });

  it("uses rail-specific colors for nested cards, fields, and member rows", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(styles, /\.rail \.session-card,[\s\S]*?background:\s*var\(--rail-surface\)/);
    assert.match(styles, /\.voice-channel-user\s*\{[^}]*color:\s*var\(--rail-muted\)/s);
    assert.match(styles, /\.audio-device-card\s*\{[^}]*background:\s*var\(--rail-surface\)[^}]*color:\s*var\(--rail-fg\)/s);
    assert.match(styles, /\.audio-device-popover\s*\{[^}]*background:\s*var\(--surface\)[^}]*color:\s*var\(--fg\)/s);
    assert.match(styles, /\.audio-device-popover \.input\s*\{[^}]*background:\s*var\(--bg\)[^}]*color:\s*var\(--fg\)/s);
  });

  it("keeps the settings dialog on the active surface palette", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const dialog = styles.match(/^\.settings-dialog\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    const navItem = styles.match(/^\.settings-nav-item\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    const activeNavItem = styles.match(/^\.settings-nav-item\[aria-current="true"\]\s*\{[\s\S]*?^\}/m)?.[0] ?? "";

    assert.match(dialog, /background:\s*var\(--surface\)/);
    assert.match(navItem, /color:\s*var\(--muted\)/);
    assert.match(activeNavItem, /background:\s*var\(--surface-2\)/);
    assert.match(activeNavItem, /color:\s*var\(--fg\)/);
    assert.doesNotMatch(styles, /var\(--text\)/);
  });

  it("keeps explicit dark and automatic dark tokens identical", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    const explicitDark = styles.match(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)^\}/m)?.[1] ?? "";
    const automaticDark = styles.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)^  \}/m)?.[1] ?? "";
    const declarations = (block: string) => [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => `${match[1]}:${match[2].trim()}`);

    assert.deepEqual(declarations(automaticDark), declarations(explicitDark));
  });
});
