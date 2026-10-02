import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stageClickAction,stageTileSelection } from "../src/features/voice/stageTileSelection.js";

const camera = { key: "alex:camera", target: { publisherUserId: "alex", kind: "camera" as const } };
const screen = { key: "mina:screen", target: { publisherUserId: "mina", kind: "screen" as const } };
const local = { key: "self:camera", target: null };

describe("stage tile selection", () => {
  it("retains watched screen reception while a camera opens, closes, or switches to local preview", () => {
    for (const source of [camera, local]) {
      const opened = stageTileSelection(new Set([screen.key]), source, [screen.target]);
      assert.ok(opened.targets.includes(screen.target));
      assert.deepEqual(stageTileSelection(new Set([screen.key, source.key]), source, [screen.target]).targets, [screen.target]);
    }
  });
  it("opens a camera and switches to a different live source without accumulating sources", () => {
    assert.deepEqual(stageTileSelection(new Set(), camera), { localKeys: [], targets: [camera.target], focusKey: camera.key });
    assert.deepEqual(stageTileSelection(new Set([camera.key]), screen), { localKeys: [], targets: [screen.target], focusKey: screen.key });
  });
  it("returns to the default stage when the selected tile is clicked again", () => {
    assert.deepEqual(stageTileSelection(new Set([screen.key]), screen), { localKeys: [], targets: [], focusKey: null });
    assert.deepEqual(stageTileSelection(new Set([local.key]), local), { localKeys: [], targets: [], focusKey: null });
  });
  it("clears remote subscriptions when switching to a local preview and clears local previews when switching back", () => {
    assert.deepEqual(stageTileSelection(new Set([screen.key]), local), { localKeys: [local.key], targets: [], focusKey: local.key });
    assert.deepEqual(stageTileSelection(new Set([local.key]), camera), { localKeys: [], targets: [camera.target], focusKey: camera.key });
  });
});

const stageSource = readFileSync(new URL("../../src/features/voice/VoicePresentation.tsx", import.meta.url), "utf8");
it("dismisses the focused stage through the same source toggle without covering volume or fullscreen controls", () => {
  assert.equal(stageClickAction(true, true), "exit-fullscreen");
  assert.equal(stageClickAction(true, false), "exit-fullscreen");
  assert.equal(stageClickAction(false, true), "dismiss");
  assert.equal(stageClickAction(false, false), "focus");
  assert.match(stageSource, /stageClickAction\(document.fullscreenElement === stageRef.current/);
  assert.match(stageSource, /onClick=\{toggleFullscreen\}/);
});
