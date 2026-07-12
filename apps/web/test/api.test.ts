import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { acceptInvite, ApiError, claimAccessLink, claimOwnerSession, deleteMessage, fetchRtcConfig, revokeInvite } from "../src/api.js";

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

  it("shares concurrent access claim requests for the same token", async () => {
    let requests = 0;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    globalThis.fetch = async () => {
      requests += 1;
      await fetchGate;
      return new Response(JSON.stringify({ user: { id: "u2", nickname: "Ece", role: "member", bannedAt: null } }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    };

    const first = claimAccessLink("access-token-concurrent");
    const second = claimAccessLink("access-token-concurrent");
    const sameRequest = first === second;
    releaseFetch();
    const results = await Promise.all([first, second]);

    assert.equal(sameRequest, true);
    assert.equal(requests, 1);
    assert.deepEqual(results[0], results[1]);
  });

  it("allows an access claim retry after a failed request", async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify({ error: "temporary_failure" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ user: { id: "u3", nickname: "Mert", role: "member", bannedAt: null } }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    };

    await assert.rejects(() => claimAccessLink("access-token-retry"), ApiError);
    const retried = await claimAccessLink("access-token-retry");

    assert.equal(requests, 2);
    assert.equal(retried.user.id, "u3");
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

  it("omits the JSON content type for an empty invite revoke request", async () => {
    let headers: HeadersInit | undefined;
    globalThis.fetch = async (_input, init) => {
      headers = init?.headers;
      return new Response(null, { status: 204 });
    };

    await revokeInvite("invite-id");

    assert.equal(new Headers(headers).has("Content-Type"), false);
  });

  it("omits the JSON content type for an empty message delete request", async () => {
    let headers: HeadersInit | undefined;
    globalThis.fetch = async (_input, init) => {
      headers = init?.headers;
      return new Response(null, { status: 204 });
    };

    await deleteMessage("general", "message-id");

    assert.equal(new Headers(headers).has("Content-Type"), false);
  });

  it("loads user-scoped RTC credentials from the authenticated endpoint", async () => {
    let requestedPath = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedPath = String(input);
      return new Response(JSON.stringify({ iceServers: [], expiresAt: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    await fetchRtcConfig();

    assert.equal(requestedPath, "/api/rtc/config");
  });
});
