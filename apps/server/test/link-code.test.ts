import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createConfirmationNumber,
  createLinkCode,
  formatLinkCode,
  linkCodeLength,
  normaliseLinkCode
} from "../src/auth/linkCode.js";
import { formatRecoveryCode, normaliseRecoveryCode, recoveryCodeLength } from "../src/recovery.js";

/**
 * The one secret in Voxly that a person reads off a screen and types on a
 * phone. Everything here follows from that: a chosen alphabet rather than
 * whatever base64 produced, and a decoder that forgives the ways a human copies
 * ten characters wrong.
 */
describe("link code", () => {
  it("is ten characters from the Crockford alphabet", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const code = createLinkCode();
      assert.equal(code.length, linkCodeLength);
      assert.match(code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    }
  });

  it("never contains the characters people misread", () => {
    // I and L against 1, O against 0, and U so no code spells anything unfortunate.
    const codes = Array.from({ length: 500 }, () => createLinkCode()).join("");

    assert.doesNotMatch(codes, /[ILOU]/);
  });

  it("does not repeat itself", () => {
    const codes = new Set(Array.from({ length: 500 }, () => createLinkCode()));

    assert.equal(codes.size, 500);
  });

  it("accepts the code as it was displayed, dashes and all", () => {
    const code = createLinkCode();

    assert.equal(normaliseLinkCode(formatLinkCode(code)), code);
    assert.equal(normaliseLinkCode(` ${formatLinkCode(code).toLowerCase()} `), code);
  });

  it("folds the confusable glyphs onto the digit they look like", () => {
    // A member typing what they saw is right even when what they saw was
    // ambiguous — that is the point of choosing this alphabet.
    assert.equal(normaliseLinkCode("I1L0OABCDE"), "1110" + "0ABCDE");
    assert.equal(normaliseLinkCode("i1l0oabcde"), "11100ABCDE");
  });

  it("refuses anything that cannot be a code rather than half-normalising it", () => {
    // An empty answer keeps a caller from looking up a partial value.
    for (const input of ["", "short", "0123456789012", "0123456789!", "UUUUUUUUUU"]) {
      assert.equal(normaliseLinkCode(input), "", `accepted ${JSON.stringify(input)}`);
    }
  });

  it("groups the code for reading aloud without changing it", () => {
    assert.equal(formatLinkCode("0123456789"), "0123-456-789");
    assert.equal(normaliseLinkCode(formatLinkCode("0123456789")), "0123456789");
  });
});

describe("confirmation number", () => {
  it("is always four digits, including the low ones", () => {
    // Not a secret — it exists so the member approving can see that the Device
    // asking is the one in their other hand. A number that sometimes renders as
    // three digits is one a member cannot compare at a glance.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      assert.match(createConfirmationNumber(), /^\d{4}$/);
    }
  });
});

/**
 * The Recovery code shares this alphabet for a reason worth pinning.
 *
 * It was first built on `createOpaqueToken()`, which is base64url and can
 * contain a literal `-`. Because the code is grouped with dashes for anybody
 * writing it down, normalising stripped the dash *inside* the token too — so
 * roughly one recovery code in eight silently failed to redeem. A secret that
 * works for most people is the worst kind of broken, and it is invisible to any
 * test that only checks one generated value.
 */
describe("recovery code round trip", () => {
  it("survives being written down and typed back, every time", () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const token = createLinkCode(recoveryCodeLength);
      const written = formatRecoveryCode(token);

      assert.equal(normaliseRecoveryCode(written), token, `lost ${written}`);
      assert.equal(normaliseRecoveryCode(written.toLowerCase()), token);
      assert.equal(normaliseRecoveryCode(written.replace(/-/g, " ")), token);
    }
  });

  it("carries no separator that normalising would eat", () => {
    const codes = Array.from({ length: 200 }, () => createLinkCode(recoveryCodeLength)).join("");

    assert.doesNotMatch(codes, /[-_\s]/);
  });
});
