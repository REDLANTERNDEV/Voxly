import { randomBytes, randomInt } from "node:crypto";

/**
 * The short secret one Device shows so another can join the same account.
 *
 * Unlike every other token here it has to be **read off a screen and typed on a
 * phone**, so it cannot be `createOpaqueToken()`'s 43 characters. That is the
 * whole reason this module exists: a shorter secret needs its shortness to be
 * deliberate and its alphabet chosen, rather than being whatever a base64
 * encoder produced.
 *
 * Crockford base32 excludes I, L, O and U — the first three because they are
 * unreadable next to 1 and 0 in most typefaces, and U so that no code can spell
 * anything unfortunate. Decoding accepts the confusable characters and folds
 * them onto the digit they look like, so a member who types what they see is
 * right even when what they saw was ambiguous.
 *
 * Ten characters is 50 bits. Against a 90-second expiry, a single use, and a
 * redeem rate limit, that is not a number anybody guesses. See ADR-0014.
 */

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const linkCodeLength = 10;

/**
 * Rejection sampling rather than `% 32`. The alphabet is exactly 32 characters
 * so a modulo would in fact be unbiased here — but the alphabet is the sort of
 * thing that gets edited, and a biased generator that only becomes biased on a
 * later edit is the worst version of this bug.
 */
export function createLinkCode(length = linkCodeLength) {
  let code = "";
  while (code.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 256 - (256 % alphabet.length)) continue;
      code += alphabet[byte % alphabet.length];
      if (code.length === length) break;
    }
  }
  return code;
}

/**
 * What a member typed, reduced to what was generated.
 *
 * Grouping dashes are display, and so are spaces somebody's keyboard inserted.
 * Case is not meaningful. I and L become 1 and O becomes 0, per Crockford, so
 * reading an ambiguous glyph the wrong way is not a failed sign-in.
 *
 * Returns an empty string for anything that cannot be a code, so a caller
 * cannot accidentally look up a partially-normalised value.
 */
export function normaliseLinkCode(input: string, length = linkCodeLength) {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== length) return "";
  for (const character of cleaned) {
    if (!alphabet.includes(character)) return "";
  }
  return cleaned;
}

/** Grouped for reading aloud and for typing without losing your place. */
export function formatLinkCode(code: string) {
  return code.replace(/(.{4})(.{3})(.{3})/, "$1-$2-$3");
}

/**
 * The number both Devices display while an approval is waiting.
 *
 * Not a secret and not a second factor: it is there so the member approving can
 * see that the Device asking is the one in their other hand, rather than
 * approving whatever happened to arrive. Four digits is enough to notice a
 * mismatch and short enough to compare at a glance.
 */
export function createConfirmationNumber() {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}
