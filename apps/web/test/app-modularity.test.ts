import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("web application module boundaries", () => {
  it("keeps App as a small composition root", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const lines = source.split("\n").length;

    assert.ok(lines <= 300, `App.tsx has ${lines} lines; expected at most 300`);
    assert.doesNotMatch(source, /function (LandingPage|TextRoomScreen|VoiceRoomScreen|OwnerPanel|AppChrome)\b/);
    assert.doesNotMatch(source, /interface ShellProps\b/);
  });

  it("keeps feature and shell surfaces in their owning modules", () => {
    for (const path of [
      "src/features/auth/AuthScreens.tsx",
      "src/features/chat/TextRoomScreen.tsx",
      "src/features/voice/VoiceRoomScreen.tsx",
      "src/features/owner/OwnerPanel.tsx",
      "src/components/shell/AppChrome.tsx"
    ]) {
      assert.equal(existsSync(path), true, `${path} must exist`);
    }
  });

  it("does not pass the complete shell contract into feature screens", () => {
    const source = readFileSync("src/app/AppRoutes.tsx", "utf8");

    assert.doesNotMatch(source, /<(?:OwnerPanel|TextRoomScreen|VoiceRoomScreen)\s+\{\.\.\.shellProps\}/);
  });

  it("uses grouped shell contracts instead of the former ShellProps type", () => {
    const source = readFileSync("src/app/types.ts", "utf8");

    assert.doesNotMatch(source, /export type ShellProps\b/);
    assert.match(source, /export interface ShellModel\b/);
    assert.match(source, /export interface ShellActions\b/);
    assert.match(source, /export interface VoiceChromeModel\b/);
  });

  it("keeps one-use claim handlers stable across route renders", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const routes = readFileSync("src/app/AppRoutes.tsx", "utf8");

    assert.match(app, /const handleOwnerClaimed = useCallback/);
    assert.match(app, /const handleAccessClaimed = useCallback/);
    assert.match(routes, /onClaimed=\{onOwnerClaimed\}/);
    assert.match(routes, /onClaimed=\{onAccessClaimed\}/);
  });

  it("keeps route refs synchronous and feature presentation imports acyclic", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const workspace = readFileSync("src/app/useWorkspaceController.ts", "utf8");
    const voicePresentation = readFileSync("src/features/voice/VoicePresentation.tsx", "utf8");

    assert.match(app, /const routeRef = useRef\(route\)/);
    assert.match(app, /routeRef\.current = nextRoute;\s*setRoute\(nextRoute\)/);
    assert.match(workspace, /routeRef: RefObject<Route>/);
    assert.doesNotMatch(voicePresentation, /from "\.\/VoiceRoomScreen\.js"/);
  });
});
