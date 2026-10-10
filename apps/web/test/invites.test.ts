import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildInviteUrl, inviteReference, maskSecretLink, resolveInviteOrigin } from "../src/lib/invites.js";
import { readAppSource } from "./app-source.js";

describe("owner invite display", () => {
  it("builds a shareable invite URL from the one-time token", () => {
    assert.equal(buildInviteUrl("abc 123", "http://127.0.0.1:3000/"), "http://127.0.0.1:3000/invite/abc%20123");
  });

  it("labels stored invite ids as references, not invite tokens", () => {
    assert.equal(inviteReference("6576e4b7-9209-47f9-9d0b-4f5ad3f6e284"), "Ref 6576e4b7");
  });

  it("prefers configured public URL over local browser origin", () => {
    assert.equal(
      resolveInviteOrigin("https://voxly.example.com/", "http://127.0.0.1:3000"),
      "https://voxly.example.com"
    );
    assert.equal(resolveInviteOrigin(null, "http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  });

  it("masks secret links without retaining their token in the display value", () => {
    const value = "https://voxly.example.com/invite/top-secret-token";
    const masked = maskSecretLink(value);

    assert.equal(masked, "https://voxly.example.com/invite/••••••••••••");
    assert.equal(masked.includes("top-secret-token"), false);

    assert.equal(
      maskSecretLink("https://voxly.example.com/access/claim#token=another-secret"),
      "https://voxly.example.com/access/claim#token=••••••••••••"
    );
  });

  it("loads the current server name when an invite link opens", () => {
    const source = readAppSource();
    const inviteScreen = source.match(/function\s+InviteScreen[\s\S]*?\n}\n\nfunction\s+TurnstileWidget/)?.[0] ?? "";

    assert.match(inviteScreen, /previewInvite\(\s*extractInviteToken\(\s*initialToken\s*\)\s*\)/);
    assert.match(inviteScreen, /invite\.joinServerTitle/);
    assert.match(inviteScreen, /serverName/);
  });

  it("refreshes the switcher and opens the invited server for an existing user", () => {
    const source = readAppSource();
    const switcher = readFileSync("src/components/ServerSwitcher.tsx", "utf8");
    const inviteRoute = source.match(/function\s+AppRoutes[\s\S]*?function\s+useSessionController/)?.[0] ?? "";

    assert.match(inviteRoute, /existingUser=\{\s*Boolean\(\s*user\s*\)\s*\}\s*/);
    assert.match(inviteRoute, /completeAuthentication\(\s*accepted\s*\)/);
    assert.match(inviteRoute, /loadAcceptedServer\(\s*serverId\s*\)/);
    assert.match(source, /Promise\.all\(\s*\[fetchServers\(\s*\),\s+fetchServerRooms\(\s*serverId\s*\)\]\s*\)/);
    assert.match(source, /setServers\(\s*serverResponse\.servers\s*\)/);
    assert.match(source, /firstServerRoomPath\(\s*serverId,\s+roomResponse\.rooms\s*\)/);
    assert.match(
      switcher,
      /props\.servers\.map\(\s*\(\s*server\s*\)\s+=>\s*\(?\s*<option\s+key=\{\s*server\.id\s*\}\s+value=\{\s*server\.id\s*\}\s*>\s*\{\s*server\.name\s*\}\s*<\/option>\s*\)?\s*\)/
    );
  });
});
