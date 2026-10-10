import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthRequestGate } from "../src/lib/authRequestGate.js";
import { checkSessionAfterDisconnect } from "../src/lib/sessionCheck.js";

const unauthorized = new Error("401");
function fixture(lookup: () => Promise<unknown>) {
  const gate = createAuthRequestGate();
  const signedOut: unknown[] = [];
  return {
    gate,
    signedOut,
    check: () =>
      checkSessionAfterDisconnect({
        gate,
        lookup,
        isUnauthorized: (error) => error === unauthorized,
        signedOut: (error) => signedOut.push(error)
      })
  };
}

test("a fresh successful lookup overrides a delayed unauthorized lookup", async () => {
  let requests = 0;
  const state = fixture(async () => {
    if (++requests === 1) throw unauthorized;
    return {};
  });
  await state.check();
  assert.equal(requests, 2);
  assert.deepEqual(state.signedOut, []);
});

test("two current unauthorized lookups sign out once", async () => {
  const state = fixture(async () => {
    throw unauthorized;
  });
  await state.check();
  assert.deepEqual(state.signedOut, [unauthorized]);
});

for (const failure of [new TypeError("network failure"), new Error("503")]) {
  test(`a confirming ${failure.message} preserves authentication`, async () => {
    let requests = 0;
    const state = fixture(async () => {
      throw ++requests === 1 ? unauthorized : failure;
    });
    await state.check();
    assert.equal(requests, 2);
    assert.deepEqual(state.signedOut, []);
  });
}

for (const phase of [1, 2]) {
  test(`authentication completion or unmount invalidates lookup ${phase}`, async () => {
    let rejectLookup!: (error: unknown) => void;
    let requests = 0;
    const state = fixture(async () => {
      if (++requests < phase) throw unauthorized;
      return new Promise((_resolve, reject) => {
        rejectLookup = reject;
      });
    });
    const checking = state.check();
    await Promise.resolve();
    state.gate.invalidate();
    rejectLookup(unauthorized);
    await checking;
    assert.equal(requests, phase);
    assert.deepEqual(state.signedOut, []);
  });
}

test("an older overlapping check cannot undo a newer successful check", async () => {
  let rejectOld!: (error: unknown) => void;
  let requests = 0;
  const state = fixture(async () => {
    if (++requests === 1)
      return new Promise((_resolve, reject) => {
        rejectOld = reject;
      });
    return {};
  });
  const first = state.check();
  await state.check();
  rejectOld(unauthorized);
  await first;
  assert.equal(requests, 2);
  assert.deepEqual(state.signedOut, []);
});
