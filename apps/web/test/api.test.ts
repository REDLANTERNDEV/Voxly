import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { acceptInvite, ApiError, claimAccessLink, claimOwnerSession, createServerInvite, deleteMessage, deleteServer, deleteServerRoom, fetchRtcConfig, previewInvite, revokeInvite, updateServer, updateServerMemberNickname, updateVoiceModeration } from "../src/api.js";

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

  it("uses scoped DELETE requests for channels and servers", async () => {
    const requests: Array<{ method: string | undefined; path: string }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ method: init?.method, path: String(input) });
      return new Response(null, { status: 204 });
    };

    await deleteServerRoom("server id", "room/id");
    await deleteServer("server id");

    assert.deepEqual(requests, [
      { method: "DELETE", path: "/api/servers/server%20id/rooms/room%2Fid" },
      { method: "DELETE", path: "/api/servers/server%20id" }
    ]);
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

  it("updates a nickname through the scoped member endpoint", async () => {
    let request: { path: string; method?: string; body?: string } | null = null;
    globalThis.fetch = async (input, init) => {
      request = { path: String(input), method: init?.method, body: String(init?.body) };
      return new Response(JSON.stringify({
        user: { userId: "user/id", nickname: "Basement Ece", role: "member" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const response = await updateServerMemberNickname("server id", "user/id", "Basement Ece");

    assert.deepEqual(request, {
      path: "/api/servers/server%20id/members/user%2Fid/nickname",
      method: "PATCH",
      body: JSON.stringify({ nickname: "Basement Ece" })
    });
    assert.equal(response.user.nickname, "Basement Ece");
  });

  it("creates independently limited invites and updates voice moderation", async () => {
    const requests: Array<{ path: string; method?: string; body?: string }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ path: String(input), method: init?.method, body: String(init?.body) });
      return new Response(JSON.stringify({ moderation: { muted: true, deafened: false } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    await createServerInvite("server id", "Friends", 1440, 5);
    await updateVoiceModeration("server id", "user/id", { muted: true });

    assert.deepEqual(requests, [
      {
        path: "/api/servers/server%20id/invites",
        method: "POST",
        body: JSON.stringify({ label: "Friends", expiresInMinutes: 1440, maxUses: 5 })
      },
      {
        path: "/api/servers/server%20id/members/user%2Fid/voice-moderation",
        method: "PATCH",
        body: JSON.stringify({ muted: true })
      }
    ]);
  });

  it("previews an invite and renames its server through scoped endpoints", async () => {
    const requests: Array<{ path: string; method?: string; body?: string }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ path: String(input), method: init?.method, body: String(init?.body) });
      if (String(input) === "/api/invites/preview") {
        return new Response(JSON.stringify({ serverName: "Onyx Lounge" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ server: { id: "server id", name: "Onyx Lounge", role: "owner" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const preview = await previewInvite("invite token");
    const renamed = await updateServer("server id", "Onyx Lounge");

    assert.deepEqual(requests, [
      {
        path: "/api/invites/preview",
        method: "POST",
        body: JSON.stringify({ inviteToken: "invite token" })
      },
      {
        path: "/api/servers/server%20id",
        method: "PATCH",
        body: JSON.stringify({ name: "Onyx Lounge" })
      }
    ]);
    assert.equal(preview.serverName, "Onyx Lounge");
    assert.equal(renamed.server.name, "Onyx Lounge");
  });
});
