import { createVoxlyApp } from "./app.js";
import { createHmac } from "node:crypto";
import { resolveTurnstileConfig } from "./turnstile.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";

const app = await createVoxlyApp({
  databasePath: process.env.DATABASE_PATH ?? "./voxly.sqlite",
  publicUrl: process.env.VOXLY_PUBLIC_URL,
  ownerBootstrapToken: process.env.OWNER_BOOTSTRAP_TOKEN,
  allowHttpOwnerBootstrap: process.env.ENABLE_HTTP_OWNER_BOOTSTRAP === "true",
  secureCookies: resolveSecureCookies(),
  webDistPath: process.env.WEB_DIST_PATH,
  turnstile: resolveTurnstileConfig({
    siteKey: process.env.TURNSTILE_SITE_KEY,
    secretKey: process.env.TURNSTILE_SECRET_KEY,
    publicUrl: process.env.VOXLY_PUBLIC_URL
  }),
  rtc: {
    iceServers: createIceServers()
  }
});

await app.server.listen({ host, port });

function resolveSecureCookies() {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;

  if (process.env.VOXLY_PUBLIC_URL) {
    try {
      return new URL(process.env.VOXLY_PUBLIC_URL).protocol === "https:";
    } catch {
      return process.env.NODE_ENV === "production";
    }
  }

  return process.env.NODE_ENV === "production";
}

function createIceServers() {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: "stun:stun.l.google.com:19302" }
  ];

  if (!process.env.TURN_REALM || !process.env.TURN_STATIC_AUTH_SECRET) {
    return servers;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const username = `${expiresAt}:voxly`;
  const credential = createHmac("sha1", process.env.TURN_STATIC_AUTH_SECRET)
    .update(username)
    .digest("base64");
  servers.push({
    urls: [
      `turn:${process.env.TURN_REALM}:3478?transport=udp`,
      `turn:${process.env.TURN_REALM}:3478?transport=tcp`
    ],
    username,
    credential
  });

  return servers;
}
