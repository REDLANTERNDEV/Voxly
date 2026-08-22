/**
 * How the bot gets in without a human.
 *
 * It holds the operator's credential rather than a session, and trades it at
 * `POST /api/bot/sessions` for one ordinary session per Music bot account. From
 * there on it is an ordinary member: the session goes on the handshake as the
 * cookie the server named, and every authorization check on the other side is
 * the one that already applies to everyone else.
 *
 * The exchange is re-run on every reconnect rather than cached, which is also
 * how a server created after the bot started gets picked up.
 */

import type { BotEnvironment } from "./config.js";

export interface BotSession {
  serverId: string;
  userId: string;
  nickname: string;
  /** Raw session token. Never log this. */
  token: string;
  expiresAt: string;
}

export interface BotCredentials {
  /** The server names its own session cookie; the bot does not assume one. */
  cookieName: string;
  sessions: BotSession[];
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

export function parseBotCredentials(value: unknown): BotCredentials {
  if (!isRecord(value) || typeof value.cookieName !== "string" || !Array.isArray(value.sessions)) {
    throw new Error("The bot session response did not have the expected shape.");
  }
  return {
    cookieName: value.cookieName,
    sessions: value.sessions.map((session) => {
      if (
        !isRecord(session) ||
        typeof session.serverId !== "string" ||
        typeof session.userId !== "string" ||
        typeof session.nickname !== "string" ||
        typeof session.token !== "string" ||
        typeof session.expiresAt !== "string"
      ) {
        throw new Error("The bot session response did not have the expected shape.");
      }
      return {
        serverId: session.serverId,
        userId: session.userId,
        nickname: session.nickname,
        token: session.token,
        expiresAt: session.expiresAt
      };
    })
  };
}

export async function requestBotCredentials(
  environment: BotEnvironment,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<BotCredentials> {
  const response = await fetchImpl(`${environment.serverUrl}/api/bot/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${environment.token}` }
  });

  if (response.status === 401) {
    throw new Error("The Voxly server rejected VOXLY_BOT_TOKEN.");
  }
  if (response.status === 404) {
    throw new Error("The Voxly server has no bot credential configured; set VOXLY_BOT_TOKEN there too.");
  }
  if (response.status !== 201) {
    // The status is the whole diagnosis here, and the body may carry a token.
    throw new Error(`The Voxly server answered the bot session exchange with ${response.status}.`);
  }

  return parseBotCredentials(await response.json());
}

export interface SessionHolder {
  /** The token to present right now. Read it per request, not once. */
  readonly token: string;
  /** Trades the operator credential for a new session and returns its token. */
  refresh: () => Promise<string>;
}

/**
 * One bot account's session, replaceable without reconnecting.
 *
 * A socket is authorized at its handshake and never again, so it happily
 * outlives the hour its session lasts. HTTP calls are not so lucky: the first
 * one after that hour is refused, and for the Music bot that means a Set that
 * quietly runs without TURN. Re-running the exchange is the same thing a
 * reconnect would do, minus the reconnect.
 *
 * The exchange mints a session for every bot account and retires the previous
 * ones, so refreshing here leaves a sibling account holding a stale token. That
 * is fine and self-correcting: the sibling's next call is refused once and
 * refreshes in turn.
 */
export function createSessionHolder(
  environment: BotEnvironment,
  session: BotSession,
  requestCredentials: (environment: BotEnvironment) => Promise<BotCredentials> = requestBotCredentials
): SessionHolder {
  let token = session.token;
  return {
    get token() {
      return token;
    },
    async refresh() {
      const credentials = await requestCredentials(environment);
      const replacement = credentials.sessions.find((entry) => entry.serverId === session.serverId);
      if (!replacement) {
        throw new Error(`The Voxly server no longer has a Music bot account for server ${session.serverId}.`);
      }
      token = replacement.token;
      return token;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
