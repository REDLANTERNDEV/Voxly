import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  changedNicknameRows,
  effectiveNickname,
  nicknameDraftError,
  nicknameRequestValue
} from "../src/lib/profileNicknames.js";

describe("profile nickname rows", () => {
  it("saves a trimmed draft, and an emptied one as null", () => {
    assert.equal(nicknameRequestValue("  Basement Ece  "), "Basement Ece");
    assert.equal(nicknameRequestValue(""), null);
    assert.equal(nicknameRequestValue("   "), null);
  });

  it("accepts an empty field and the 2–32 character contract, nothing else", () => {
    assert.equal(nicknameDraftError(""), null);
    assert.equal(nicknameDraftError("  "), null);
    assert.equal(nicknameDraftError("x"), "length");
    assert.equal(nicknameDraftError(" x "), "length");
    assert.equal(nicknameDraftError("Ed"), null);
    assert.equal(nicknameDraftError("a".repeat(32)), null);
    assert.equal(nicknameDraftError("a".repeat(33)), "length");
  });

  it("counts a row as changed only when it would save something different", () => {
    const rows = [
      { serverId: "same", saved: "Ece", draft: " Ece " },
      { serverId: "cleared", saved: "Ece", draft: "" },
      { serverId: "still-unset", saved: null, draft: "   " },
      { serverId: "renamed", saved: null, draft: "Basement Ece" }
    ];
    assert.deepEqual(
      changedNicknameRows(rows).map((row) => row.serverId),
      ["cleared", "renamed"]
    );
  });

  it("previews the account nickname wherever the field is empty", () => {
    assert.equal(effectiveNickname("", "Ece"), "Ece");
    assert.equal(effectiveNickname(" Basement Ece ", "Ece"), "Basement Ece");
  });
});
