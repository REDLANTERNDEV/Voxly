import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { createUserRtcConfig, resolveRtcConfig } from "../src/rtcConfig.js";

describe("RTC configuration", () => {
  it("uses public STUN only when TURN is not configured", () => {
    const config = resolveRtcConfig({});

    assert.equal(config.enabled, false);
    assert.deepEqual(createUserRtcConfig(config, "user-1", 1_700_000_000), {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      expiresAt: null
    });
  });

  it("creates short-lived credentials scoped to the authenticated user", () => {
    const config = resolveRtcConfig({
      TURN_REALM: "turn.voxly.example",
      TURN_STATIC_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      TURN_CREDENTIAL_TTL_SECONDS: "3600"
    });
    const result = createUserRtcConfig(config, "user-42", 1_700_000_000);
    const username = "1700003600:user-42";

    assert.equal(config.enabled, true);
    assert.equal(result.expiresAt, 1_700_003_600);
    assert.deepEqual(result.iceServers, [
      { urls: "stun:turn.voxly.example:3478" },
      {
        urls: [
          "turn:turn.voxly.example:3478?transport=udp",
          "turn:turn.voxly.example:3478?transport=tcp",
          "turns:turn.voxly.example:5349?transport=tcp"
        ],
        username,
        credential: createHmac("sha1", "0123456789abcdef0123456789abcdef")
          .update(username)
          .digest("base64")
      }
    ]);
  });

  it("defaults TURN credentials to 24 hours", () => {
    const config = resolveRtcConfig({
      TURN_REALM: "turn.voxly.example",
      TURN_STATIC_AUTH_SECRET: "0123456789abcdef0123456789abcdef"
    });

    assert.equal(createUserRtcConfig(config, "user-1", 1_700_000_000).expiresAt, 1_700_086_400);
  });

  it("rejects partial TURN configuration", () => {
    assert.throws(
      () => resolveRtcConfig({ TURN_REALM: "turn.voxly.example" }),
      /TURN_STATIC_AUTH_SECRET must be set/
    );
    assert.throws(
      () => resolveRtcConfig({ TURN_STATIC_AUTH_SECRET: "0123456789abcdef0123456789abcdef" }),
      /TURN_REALM must be set/
    );
  });

  it("rejects unsafe realms, short secrets, and invalid TTL values", () => {
    assert.throws(
      () => resolveRtcConfig({
        TURN_REALM: "https://turn.voxly.example",
        TURN_STATIC_AUTH_SECRET: "0123456789abcdef0123456789abcdef"
      }),
      /TURN_REALM must be a hostname/
    );
    assert.throws(
      () => resolveRtcConfig({
        TURN_REALM: "turn.voxly.example",
        TURN_STATIC_AUTH_SECRET: "too-short"
      }),
      /at least 32 bytes/
    );
    assert.throws(
      () => resolveRtcConfig({
        TURN_REALM: "turn.voxly.example",
        TURN_STATIC_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        TURN_CREDENTIAL_TTL_SECONDS: "soon"
      }),
      /positive integer/
    );
  });
});
