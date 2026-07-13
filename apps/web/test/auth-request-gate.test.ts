import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthRequestGate } from "../src/lib/authRequestGate.js";

describe("authentication request gate", () => {
  it("invalidates an initial session lookup after a claim completes", () => {
    const gate = createAuthRequestGate();
    const initialSessionRequest = gate.begin();

    assert.equal(gate.isCurrent(initialSessionRequest), true);
    gate.invalidate();
    assert.equal(gate.isCurrent(initialSessionRequest), false);
  });

  it("keeps only the latest overlapping session lookup current", () => {
    const gate = createAuthRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    assert.equal(gate.isCurrent(first), false);
    assert.equal(gate.isCurrent(second), true);
  });
});
