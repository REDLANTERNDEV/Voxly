/**
 * What the operator has to give the Music bot process before it can start.
 *
 * The first two values are required and neither has a safe default: a bot
 * pointed at the wrong host or holding no credential cannot do anything useful,
 * and starting anyway would leave an operator reading reconnection noise instead
 * of the one sentence that says what is missing.
 *
 * The rest have defaults, and the defaults are deliberately bare command names
 * rather than paths. A path that works here is a path that works on one
 * machine; `yt-dlp` and `ffmpeg` resolve against whatever the operator's own
 * PATH says, and an operator who needs to be specific can be.
 */

export interface BotEnvironment {
  /** Where the Voxly server is reachable from wherever the bot runs. */
  serverUrl: string;
  /** The shared credential; see `apps/server/src/bots.ts`. */
  token: string;
  /** yt-dlp, by name on PATH or by absolute path. */
  extractorPath: string;
  /** ffmpeg, by name on PATH or by absolute path. */
  encoderPath: string;
  /**
   * Which upstream client yt-dlp presents itself as, or empty for its own
   * default. Configurable because the source changes its anti-automation rules
   * without warning and an operator should be able to react to that without
   * rebuilding the image — design story 37.
   */
  extractorClient: string;
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

  return {
    serverUrl: normalizeServerUrl(serverUrl as string),
    token: token as string,
    extractorPath: env.VOXLY_YTDLP_PATH?.trim() || "yt-dlp",
    encoderPath: env.VOXLY_FFMPEG_PATH?.trim() || "ffmpeg",
    // Passed straight to yt-dlp's own `player_client`, so the set of valid
    // values is yt-dlp's to define and change. Restricted to the characters
    // that vocabulary uses, because it is an operator value that ends up on an
    // argument list.
    extractorClient: sanitizeExtractorClient(env.VOXLY_YTDLP_CLIENT?.trim() ?? "")
  };
}

function sanitizeExtractorClient(value: string) {
  if (value === "") return "";
  if (!/^[A-Za-z0-9_,+-]+$/.test(value)) {
    throw new Error(`VOXLY_YTDLP_CLIENT may only contain letters, digits, commas and dashes: ${value}`);
  }
  return value;
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
