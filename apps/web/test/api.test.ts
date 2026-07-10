import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { acceptInvite, ApiError, claimOwnerSession } from "../src/api.js";

const originalFetch = globalThis.fetch;

describe("frontend api", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shares concurrent owner claim requests for the same token", async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ user: { id: "u1", nickname: "Red", role: "owner", bannedAt: null } }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    };

    const [first, second] = await Promise.all([
      claimOwnerSession("claim-token"),
      claimOwnerSession("claim-token")
    ]);

    assert.equal(requests, 1);
    assert.deepEqual(first, second);
  });

  it("preserves Turnstile rejection codes for the invite form", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "turnstile_failed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });

    await assert.rejects(
      () => acceptInvite("invite-token", "Mert", "turnstile-token"),
      (error: unknown) => error instanceof ApiError && error.code === "turnstile_failed"
    );
  });
});
