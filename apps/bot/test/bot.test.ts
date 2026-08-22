import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveBotEnvironment } from "../src/config.js";
import { parseBotCredentials, requestBotCredentials, type BotSession, type FetchLike } from "../src/credentials.js";
import { createMusicBotPresence, retryDelayMs, type BotSocket } from "../src/presence.js";

const environment = { serverUrl: "http://127.0.0.1:3000", token: "a-bot-token-that-is-long-enough" };

function session(serverId: string): BotSession {
  return {
    serverId,
    userId: `user-${serverId}`,
    nickname: "Music",
    token: `token-${serverId}`,
    expiresAt: "2026-01-01T01:00:00.000Z"
  };
}

/**
 * A socket double that records what the supervisor did to it. `connects`
 * decides whether the handshake succeeds, which is the difference between a
 * server that is reachable and one that answers HTTP but refuses the upgrade.
 */
function socketDouble(connects = true) {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  const state = { disconnected: false };
  const add = (event: string, handler: (payload?: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
  };
  const socket = {
    on(event: string, handler: (payload?: unknown) => void) {
      add(event, handler);
      return socket;
    },
    once(event: string, handler: (payload?: unknown) => void) {
      add(event, handler);
      // The supervisor waits for the handshake before wiring anything else, so
      // the double has to answer it rather than sit silent.
      if (event === (connects ? "connect" : "connect_error")) {
        queueMicrotask(() => handler(new Error("websocket error")));
      }
      return socket;
    },
    removeAllListeners() {
      listeners.clear();
      return socket;
    },
    disconnect() {
      state.disconnected = true;
      return socket;
    }
  };
  return {
    socket: socket as unknown as BotSocket,
    state,
    emit(event: string) {
      for (const handler of listeners.get(event) ?? []) handler();
    }
  };
}

describe("bot environment", () => {
  it("names every missing value at once instead of one per restart", () => {
    assert.throws(() => resolveBotEnvironment({}), /VOXLY_SERVER_URL and VOXLY_BOT_TOKEN/);
    assert.throws(() => resolveBotEnvironment({ VOXLY_BOT_TOKEN: "x" }), /VOXLY_SERVER_URL/);
    assert.throws(() => resolveBotEnvironment({ VOXLY_SERVER_URL: "http://x.test" }), /VOXLY_BOT_TOKEN/);
  });

  it("refuses a server address that is not an http URL", () => {
    assert.throws(() => resolveBotEnvironment({ VOXLY_SERVER_URL: "voxly.test", VOXLY_BOT_TOKEN: "x" }), /not a URL/);
    assert.throws(
      () => resolveBotEnvironment({ VOXLY_SERVER_URL: "ws://voxly.test", VOXLY_BOT_TOKEN: "x" }),
      /http or https/
    );
  });

  it("stores one normalized form of the server address", () => {
    assert.deepEqual(
      resolveBotEnvironment({ VOXLY_SERVER_URL: " https://chat.example.com/ ", VOXLY_BOT_TOKEN: " secret " }),
      { serverUrl: "https://chat.example.com", token: "secret" }
    );
  });
});

describe("bot credentials", () => {
  function fetchDouble(status: number, body: unknown) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status, json: async () => body };
    };
    return { fetchImpl, calls };
  }

  it("presents the credential as a bearer header on the exchange endpoint", async () => {
    const { fetchImpl, calls } = fetchDouble(201, { cookieName: "voxly_session", sessions: [session("one")] });

    const credentials = await requestBotCredentials(environment, fetchImpl);

    assert.equal(calls[0].url, "http://127.0.0.1:3000/api/bot/sessions");
    assert.equal(calls[0].headers.authorization, `Bearer ${environment.token}`);
    assert.equal(credentials.cookieName, "voxly_session");
    assert.deepEqual(credentials.sessions.map((entry) => entry.serverId), ["one"]);
  });

  it("says which side is misconfigured rather than reporting a bare status", async () => {
    await assert.rejects(requestBotCredentials(environment, fetchDouble(401, {}).fetchImpl), /rejected VOXLY_BOT_TOKEN/);
    await assert.rejects(
      requestBotCredentials(environment, fetchDouble(404, {}).fetchImpl),
      /no bot credential configured/
    );
    await assert.rejects(requestBotCredentials(environment, fetchDouble(500, {}).fetchImpl), /answered .* with 500/);
  });

  it("rejects a response that does not carry a usable session", () => {
    assert.throws(() => parseBotCredentials(null), /expected shape/);
    assert.throws(() => parseBotCredentials({ sessions: [] }), /expected shape/);
    assert.throws(
      () => parseBotCredentials({ cookieName: "voxly_session", sessions: [{ serverId: "one" }] }),
      /expected shape/
    );
    assert.deepEqual(parseBotCredentials({ cookieName: "voxly_session", sessions: [] }).sessions, []);
  });
});

