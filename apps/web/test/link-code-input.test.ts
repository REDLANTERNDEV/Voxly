import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLinkCodeInput, isCompleteLinkCode } from "../src/lib/linkCodeInput.js";

/**
 * The field a member types a Link code into should look like the thing they are
 * copying. The dashes are presentation only — the server strips them before it
 * hashes, so grouping changes not one bit of entropy — but a field that grows
 * into a different shape from the code on the other screen makes people stop
 * and check whether they made a mistake.
 */
describe("typing a link code", () => {
  it("groups the code as it is typed, the way it is displayed", () => {
    assert.equal(formatLinkCodeInput("J"), "J");
    assert.equal(formatLinkCodeInput("JXFT"), "JXFT");
    assert.equal(formatLinkCodeInput("JXFT5"), "JXFT-5");
    assert.equal(formatLinkCodeInput("JXFT5BS"), "JXFT-5BS");
    assert.equal(formatLinkCodeInput("JXFT5BS9X8"), "JXFT-5BS-9X8");
  });

  it("accepts the code pasted with its dashes already in", () => {
    assert.equal(formatLinkCodeInput("JXFT-5BS-9X8"), "JXFT-5BS-9X8");
    assert.equal(formatLinkCodeInput("jxft 5bs 9x8"), "JXFT-5BS-9X8");
  });

  it("folds the confusable glyphs as they are typed, not at submit time", () => {
    // The alphabet has no I, L, O or U precisely so nobody has to tell them
    // apart from 1, 1 and 0. Showing the fold immediately tells the member
    // that what they saw was understood.
    assert.equal(formatLinkCodeInput("ILO"), "110");
    assert.equal(formatLinkCodeInput("ilo"), "110");
  });

  it("drops what the alphabet does not contain rather than holding it", () => {
    assert.equal(formatLinkCodeInput("J!X@F#T"), "JXFT");
    assert.equal(formatLinkCodeInput("JXFTU"), "JXFT");
  });

  it("stops at ten characters however much is pasted", () => {
    assert.equal(formatLinkCodeInput("JXFT5BS9X8ZZZZZZ"), "JXFT-5BS-9X8");
  });

  it("only calls a code complete once all ten are there", () => {
    assert.equal(isCompleteLinkCode("JXFT-5BS-9X"), false);
    assert.equal(isCompleteLinkCode("JXFT-5BS-9X8"), true);
    assert.equal(isCompleteLinkCode(""), false);
  });
});
