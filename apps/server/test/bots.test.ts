import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { hashToken } from "../src/auth/tokens.js";
import {
  bearerToken,
  botSessionMinutes,
  createMusicBotAccount,
  isBotTokenValid,
  isBotUser,
  issueBotSession,
  minimumBotTokenLength,
  musicBotAccounts,
  resolveBotConfig,
  seedMusicBots
} from "../src/bots.js";
import { activeServerMembership } from "../src/members.js";
import { defaultServerId, one, openDatabase, run, type VoxlyDatabase } from "../src/db/database.js";

const configuredToken = "b".repeat(minimumBotTokenLength);

describe("bot credential configuration", () => {
  it("stays disabled when the operator configured no token", () => {
    assert.equal(resolveBotConfig({}), undefined);
    assert.equal(resolveBotConfig({ token: "   " }), undefined);
  });

  it("refuses a token short enough to guess rather than quietly disabling itself", () => {
    assert.throws(() => resolveBotConfig({ token: "short" }), /at least/);
  });

  it("trims a configured token so a stray newline cannot break every exchange", () => {
    assert.deepEqual(resolveBotConfig({ token: ` ${configuredToken}\n` }), { token: configuredToken });
  });

  it("accepts only the configured token", () => {
    assert.equal(isBotTokenValid(configuredToken, configuredToken), true);
    assert.equal(isBotTokenValid(configuredToken, "c".repeat(minimumBotTokenLength)), false);
    assert.equal(isBotTokenValid(configuredToken, undefined), false);
    // Different lengths must fail as an ordinary mismatch, not throw.
    assert.equal(isBotTokenValid(configuredToken, `${configuredToken}x`), false);
    assert.equal(isBotTokenValid(configuredToken, ""), false);
  });

  it("reads the credential only from a Bearer authorization header", () => {
    assert.equal(bearerToken(`Bearer ${configuredToken}`), configuredToken);
    assert.equal(bearerToken(`bearer ${configuredToken}`), configuredToken);
    assert.equal(bearerToken(configuredToken), undefined);
    assert.equal(bearerToken(`Basic ${configuredToken}`), undefined);
    assert.equal(bearerToken(undefined), undefined);
  });
});

