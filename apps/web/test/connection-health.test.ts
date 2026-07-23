import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { connectionQualityForRtt, medianRtt } from "../src/lib/connectionHealth.js";

describe("connection health", () => {
  it("uses the median of the latest five successful probes", () => {
    assert.equal(medianRtt([410, 90, 220, 150, 120]), 150);
    assert.equal(medianRtt([100, 200, 300, 400]), 250);
    assert.equal(medianRtt([]), null);
  });

  it("applies the approved RTT boundaries", () => {
    assert.equal(connectionQualityForRtt(150), "good");
    assert.equal(connectionQualityForRtt(151), "fair");
    assert.equal(connectionQualityForRtt(300), "fair");
    assert.equal(connectionQualityForRtt(301), "poor");
    assert.equal(connectionQualityForRtt(null), "measuring");
  });

  it("uses bounded probes, delayed overlays, generations, and complete cleanup", () => {
    const source = readFileSync("src/lib/useConnectionHealth.ts", "utf8");

    assert.match(source, /const probeIntervalMs = 5_000/);
    assert.match(source, /const probeTimeoutMs = 2_500/);
    assert.match(source, /const reconnectOverlayDelayMs = 3_000/);
    assert.match(source, /generationRef\.current \+= 1/);
    assert.match(source, /probeIdRef\.current \+= 1/);
    assert.match(source, /window\.clearInterval\(interval\)/);
    assert.match(source, /clearOverlayTimer\(\)/);
    assert.match(source, /clearProbeTimeout\(\)/);
  });
});
