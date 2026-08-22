import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionHolder } from "../src/credentials.js";
import { fetchIceServers, type FetchJson } from "../src/voxly.js";

const environment = { serverUrl: "http://127.0.0.1:3000", token: "a-bot-token-that-is-long-enough" };

function session(serverId: string, token: string) {
  return { serverId, userId: `user-${serverId}`, nickname: "Music", token, expiresAt: "2026-01-01T01:00:00.000Z" };
}

function fetchDouble(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; cookie: string }> = [];
  const fetchImpl: FetchJson = async (url, init) => {
    calls.push({ url, cookie: init.headers.cookie ?? "" });
    const next = responses[calls.length - 1] ?? responses.at(-1)!;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body ?? {} };
  };
  return { fetchImpl, calls };
}

describe("reading the RTC configuration", () => {
  it("presents the session as the cookie the server named", async () => {
    const { fetchImpl, calls } = fetchDouble([{ status: 200, body: { iceServers: [{ urls: "stun:example.test" }] } }]);

    const servers = await fetchIceServers({
      serverUrl: environment.serverUrl,
      cookieName: "voxly_session",
      sessionToken: "token-one",
      fetchImpl
    });

    assert.deepEqual(servers, [{ urls: "stun:example.test" }]);
    assert.equal(calls[0].url, "http://127.0.0.1:3000/api/rtc/config");
    assert.equal(calls[0].cookie, "voxly_session=token-one");
  });

  it("answers with no servers rather than a shape nobody can use", async () => {
    for (const body of [{}, { iceServers: null }, "not an object"]) {
      const { fetchImpl } = fetchDouble([{ status: 200, body }]);
      assert.deepEqual(
        await fetchIceServers({ serverUrl: environment.serverUrl, cookieName: "c", sessionToken: "t", fetchImpl }),
        []
      );
    }
  });

  it("re-authenticates once when the session has expired underneath it", async () => {
    // A socket is authorized at its handshake and never again, so it outlives
    // the hour its session lasts. Without this, every Set after that hour would
    // silently run with no TURN.
    const holder = createSessionHolder(environment, session("one", "stale"), async () => ({
      cookieName: "voxly_session",
      sessions: [session("one", "fresh")]
    }));
    const { fetchImpl, calls } = fetchDouble([
      { status: 401 },
      { status: 200, body: { iceServers: [{ urls: "turn:example.test", username: "u", credential: "c" }] } }
    ]);

    const servers = await fetchIceServers({
      serverUrl: environment.serverUrl,
      cookieName: "voxly_session",
      sessionToken: holder.token,
      refreshSession: () => holder.refresh(),
      fetchImpl
    });

    assert.equal(servers.length, 1);
    assert.deepEqual(calls.map((call) => call.cookie), ["voxly_session=stale", "voxly_session=fresh"]);
    assert.equal(holder.token, "fresh");
  });

  it("does not retry a refusal that a fresh session would not fix", async () => {
    let refreshes = 0;
    const { fetchImpl, calls } = fetchDouble([{ status: 500 }]);

    await assert.rejects(fetchIceServers({
      serverUrl: environment.serverUrl,
      cookieName: "voxly_session",
      sessionToken: "token-one",
      refreshSession: async () => { refreshes += 1; return "fresh"; },
      fetchImpl
    }), /failed with 500/);

    assert.equal(refreshes, 0);
    assert.equal(calls.length, 1);
  });

  it("reports the status and never the body, which may carry a credential", async () => {
    const { fetchImpl } = fetchDouble([{ status: 403, body: { token: "a-secret-that-must-not-be-logged" } }]);

    await assert.rejects(
      fetchIceServers({ serverUrl: environment.serverUrl, cookieName: "c", sessionToken: "t", fetchImpl }),
      (error: Error) => error.message === "GET /api/rtc/config failed with 403"
    );
  });
});

describe("replacing a session without reconnecting", () => {
  it("hands back the token for this account, not another server's", async () => {
    const holder = createSessionHolder(environment, session("two", "stale"), async () => ({
      cookieName: "voxly_session",
      sessions: [session("one", "one-fresh"), session("two", "two-fresh")]
    }));

    assert.equal(await holder.refresh(), "two-fresh");
    assert.equal(holder.token, "two-fresh");
  });

  it("says so when the account has gone rather than presenting somebody else's", async () => {
    const holder = createSessionHolder(environment, session("two", "stale"), async () => ({
      cookieName: "voxly_session",
      sessions: [session("one", "one-fresh")]
    }));

    await assert.rejects(holder.refresh(), /no longer has a Music bot account for server two/);
    assert.equal(holder.token, "stale");
  });
});
