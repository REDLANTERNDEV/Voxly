/**
 * What the operator has to give the Music bot process before it can start.
 *
 * Both values are required and neither has a safe default: a bot pointed at the
 * wrong host or holding no credential cannot do anything useful, and starting
 * anyway would leave an operator reading reconnection noise instead of the one
 * sentence that says what is missing.
 */

export interface BotEnvironment {
  /** Where the Voxly server is reachable from wherever the bot runs. */
  serverUrl: string;
  /** The shared credential; see `apps/server/src/bots.ts`. */
  token: string;
}

export function resolveBotEnvironment(env: Record<string, string | undefined>): BotEnvironment {
  const serverUrl = env.VOXLY_SERVER_URL?.trim();
  const token = env.VOXLY_BOT_TOKEN?.trim();

  const missing = [
    serverUrl ? null : "VOXLY_SERVER_URL",
    token ? null : "VOXLY_BOT_TOKEN"
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(`The Music bot needs ${missing.join(" and ")}.`);
  }

  return { serverUrl: normalizeServerUrl(serverUrl as string), token: token as string };
}

/**
 * Trailing slashes are how the same value works in a browser bar and breaks a
 * fetch path, so the one stored form has none.
 */
function normalizeServerUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`VOXLY_SERVER_URL is not a URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`VOXLY_SERVER_URL must be http or https: ${value}`);
  }
  return parsed.origin;
}
