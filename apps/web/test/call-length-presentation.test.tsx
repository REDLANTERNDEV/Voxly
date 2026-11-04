import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CallLength } from "../src/components/shell/CallLength.js";
import { translate } from "../src/lib/i18n.js";

function render(language: "en" | "tr", elapsedMs: number) {
  return renderToStaticMarkup(
    <CallLength startedAt={performance.now() - elapsedMs} t={(key, values) => translate(language, key, values)} />
  );
}

it("shows the ticking digits to sight only, and names the room link in whole minutes", () => {
  const html = render("en", 247_500);
  assert.match(html, /<span class="channel-call-length" aria-hidden="true">4:07<\/span>/);
  assert.match(html, /<span class="sr-only">, Call running, 4 minutes<\/span>/);
});

it("says the same in Turkish, as Görüşme rather than arama", () => {
  assert.match(render("tr", 247_500), /Görüşme sürüyor, 4 dakika/);
  assert.match(render("tr", 20_000), /Görüşme sürüyor, bir dakikadan az/);
});

it("does not say minutes for one minute", () => {
  assert.match(render("en", 61_000), /Call running, 1 minute</);
  assert.match(render("en", 20_000), /Call running, under a minute</);
});

it("draws a running Call in the success green, in fixed-width digits", () => {
  const css = readFileSync("src/visual-refresh.css", "utf8");
  const rule = css.match(
    /\.rail \.channel-item \.channel-prefix\.is-calling,\s*\.rail \.channel-call-length \{[^}]*\}/
  )?.[0];
  assert.ok(rule, "the glyph and the length share one colour rule");
  assert.match(rule, /color: var\(--success\)/);
  assert.match(css, /\.rail \.channel-call-length \{[^}]*font-variant-numeric: tabular-nums/);
});

it("marks only a room whose Call is running, and never a Listed one the viewer cannot enter", () => {
  const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
  assert.match(rail, /const\s+callStart\s*=\s*props\.callStarts\[room\.id\]/);
  assert.match(rail, /const\s+showCallLength\s*=\s*callStart\s*!==\s*undefined\s*&&\s*room\.canEnter;/);
  assert.match(rail, /showCallLength\s*\?\s*<CallLength\s+startedAt=\{callStart\}/);
});

it("asks for every room again after leaving voice, so the rail keeps other rooms' Calls", () => {
  const hook = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
  const leave = hook.match(/const\s+leave\s*=\s*useCallback\([\s\S]*?\n {2}\}, \[/)?.[0] ?? "";
  const left = leave.indexOf('socket.emit("voice:leave"');
  const cleared = leave.indexOf("setCallStarts({})");
  const asked = leave.search(
    /for\s*\(const\s+roomId\s+of\s+voiceRoomIdsRef\.current\)\s*socket\.emit\("voice:snapshot"/
  );
  assert.ok(left >= 0 && cleared > left && asked > cleared, "leave, clear, then ask again");
});
