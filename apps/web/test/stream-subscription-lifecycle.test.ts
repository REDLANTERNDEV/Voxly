import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import ts from "typescript";

// Exercise the actual acknowledgement handlers with controlled late replies.
function action(path: string, name: string, dependencies: Record<string, unknown>) {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0].getText(file) : node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(expression);
  const compiled = ts.transpile(`const handler = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(dependencies), `${compiled}; return handler;`)(...Object.values(dependencies));
}

const target = { publisherUserId: "alex", kind: "screen" };
it("a late Watch acknowledgement cannot reopen presentation after Unwatch", async () => {
  let resolve!: (response: unknown) => void;
  const response = new Promise((yes) => { resolve = yes; });
  const selectionGeneration = { current: 1 };
  let focused = false;
  const update = action("src/features/voice/VoiceRoomScreen.tsx", "updateRemoteSelection", {
    selectionGeneration, props: { onSetVisualSubscriptions: () => response },
    setFocusedSourceKey: () => { focused = true; }, setStageStatus: () => undefined,
    visualTargetKey: () => "alex:screen"
  });
  const pending = update([target], "alex:screen");
  selectionGeneration.current += 1;
  resolve({ ok: true, targets: [target] });
  assert.equal(await pending, false); assert.equal(focused, false);
});

it("Unwatch wins over a delayed Watch acknowledgement in the media hook", async () => {
  const replies: ((response: unknown) => void)[] = [];
  const committed: unknown[] = [];
  const set = action("src/lib/useVoiceMedia.ts", "setVisualSubscriptions", {
    socket: {}, roomRef: { current: "room-a" }, visualSubscriptionRequest: { current: 0 },
    requestVisualSubscriptions: () => new Promise((resolve) => { replies.push(resolve); }),
    visualTargetsRef: { current: [] }, setVisualTargets: (targets: unknown) => committed.push(targets),
    persistVoiceResume: () => undefined
  });
  const watch = set([target]); const unwatch = set([]);
  replies[1]({ ok: true, targets: [] }); await unwatch;
  replies[0]({ ok: true, targets: [target] }); await watch;
  assert.deepEqual(committed, [[]]);
});
