import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseInviteInput } from "../src/lib/invites.js";

const token = "LOBsvxjQhMxKg14bUnc4xD8NTCmrDCrOarhzabHEmKw";
const here = ["http://127.0.0.1:5173", "https://voxly.example.com"];

describe("what a pasted or clicked invite is (ADR-0036)", () => {
  it("reads this Installation's links of either shape, and a bare token, as here", () => {
    assert.deepEqual(parseInviteInput(`https://voxly.example.com/invite#${token}`, here), { kind: "here", token });
    assert.deepEqual(parseInviteInput(`  http://127.0.0.1:5173/invite/${token} `, here), { kind: "here", token });
    assert.deepEqual(parseInviteInput(token, here), { kind: "here", token });
  });

  it("names another Installation's invite as elsewhere, never as one to join here", () => {
    assert.deepEqual(parseInviteInput(`https://other.example.org/invite#${token}`, here), {
      kind: "elsewhere",
      origin: "https://other.example.org",
      url: `https://other.example.org/invite#${token}`
    });
    // The same host on another port is another origin.
    assert.equal(parseInviteInput(`https://voxly.example.com:8443/invite#${token}`, here).kind, "elsewhere");
  });

  it("refuses anything that is not an invite", () => {
    for (const value of [
      "",
      "hello there",
      "short-token",
      `https://voxly.example.com/somewhere/${token}`,
      `https://voxly.example.com/invite/${token}/`,
      `https://voxly.example.com/invite?x=1#${token}`,
      `https://user:pass@voxly.example.com/invite#${token}`,
      `javascript:alert(1)//${token}`,
      `ftp://voxly.example.com/invite/${token}`,
      `https://voxly.example.com/invite#%E0%A4%A`
    ]) {
      assert.deepEqual(parseInviteInput(value, here), { kind: "invalid" }, value);
    }
  });

  it("keeps a plain click on this Installation's invite inside Voxly, and leaves modified clicks alone", () => {
    const body = readFileSync("src/features/chat/MessageBody.tsx", "utf8");
    assert.match(body, /parseInviteInput\(segment\.href,\s*installationOrigins\(\)\)/);
    assert.match(body, /event\.button !== 0 \|\| event\.ctrlKey \|\| event\.metaKey/);
    assert.match(body, /openInviteInPlace\(invite\.token\)/);
    const invites = readFileSync("src/lib/invites.ts", "utf8");
    assert.match(invites, /window\.dispatchEvent\(new PopStateEvent\("popstate"\)\)/);
  });
});
