/**
 * What a member sees while typing a Link code.
 *
 * The code is *displayed* as `XXXX-XXX-XXX` on the other Device, so the field
 * that receives it should look like the thing being copied. A member reading
 * four characters, typing them, and then finding their field says something a
 * different shape has to stop and check whether they made a mistake.
 *
 * The dashes are presentation and nothing else — the server strips them before
 * it hashes, so grouping neither adds nor removes a single bit of entropy. It
 * is worth doing for the reading and for nothing else.
 */

const groups = [4, 7, 10] as const;

/**
 * Folding I, L and O onto 1, 1 and 0 happens here as well as on the server.
 *
 * The alphabet has no I, L, O or U precisely so nobody has to tell them apart
 * from 1, 1 and 0 — and doing the fold as the member types shows them that
 * what they saw was understood, rather than leaving them to find out at submit
 * time whether the glyph they guessed at was the right one.
 */
export function formatLinkCodeInput(raw: string) {
  const cleaned = raw
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-HJ-NP-TV-Z]/g, "")
    .slice(0, groups[groups.length - 1]);

  return [
    cleaned.slice(0, groups[0]),
    cleaned.slice(groups[0], groups[1]),
    cleaned.slice(groups[1], groups[2])
  ]
    .filter(Boolean)
    .join("-");
}

/** Whether enough has been typed to be worth sending. */
export function isCompleteLinkCode(formatted: string) {
  return formatted.replace(/-/g, "").length === groups[groups.length - 1];
}

/**
 * The same treatment for a Recovery code: 25 characters in five groups of five.
 *
 * It is the code most likely to be copied by hand off a piece of paper, so the
 * field it is typed into should look like what was written down — and folding
 * the confusable glyphs matters more here than anywhere, because nobody is
 * checking a 25-character string against the screen twice.
 */
const recoveryGroups = 5;
const recoveryLength = 25;

export function formatRecoveryCodeInput(raw: string) {
  const cleaned = raw
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-HJ-NP-TV-Z]/g, "")
    .slice(0, recoveryLength);

  const parts: string[] = [];
  for (let index = 0; index < cleaned.length; index += recoveryGroups) {
    parts.push(cleaned.slice(index, index + recoveryGroups));
  }
  return parts.join("-");
}

export function isCompleteRecoveryCode(formatted: string) {
  return formatted.replace(/-/g, "").length === recoveryLength;
}
