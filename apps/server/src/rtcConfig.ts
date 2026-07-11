import { createHmac } from "node:crypto";

const defaultCredentialTtlSeconds = 24 * 60 * 60;
const publicStunServer: IceServer = { urls: "stun:stun.l.google.com:19302" };

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ResolvedRtcConfig =
  | { enabled: false; credentialTtlSeconds: number }
  | {
      enabled: true;
      realm: string;
      staticAuthSecret: string;
      credentialTtlSeconds: number;
    };

export interface UserRtcConfig {
  iceServers: IceServer[];
  expiresAt: number | null;
}

export interface RtcConfigProvider {
  publicIceServers: IceServer[];
  getUserConfig: (userId: string, nowSeconds?: number) => UserRtcConfig;
}

export function resolveRtcConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ResolvedRtcConfig {
  const realm = clean(env.TURN_REALM);
  const staticAuthSecret = clean(env.TURN_STATIC_AUTH_SECRET);
  const credentialTtlSeconds = resolvePositiveInteger(
    env.TURN_CREDENTIAL_TTL_SECONDS,
    "TURN_CREDENTIAL_TTL_SECONDS",
    defaultCredentialTtlSeconds
  );

  if (!realm && !staticAuthSecret) {
    return { enabled: false, credentialTtlSeconds };
  }
  if (!realm) {
    throw new Error("TURN_REALM must be set when TURN_STATIC_AUTH_SECRET is configured");
  }
  if (!staticAuthSecret) {
    throw new Error("TURN_STATIC_AUTH_SECRET must be set when TURN_REALM is configured");
  }
  if (!isHostname(realm)) {
    throw new Error("TURN_REALM must be a hostname without a scheme, port, path, or query");
  }
  if (Buffer.byteLength(staticAuthSecret, "utf8") < 32) {
    throw new Error("TURN_STATIC_AUTH_SECRET must be at least 32 bytes");
  }

  return { enabled: true, realm, staticAuthSecret, credentialTtlSeconds };
}

export function createUserRtcConfig(
  config: ResolvedRtcConfig,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): UserRtcConfig {
  if (!config.enabled) {
    return { iceServers: [publicStunServer], expiresAt: null };
  }

  if (!userId || userId.includes(":")) {
    throw new Error("A non-empty user ID without colons is required for TURN credentials");
  }

  const expiresAt = Math.floor(nowSeconds) + config.credentialTtlSeconds;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", config.staticAuthSecret).update(username).digest("base64");

  return {
    expiresAt,
    iceServers: [
      { urls: `stun:${config.realm}:3478` },
      {
        urls: [
          `turn:${config.realm}:3478?transport=udp`,
          `turn:${config.realm}:3478?transport=tcp`,
          `turns:${config.realm}:5349?transport=tcp`
        ],
        username,
        credential
      }
    ]
  };
}

export function createRtcConfigProvider(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): RtcConfigProvider {
  const config = resolveRtcConfig(env);
  return {
    publicIceServers: config.enabled ? [{ urls: `stun:${config.realm}:3478` }] : [publicStunServer],
    getUserConfig: (userId, nowSeconds) => createUserRtcConfig(config, userId, nowSeconds)
  };
}

function clean(value: string | undefined) {
  const result = value?.trim();
  return result || undefined;
}

function resolvePositiveInteger(value: string | undefined, name: string, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isHostname(value: string) {
  if (value.length > 253 || value.includes(":") || value.includes("/") || value.includes("?")) return false;
  return value.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  );
}