describe("bot presence", () => {
  it("backs off further each attempt and stops growing at a minute", () => {
    assert.equal(retryDelayMs(1), 1000);
    assert.equal(retryDelayMs(2), 2000);
    assert.equal(retryDelayMs(3), 4000);
    assert.equal(retryDelayMs(20), 60_000);
  });

  it("opens one connection per bot account, carrying the cookie the server named", async () => {
    const opened: Array<{ serverUrl: string; cookieName: string; token: string }> = [];
    const presence = createMusicBotPresence({
      environment,
      log: () => {},
      requestCredentials: async () => ({ cookieName: "voxly_session", sessions: [session("one"), session("two")] }),
      connect: (serverUrl, cookieName, entry) => {
        opened.push({ serverUrl, cookieName, token: entry.token });
        return socketDouble().socket;
      }
    });

    await presence.start();

    assert.deepEqual(presence.connectedServerIds(), ["one", "two"]);
    assert.deepEqual(opened.map((entry) => entry.token), ["token-one", "token-two"]);
    assert.equal(opened.every((entry) => entry.cookieName === "voxly_session"), true);
    assert.equal(opened.every((entry) => entry.serverUrl === environment.serverUrl), true);
    presence.stop();
  });

  it("waits for a server that is not up yet instead of exiting", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const presence = createMusicBotPresence({
      environment,
      log: () => {},
      wait: async (milliseconds) => { waits.push(milliseconds); },
      requestCredentials: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("connect ECONNREFUSED");
        return { cookieName: "voxly_session", sessions: [session("one")] };
      },
      connect: () => socketDouble().socket
    });

    await presence.start();

    assert.deepEqual(waits, [1000, 2000]);
    assert.deepEqual(presence.connectedServerIds(), ["one"]);
    presence.stop();
  });

  it("re-authenticates after a drop rather than replaying the session it held", async () => {
    const doubles: ReturnType<typeof socketDouble>[] = [];
    const waits: number[] = [];
    let exchanges = 0;
    const presence = createMusicBotPresence({
      environment,
      log: () => {},
      wait: async (milliseconds) => { waits.push(milliseconds); },
      requestCredentials: async () => {
        exchanges += 1;
        return {
          cookieName: "voxly_session",
          sessions: [{ ...session("one"), token: `token-${exchanges}` }, { ...session("two"), token: `token-${exchanges}` }]
        };
      },
      connect: () => {
        const double = socketDouble();
        doubles.push(double);
        return double.socket;
      }
    });
    await presence.start();

    doubles[0].emit("disconnect");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(exchanges, 2, "a reconnect must mint new sessions");
    assert.deepEqual(waits, [1000], "a reconnect waits rather than re-authenticating immediately");
    // Both original sockets are retired: the exchange revoked the sessions the
    // untouched one was still holding, so keeping it would leave it authenticated
    // by a credential the server no longer honours.
    assert.equal(doubles[0].state.disconnected, true);
    assert.equal(doubles[1].state.disconnected, true);
    assert.deepEqual(presence.connectedServerIds(), ["one", "two"]);
    presence.stop();
  });

  it("backs off when the server answers the exchange but refuses the connection", async () => {
    // Wiring the loss handler before the handshake completed made this the one
    // failure the retry loop could not see: every refusal restarted the cycle at
    // once, turning an unreachable websocket into a hot loop on the exchange.
    const waits: number[] = [];
    let exchanges = 0;
    const presence = createMusicBotPresence({
      environment,
      log: () => {},
      wait: async (milliseconds) => { waits.push(milliseconds); },
      requestCredentials: async () => {
        exchanges += 1;
        return { cookieName: "voxly_session", sessions: [session("one")] };
      },
      connect: () => socketDouble(exchanges >= 3).socket
    });

    await presence.start();

    assert.deepEqual(waits, [1000, 2000], "each refusal must widen the wait");
    assert.deepEqual(presence.connectedServerIds(), ["one"]);
    presence.stop();
  });

  it("does not wire loss handlers onto a connection that never came up", async () => {
    const doubles: ReturnType<typeof socketDouble>[] = [];
    const presence = createMusicBotPresence({
      environment,
      log: () => {},
      wait: async () => { presence.stop(); },
      requestCredentials: async () => ({ cookieName: "voxly_session", sessions: [session("one")] }),
      connect: () => {
        const double = socketDouble(false);
        doubles.push(double);
        return double.socket;
      }
    });

    await presence.start();

    assert.equal(doubles[0].state.disconnected, true);
    assert.deepEqual(presence.connectedServerIds(), []);
  });

  it("stops trying once it has been told to stop", async () => {
    const presence = createMusicBotPresence({
      environment,
      log: () => {},
      wait: async () => { presence.stop(); },
      requestCredentials: async () => { throw new Error("connect ECONNREFUSED"); },
      connect: () => socketDouble().socket
    });

    await presence.start();

    assert.deepEqual(presence.connectedServerIds(), []);
  });

  it("closes every connection when stopped", async () => {
    const doubles: ReturnType<typeof socketDouble>[] = [];
    const presence = createMusicBotPresence({
      environment,
      log: () => {},
      requestCredentials: async () => ({ cookieName: "voxly_session", sessions: [session("one"), session("two")] }),
      connect: () => {
        const double = socketDouble();
        doubles.push(double);
        return double.socket;
      }
    });
    await presence.start();

    presence.stop();

    assert.equal(doubles.every((double) => double.state.disconnected), true);
    assert.deepEqual(presence.connectedServerIds(), []);
  });
});
