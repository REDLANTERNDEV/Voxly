/**
 * The Music bot's account, and the credential its process uses to reach it.
 *
 * A bot is an ordinary member of exactly one server — same `users` row, same
 * `server_members` row, same authorization checks — distinguished only by
 * `users.is_bot`. That flag is presentation and moderation policy, never a
 * permission: nothing in the product asks whether a caller is a bot before
 * deciding what it may do.
 *
 * Its process cannot sit at a login form, so it authenticates with an operator
 * secret held in the environment of both processes and exchanges that once for
 * an ordinary short-lived session. See `docs/adr/0003-music-bot-service-account-credentials.md`
 * for why the credential is shaped this way.
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { musicBotNickname } from "@voxly/shared";
import { revokeSessionsForUser } from "./auth/sessions.js";
import { createOpaqueToken, hashToken } from "./auth/tokens.js";
import { all, one, run, type VoxlyDatabase } from "./db/database.js";
import { activateServerMembership } from "./members.js";

export interface BotConfig {
  token: string;
}

/**
 * The credential is a bearer secret with no second factor and no user behind
 * it, so its only defence is being too large to guess. 32 characters is the
 * floor the owner bootstrap and TURN secrets are documented at.
 */
export const minimumBotTokenLength = 32;

/**
 * Bot sessions are minted by a process that can re-authenticate at any moment,
 * so they carry none of the reasons a person's session lives for months. An
 * hour bounds what a leaked one is worth without costing the bot anything.
 */
export const botSessionMinutes = 60;

export function resolveBotConfig(input: { token?: string }): BotConfig | undefined {
  const token = input.token?.trim();
  if (!token) return undefined;
  if (token.length < minimumBotTokenLength) {
    throw new Error(`VOXLY_BOT_TOKEN must be at least ${minimumBotTokenLength} characters.`);
  }
  return { token };
}

/**
 * Compared on fixed-width digests rather than the raw strings: `timingSafeEqual`
 * throws on a length mismatch, which would turn the length of the operator's
 * secret into an observable, and comparing hashes keeps every attempt the same
 * shape.
 */
export function isBotTokenValid(configured: string, presented: string | undefined) {
  if (!presented) return false;
  return timingSafeEqual(
    Buffer.from(hashToken(configured), "hex"),
    Buffer.from(hashToken(presented), "hex")
  );
}

/** The credential arrives as a header, never as a query string or a cookie. */
export function bearerToken(header: string | undefined) {
  if (!header) return undefined;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

export interface BotAccount {
  serverId: string;
  userId: string;
  /** Effective membership nickname, so a rename follows the bot into its login. */
  nickname: string;
}

const botAccountColumns = `select server_members.server_id as serverId,
      users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname`;

const activeBotAccountClause = `from server_members
     join users on users.id = server_members.user_id
     where users.is_bot = 1
       and server_members.banned_at is null
       and server_members.removed_at is null`;

/** Every live Music bot account, one per server that has one. */
export function musicBotAccounts(sqlite: DatabaseSync): BotAccount[] {
  return all<BotAccount & Record<string, unknown>>(
    sqlite,
    `${botAccountColumns} ${activeBotAccountClause} order by server_members.server_id asc`
  ).map((row) => ({ serverId: row.serverId, userId: row.userId, nickname: row.nickname }));
}

/** The one Music bot account a server has, or nothing if it has none. */
export function musicBotAccountFor(sqlite: DatabaseSync, serverId: string): BotAccount | undefined {
  const row = one<BotAccount & Record<string, unknown>>(
    sqlite,
    `${botAccountColumns} ${activeBotAccountClause} and server_members.server_id = ?`,
    [serverId]
  );
  return row ? { serverId: row.serverId, userId: row.userId, nickname: row.nickname } : undefined;
}

export function isBotUser(sqlite: DatabaseSync, userId: string) {
  const user = one<{ is_bot: number }>(sqlite, "select is_bot from users where id = ?", [userId]);
  return user?.is_bot === 1;
}

/**
 * Refuses the moderation actions that presuppose a person.
 *
 * Kicking or banning the Music bot would break the feature for that server, and
 * a global ban has no undo at all; the invite grant and an access link both hand
 * out something only a browser can use. A move presupposes a person in a
 * quieter way: it is an instruction to *go somewhere*, and the bot goes where it
 * is summoned and nowhere else — being moved would either place it in a room
 * nobody there asked for it or destroy that room's Queue, depending on which
 * half of the move you look at. ADR-0010.
 *
 * Muting, deafening and disconnecting are deliberately not here. Those mean
 * exactly what they mean for anyone else, and the bot honours them itself,
 * because media is peer-to-peer and the server cannot enforce silence on
 * packets it never sees (ADR-0009).
 */
export function rejectBotTarget(database: VoxlyDatabase, userId: string, reply: FastifyReply) {
  if (!isBotUser(database.sqlite, userId)) return false;
  reply.code(409).send({ error: "cannot_moderate_bot" });
  return true;
}

export function createMusicBotAccount(
  database: VoxlyDatabase,
  serverId: string,
  joinedAt: string
): BotAccount {
  // A UUID rather than a readable id: every server-scoped moderation route
  // validates `userId` as a UUID, and a bot that could not be named in those
  // routes could not be muted or disconnected either.
  const userId = crypto.randomUUID();
  run(database.sqlite, "insert into users (id, nickname, role, is_bot) values (?, ?, 'member', 1)", [
    userId,
    musicBotNickname
  ]);
  activateServerMembership(database, serverId, userId, "member", joinedAt);
  return { serverId, userId, nickname: musicBotNickname };
}

/**
 * Every server gets a Music bot, existing ones included — a deployment that
 * upgrades into this feature would otherwise have the bot only in servers
 * created afterwards.
 *
 * Keyed on whether the server has any bot membership at all, banned and removed
 * ones included, so it is safe on every start and an operator who took the bot
 * out of a server is not handed it back on the next restart.
 */
export function seedMusicBots(database: VoxlyDatabase): BotAccount[] {
  const servers = all<{ id: string }>(
    database.sqlite,
    `select servers.id as id from servers
     where not exists (
       select 1 from server_members
       join users on users.id = server_members.user_id
       where server_members.server_id = servers.id and users.is_bot = 1
     )
     order by servers.created_at asc`
  );
  const now = new Date().toISOString();
  return servers.map((server) => createMusicBotAccount(database, server.id, now));
}

/**
 * Mints the session the bot presents on its handshake, and retires the ones it
 * held before. The bot re-authenticates whenever it reconnects, so a stale
 * credential is never something it still needs — leaving it live would only
 * widen what a copied token is worth.
 */
export function issueBotSession(database: VoxlyDatabase, userId: string) {
  const token = createOpaqueToken();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + botSessionMinutes * 60 * 1000).toISOString();
  database.sqlite.exec("begin immediate");
  try {
    revokeSessionsForUser(database.sqlite, userId, nowIso);
    run(
      database.sqlite,
      "insert into sessions (id, token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?, ?)",
      [crypto.randomUUID(), hashToken(token), userId, nowIso, expiresAt]
    );
    database.sqlite.exec("commit");
  } catch (cause) {
    database.sqlite.exec("rollback");
    throw cause;
  }
  database.save();
  return { token, expiresAt };
}
