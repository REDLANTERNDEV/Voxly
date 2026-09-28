import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("theme contrast", () => {
  it("applies the monochrome reference palette in the final visual layer", () => {
    const styles = readFileSync("src/visual-refresh.css", "utf8");
    const explicitDark = [...styles.matchAll(/^:root\[data-theme="dark"\]\s*\{[\s\S]*?^\}/gm)]
      .map((match) => match[0])
      .find((block) => block.includes("--surface:")) ?? "";

    assert.match(explicitDark, /--bg:\s*#0b0d10/i);
    assert.match(explicitDark, /--surface:\s*#12161b/i);
    assert.match(explicitDark, /--rail-bg:\s*#101318/i);
    assert.match(explicitDark, /--accent:\s*#e1e8ef/i);
    assert.match(explicitDark, /--selected-fill:\s*#202730/i);
    assert.match(explicitDark, /--selected-border:\s*#394652/i);
    assert.match(explicitDark, /--success:\s*#35c98a/i);
    assert.match(explicitDark, /--danger:\s*#f0525b/i);
  });

  it("keeps one neutral visual layer without a later palette override", () => {
    const visual = readFileSync("src/visual-refresh.css", "utf8");
    const main = readFileSync("src/main.tsx", "utf8");

    assert.doesNotMatch(visual, /#(?:00d9c0|167fdb|3b82f6|80b6ff|315d95|172b48)\b/i);
    assert.match(main, /import "\.\/visual-refresh\.css"/);
    assert.doesNotMatch(main, /workspace-refresh\.css/);
    assert.equal([...visual.matchAll(/^:root\s*\{[^}]*--surface:/gm)].length, 1);
  });

  it("keeps semantic states separate from ordinary selection", () => {
    const styles = readFileSync("src/visual-refresh.css", "utf8");
    const explicitDark = [...styles.matchAll(/^:root\[data-theme="dark"\]\s*\{[\s\S]*?^\}/gm)]
      .map((match) => match[0])
      .find((block) => block.includes("--surface:")) ?? "";

    assert.match(explicitDark, /--accent:\s*#e1e8ef/i);
    assert.match(explicitDark, /--success:\s*#35c98a/i);
    assert.match(explicitDark, /--warn:\s*#e6a545/i);
    assert.match(explicitDark, /--danger:\s*#f0525b/i);
    assert.doesNotMatch(explicitDark, /--success:\s*var\(--accent\)/);
  });

  it("owns palette values in the visual layer without the former brown base", () => {
    const base = readFileSync("src/styles.css", "utf8");
    const visual = readFileSync("src/visual-refresh.css", "utf8");
    const lightTokens = visual.match(/^:root\s*\{[\s\S]*?^\}/m)?.[0] ?? "";

    assert.match(lightTokens, /--black:\s*#111317/i);
    assert.doesNotMatch(base, /--(?:bg|surface|rail-bg|accent|success|danger):/);
    assert.doesNotMatch(`${base}\n${visual}`, /#b7ad99/i);
  });

  it("keeps the light rail white with explicit readable foreground tokens", () => {
    const base = readFileSync("src/styles.css", "utf8");
    const visual = readFileSync("src/visual-refresh.css", "utf8");
    const lightTokens = [...visual.matchAll(/^:root\s*\{[\s\S]*?^\}/gm)]
      .map((match) => match[0])
      .find((block) => block.includes("--surface:")) ?? "";
    const rail = base.match(/^\.rail\s*\{[\s\S]*?^\}/m)?.[0] ?? "";

    assert.match(lightTokens, /--rail-bg:\s*#fff(?:fff)?/i);
    assert.match(lightTokens, /--rail-fg:\s*#111317/i);
    assert.match(lightTokens, /--rail-muted:\s*#5d6772/i);
    assert.match(lightTokens, /--accent:\s*#2b3036/i);
    assert.match(rail, /background:\s*var\(--rail-bg\)/);
    assert.match(rail, /color:\s*var\(--rail-fg\)/);
  });

  it("switches the rail to slate in explicit and automatic dark mode", () => {
    const styles = readFileSync("src/visual-refresh.css", "utf8");
    const explicitDark = styles.match(/^:root\[data-theme="dark"\]\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    const automaticDark = styles.match(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?^  \}/m)?.[0] ?? "";

    for (const tokens of [explicitDark, automaticDark]) {
      assert.match(tokens, /--bg:\s*#0b0d10/i);
      assert.match(tokens, /--rail-bg:\s*#101318/i);
      assert.match(tokens, /--rail-fg:\s*#e5e7eb/i);
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

  it("keeps final explicit dark and automatic dark tokens identical", () => {
    const styles = readFileSync("src/visual-refresh.css", "utf8");
    const explicitDark = [...styles.matchAll(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)^\}/gm)]
      .map((match) => match[1])
      .find((block) => block.includes("--surface:")) ?? "";
    const automaticDark = [...styles.matchAll(/:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)^  \}/gm)]
      .map((match) => match[1])
      .find((block) => block.includes("--surface:")) ?? "";
    const declarations = (block: string) => [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => `${match[1]}:${match[2].trim()}`);

    assert.notEqual(explicitDark, "");
    assert.notEqual(automaticDark, "");
    assert.deepEqual(declarations(automaticDark), declarations(explicitDark));
  });
});
