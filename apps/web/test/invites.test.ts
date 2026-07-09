import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInviteUrl, inviteReference, resolveInviteOrigin } from "../src/lib/invites.js";

describe("owner invite display", () => {
  it("builds a shareable invite URL from the one-time token", () => {
    assert.equal(buildInviteUrl("abc 123", "http://127.0.0.1:3000/"), "http://127.0.0.1:3000/invite/abc%20123");
  });

  it("labels stored invite ids as references, not invite tokens", () => {
    assert.equal(inviteReference("6576e4b7-9209-47f9-9d0b-4f5ad3f6e284"), "Ref 6576e4b7");
  });

  it("prefers configured public URL over local browser origin", () => {
    assert.equal(resolveInviteOrigin("https://voxly.example.com/", "http://127.0.0.1:3000"), "https://voxly.example.com");
    assert.equal(resolveInviteOrigin(null, "http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  });
});
