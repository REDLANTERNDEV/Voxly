import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaProfile } from "./network.mjs";
import { matrixReport } from "./matrix-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.VOICE_LAB_OUTPUT ?? "voice-lab-results/matrix");
const isolated = process.env.VOICE_LAB_ISOLATED === "1" && process.platform === "linux";
const profiles = (
  process.env.VOICE_LAB_PROFILES ?? (isolated ? "clean,burst-loss,delay-burst,sustained-loss" : "clean")
).split(",");
const routes = (process.env.VOICE_LAB_ROUTES ?? (isolated ? "direct,relay" : "direct")).split(",");
const trials = Number(process.env.VOICE_LAB_TRIALS ?? 3);
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 20);
assert.ok(routes.every((route) => ["direct", "relay"].includes(route)));
assert.ok(profiles.length && profiles.every((profile) => mediaProfile(profile)));
assert.ok(
  isolated || profiles.every((profile) => profile === "clean"),
  "UDP experiments require the isolated lab container"
);
await mkdir(output, { recursive: true });
const runs = [];
let child;
const stop = () => child?.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  for (const route of routes)
    for (const profile of profiles)
      for (const bufferTarget of [null, 40, 80]) {
        const cellOutput = join(output, `${route}-${profile}-${bufferTarget ?? "default"}`);
        child = spawn(process.execPath, ["scripts/voice-lab/run.mjs"], {
          cwd: root,
          stdio: "inherit",
          env: {
            ...process.env,
            VOICE_LAB_OUTPUT: cellOutput,
            VOICE_LAB_ROUTE: route,
            VOICE_LAB_NETWORK: profile,
            VOICE_LAB_BUFFER: bufferTarget === null ? "" : String(bufferTarget),
            VOICE_LAB_COMPARE_ONLY: "1",
            VOICE_LAB_CYCLES: "1",
            VOICE_LAB_STALLED_MEDIA: "0",
            VOICE_LAB_TRIALS: String(trials),
            VOICE_LAB_SECONDS: String(Math.max(9, mediaProfile(profile).minimumSeconds + 1))
          }
        });
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
        const summary = JSON.parse(await readFile(join(cellOutput, "summary.json"), "utf8"));
        runs.push({ route, profile, bufferTarget, summary });
        await writeFile(join(output, "matrix.json"), JSON.stringify(matrixReport(runs), null, 2));
        assert.equal(code, 0, "Matrix cell failed or had incomplete measurements; see its summary");
      }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
console.log(`Voice matrix: ${join(output, "matrix.json")}`);
