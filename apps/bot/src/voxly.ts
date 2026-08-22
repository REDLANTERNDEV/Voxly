/**
 * The parts of Voxly's HTTP surface the bot reads once it has a session.
 *
 * Everything here is a request a browser makes too. The bot has no private
 * endpoint and no database: if a person could not obtain it with their own
 * session, neither can the bot.
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type FetchJson = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface VoxlyHttp {
  serverUrl: string;
  cookieName: string;
  sessionToken: string;
  /**
   * Obtains a replacement session for this account. Bot sessions last an hour
   * and a live socket outlives one, because a socket is authorized at its
   * handshake and never again — so the first HTTP call after that hour is the
   * one that finds the credential gone.
   */
  refreshSession?: () => Promise<string>;
  fetchImpl?: FetchJson;
}

/**
 * TURN credentials are short-lived and minted per user, so they are fetched at
 * the start of a Set rather than cached across one.
 *
 * Failing to reach the endpoint is not fatal: an empty list still connects two
 * peers that can see each other directly, which is the common self-hosted case,
 * and refusing to play at all would be a worse answer than playing without
 * TURN. A rejected session is worth one retry first, though — silently dropping
 * TURN for every Set after the bot's first hour is exactly the kind of slow
 * failure nobody would connect back to a session lifetime.
 */
export async function fetchIceServers(http: VoxlyHttp): Promise<IceServer[]> {
  const config = await getJsonAuthenticated(http, "/api/rtc/config");
  if (typeof config !== "object" || config === null) return [];
  const iceServers = (config as { iceServers?: unknown }).iceServers;
  return Array.isArray(iceServers) ? (iceServers as IceServer[]) : [];
}

async function getJsonAuthenticated(http: VoxlyHttp, path: string) {
  const response = await get(http, path, http.sessionToken);
  if (response.status !== 401 || !http.refreshSession) {
    return readJson(response, path);
  }
  return readJson(await get(http, path, await http.refreshSession()), path);
}

function get(http: VoxlyHttp, path: string, sessionToken: string) {
  const fetchImpl = http.fetchImpl ?? (globalThis.fetch as unknown as FetchJson);
  return fetchImpl(`${http.serverUrl}${path}`, {
    // The session travels as the cookie the server named, exactly as it does on
    // the handshake. Never as a query parameter: that is a token in a log line.
    headers: { cookie: `${http.cookieName}=${sessionToken}` }
  });
}

async function readJson(response: { ok: boolean; status: number; json: () => Promise<unknown> }, path: string) {
  if (!response.ok) {
    // The status, never the body: a failed request against this endpoint has
    // nothing worth logging that is not a credential.
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return await response.json();
}
