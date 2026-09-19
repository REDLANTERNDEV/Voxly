import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "node:test";
import { build } from "vite";

it("emits the microphone worklet at a hashed asset URL referenced by the bundle", async () => {
  const result = await build({
    logLevel: "silent",
    build: {
      write: false,
      sourcemap: false,
      rollupOptions: { input: resolve("src/lib/microphoneInput.ts"), preserveEntrySignatures: "strict" }
    }
  });
  assert.ok(!Array.isArray(result) && "output" in result);
  const asset = result.output.find((entry) => /^assets\/noise-suppressor\.worklet-[\w-]+\.js$/.test(entry.fileName));
  assert.ok(asset && asset.type === "asset", "the worklet must participate in Vite asset hashing");
  assert.equal(Buffer.from(asset.source).toString("utf8"), readFileSync("src/worklets/noise-suppressor.worklet.js", "utf8"));
  assert.ok(result.output.some((entry) => entry.type === "chunk" && entry.code.includes(asset.fileName)));
});
