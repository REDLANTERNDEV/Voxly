import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTurnstileConfig } from "../src/turnstile.js";

describe("Turnstile runtime configuration", () => {
  it("enables Turnstile only when both public and private keys are configured", () => {
    assert.deepEqual(
      resolveTurnstileConfig({ siteKey: "0x4AAAA-site-key", secretKey: "private-secret" }),
      { enabled: true, siteKey: "0x4AAAA-site-key", secretKey: "private-secret" }
    );
  });

  it("rejects incomplete Turnstile configuration instead of breaking invite acceptance", () => {
    assert.throws(
      () => resolveTurnstileConfig({ secretKey: "private-secret" }),
      /TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/
    );
  });
});