describe("music bot accounts", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  async function open() {
    const opened = await openDatabase(":memory:");
    database = opened;
    return opened;
  }

  function addServer(opened: VoxlyDatabase, serverId: string) {
    run(opened.sqlite, "insert into servers (id, name, created_at) values (?, ?, ?)", [
      serverId,
      serverId,
      "2026-01-01T00:00:00.000Z"
    ]);
  }

  it("creates a bot-marked account with an active membership in its own server", async () => {
    const opened = await open();

    const account = createMusicBotAccount(opened, defaultServerId, "2026-01-01T00:00:00.000Z");

    assert.equal(account.serverId, defaultServerId);
    assert.equal(account.nickname, "Music");
    assert.equal(isBotUser(opened.sqlite, account.userId), true);
    const membership = activeServerMembership(opened.sqlite, defaultServerId, account.userId);
    assert.equal(membership?.role, "member");
  });

  it("gives a bot account a user id the moderation routes accept", async () => {
    const opened = await open();

    const account = createMusicBotAccount(opened, defaultServerId, "2026-01-01T00:00:00.000Z");

    assert.match(account.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("reports a person as not a bot, and an unknown id as not a bot", async () => {
    const opened = await open();
    run(opened.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", ["ada", "Ada", "member"]);

    assert.equal(isBotUser(opened.sqlite, "ada"), false);
    assert.equal(isBotUser(opened.sqlite, "missing"), false);
  });

  it("seeds a bot into every server that has none, including ones created before the feature", async () => {
    const opened = await open();
    addServer(opened, "second");

    const seeded = seedMusicBots(opened);

    assert.deepEqual(seeded.map((account) => account.serverId).sort(), ["second", defaultServerId]);
    assert.equal(musicBotAccounts(opened.sqlite).length, 2);
  });

  it("is safe to re-run on every start", async () => {
    const opened = await open();

    seedMusicBots(opened);
    const second = seedMusicBots(opened);

    assert.deepEqual(second, []);
    assert.equal(musicBotAccounts(opened.sqlite).length, 1);
  });

  it("does not hand back a bot account whose membership an operator removed", async () => {
    const opened = await open();
    const account = createMusicBotAccount(opened, defaultServerId, "2026-01-01T00:00:00.000Z");
    run(opened.sqlite, "update server_members set removed_at = ? where user_id = ?", [
      "2026-02-01T00:00:00.000Z",
      account.userId
    ]);

    assert.deepEqual(seedMusicBots(opened), []);
    assert.deepEqual(musicBotAccounts(opened.sqlite), []);
  });

  it("lists one account per server with the identity the bot logs in as", async () => {
    const opened = await open();
    addServer(opened, "second");
    seedMusicBots(opened);
    run(opened.sqlite, "update server_members set nickname = ? where server_id = ?", ["Müzik", "second"]);

    const accounts = musicBotAccounts(opened.sqlite);

    assert.deepEqual(accounts.map((account) => ({ serverId: account.serverId, nickname: account.nickname })), [
      { serverId: "second", nickname: "Müzik" },
      { serverId: defaultServerId, nickname: "Music" }
    ]);
  });
});

describe("bot sessions", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("mints a short-lived session stored only as a hash", async () => {
    const opened = await openDatabase(":memory:");
    database = opened;
    const account = createMusicBotAccount(opened, defaultServerId, "2026-01-01T00:00:00.000Z");

    const session = issueBotSession(opened, account.userId);

    const stored = one<{ user_id: string; expires_at: string; revoked_at: string | null }>(
      opened.sqlite,
      "select user_id, expires_at, revoked_at from sessions where token_hash = ?",
      [hashToken(session.token)]
    );
    assert.equal(stored?.user_id, account.userId);
    assert.equal(stored?.revoked_at, null);
    const lifetimeMinutes = (Date.parse(session.expiresAt) - Date.now()) / 60000;
    assert.ok(lifetimeMinutes > botSessionMinutes - 2 && lifetimeMinutes <= botSessionMinutes);
    assert.equal(
      one<{ count: number }>(opened.sqlite, "select count(*) as count from sessions where token_hash = ?", [session.token])?.count,
      0,
      "the raw token must never be persisted"
    );
  });

  it("revokes the account's earlier sessions so only one bot credential is ever live", async () => {
    const opened = await openDatabase(":memory:");
    database = opened;
    const account = createMusicBotAccount(opened, defaultServerId, "2026-01-01T00:00:00.000Z");

    const first = issueBotSession(opened, account.userId);
    const second = issueBotSession(opened, account.userId);

    const revoked = one<{ revoked_at: string | null }>(
      opened.sqlite,
      "select revoked_at from sessions where token_hash = ?",
      [hashToken(first.token)]
    );
    assert.notEqual(revoked?.revoked_at, null);
    const live = one<{ revoked_at: string | null }>(
      opened.sqlite,
      "select revoked_at from sessions where token_hash = ?",
      [hashToken(second.token)]
    );
    assert.equal(live?.revoked_at, null);
  });

  it("leaves other accounts' sessions alone", async () => {
    const opened = await openDatabase(":memory:");
    database = opened;
    const account = createMusicBotAccount(opened, defaultServerId, "2026-01-01T00:00:00.000Z");
    run(opened.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", ["ada", "Ada", "member"]);
    run(
      opened.sqlite,
      "insert into sessions (id, token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?, ?)",
      ["human", hashToken("human-token"), "ada", "2026-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"]
    );

    issueBotSession(opened, account.userId);

    const human = one<{ revoked_at: string | null }>(
      opened.sqlite,
      "select revoked_at from sessions where id = 'human'"
    );
    assert.equal(human?.revoked_at, null);
  });
});
