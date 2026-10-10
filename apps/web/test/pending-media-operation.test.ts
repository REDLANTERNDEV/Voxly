import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPendingMediaOperation } from "../src/lib/pendingMediaOperation.js";
import { clientUpdateDisposition } from "../src/lib/useClientUpdate.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("pending media update guard", () => {
  it("guards permission and receive-only acknowledgement before a render", async () => {
    const changes: boolean[] = [];
    const gate = createPendingMediaOperation((pending) => changes.push(pending));
    const permission = deferred<void>();
    const acknowledgement = deferred<boolean>();
    const join = gate.run(async () => {
      await permission.promise;
      return acknowledgement.promise;
    });
    assert.equal(clientUpdateDisposition("old", "new", gate.isPending(), false), "defer");
    permission.resolve();
    await Promise.resolve();
    assert.equal(gate.isPending(), true);
    acknowledgement.resolve(true);
    assert.equal(await join, true);
    assert.equal(gate.isPending(), false);
    assert.deepEqual(changes, [true, false]);
    assert.equal(clientUpdateDisposition("old", "new", gate.isPending(), true), "defer");
    const receiveOnly = deferred<boolean>();
    const receiveOnlyJoin = gate.run(() => receiveOnly.promise);
    assert.equal(gate.isPending(), true);
    receiveOnly.resolve(false);
    await receiveOnlyJoin;
    assert.equal(gate.isPending(), false);
  });

  it("an older or cancelled completion cannot release a replacement", async () => {
    const gate = createPendingMediaOperation(() => {});
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const old = gate.run(() => first.promise);
    gate.cancel();
    assert.equal(gate.isPending(), false);
    const current = gate.run(() => second.promise);
    first.resolve(false);
    await old;
    assert.equal(gate.isPending(), true);
    second.resolve(true);
    await current;
    assert.equal(gate.isPending(), false);
  });

  it("releases the guard when an operation throws", async () => {
    const gate = createPendingMediaOperation(() => {});
    await assert.rejects(
      gate.run(async () => {
        throw new Error("denied");
      }),
      /denied/
    );
    assert.equal(gate.isPending(), false);
  });
});
