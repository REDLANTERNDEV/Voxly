import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript";

/** Historical thresholds retained only to reproduce the pre-fix regression. */
export function legacyQualityRecovery(reading, expectingAudio) {
  return (
    reading.grade === "breaking" &&
    (reading.concealedMs >= 60 ||
      (expectingAudio && (reading.lossPercent >= 5 || reading.spedUpMs >= 60 || reading.slowedDownMs >= 60)))
  );
}

/** Observe production unchanged, or restore the historical policy in temporary assets. */
export function recoveryControllerSource(source, policy = "production") {
  assert.ok(["production", "legacy-degradation"].includes(policy), "Unknown recovery experiment policy");
  const parsed = ts.createSourceFile("voiceQualityController.ts", source, ts.ScriptTarget.Latest, true);
  const seams = [],
    stalledDeclarations = [],
    readingBranches = [],
    transitions = [],
    confirmations = [];
  const identifier = (node, name) => node && ts.isIdentifier(node) && node.text === name;
  const visit = (node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        identifier(call.expression.expression, "recovery") &&
        identifier(call.expression.name, "set") &&
        call.arguments.length === 2 &&
        identifier(call.arguments[0], "peer") &&
        ts.isPropertyAccessExpression(call.arguments[1]) &&
        identifier(call.arguments[1].expression, "transition") &&
        identifier(call.arguments[1].name, "state")
      )
        seams.push(node);
    }
    if (ts.isVariableDeclaration(node) && identifier(node.name, "stalled"))
      stalledDeclarations.push(node.parent.parent);
    if (ts.isIfStatement(node) && identifier(node.expression, "reading") && ts.isBlock(node.thenStatement))
      readingBranches.push(node.thenStatement);
    if (ts.isCallExpression(node) && identifier(node.expression, "updateVoiceRecoveryEligibility"))
      transitions.push(node);
    if (
      ts.isIfStatement(node) &&
      ts.isExpressionStatement(node.thenStatement) &&
      ts.isCallExpression(node.thenStatement.expression)
    ) {
      const target = node.thenStatement.expression.expression;
      if (
        ts.isPropertyAccessExpression(target) &&
        identifier(target.expression, "clearPeers") &&
        identifier(target.name, "push")
      )
        confirmations.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(seams.length, 1, "Recovery decision seam changed; update the lab experiment");
  const at = seams[0].getStart(parsed);
  const legacy = policy === "legacy-degradation";
  const edits = [
    {
      start: at,
      end: at,
      text: `window.voiceLab?.recoveryDecision(peer, {
      stalled, eligible: ${legacy ? "eligible" : "false"}, recover: transition.recover,
      expectingAudio: current.expectingAudio === true
    });
    `
    }
  ];
  if (legacy) {
    assert.deepEqual(
      [stalledDeclarations.length, readingBranches.length, transitions.length, confirmations.length],
      [1, 1, 1, 1],
      "Legacy recovery policy seam changed; update the lab experiment"
    );
    const eligibility = transitions[0].arguments[1];
    assert.ok(
      ts.isBinaryExpression(eligibility) &&
        eligibility.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        identifier(eligibility.right, "stalled"),
      "Production must retain stall-only recovery eligibility"
    );
    edits.push(
      {
        start: stalledDeclarations[0].getStart(parsed),
        end: stalledDeclarations[0].getStart(parsed),
        text: "let eligible = false;\n"
      },
      {
        start: readingBranches[0].getStart(parsed) + 1,
        end: readingBranches[0].getStart(parsed) + 1,
        text: "\neligible ||= legacyQualityRecovery(reading, expecting);\n"
      },
      { start: eligibility.right.getStart(parsed), end: eligibility.right.end, text: "(stalled || eligible)" },
      { start: confirmations[0].end, end: confirmations[0].end, text: ' && worst.grade === "clear"' },
      { start: 0, end: 0, text: `const legacyQualityRecovery = ${legacyQualityRecovery.toString()};\n` }
    );
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

export async function buildRecoveryExperiment(root, temporary, policy) {
  const { build } = await import("vite");
  const transformed = new Set();
  const outDir = join(temporary, "recovery-web");
  await build({
    root: join(root, "apps/web"),
    configFile: join(root, "apps/web/vite.config.ts"),
    envFile: false,
    logLevel: "warn",
    plugins: [
      {
        name: "voice-lab-recovery-experiment",
        enforce: "pre",
        transform(source, id) {
          const path = id.replaceAll("\\", "/");
          if (path.endsWith("/src/lib/voiceQualityController.ts")) {
            transformed.add("controller");
            return recoveryControllerSource(source, policy);
          }
        }
      }
    ],
    build: { outDir, emptyOutDir: true, sourcemap: false }
  });
  assert.deepEqual([...transformed], ["controller"], "Experiment did not reach the real controller");
  return outDir;
}
