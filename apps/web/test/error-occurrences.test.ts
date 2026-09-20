import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordErrorOccurrence } from "../src/lib/errorOccurrences.js";

describe("settings error occurrences", () => {
  it("counts a repeated failure as a new occurrence even after the UI retried", () => {
    const first = recordErrorOccurrence(null, "permission");
    const repeated = recordErrorOccurrence(first, "permission");

    assert.deepEqual(first, { key: "permission", count: 1, revision: 1 });
    assert.deepEqual(repeated, { key: "permission", count: 2, revision: 2 });
  });

  it("starts a new count when the failed action reports a different reason", () => {
    const permission = recordErrorOccurrence(null, "permission");
    const unavailable = recordErrorOccurrence(permission, "unavailable");

    assert.deepEqual(unavailable, { key: "unavailable", count: 1, revision: 2 });
  });
});
