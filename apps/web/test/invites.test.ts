import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  it("loads the current server name when an invite link opens", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const inviteScreen = source.match(/function InviteScreen[\s\S]*?\n}\n\nfunction TurnstileWidget/)?.[0] ?? "";

    assert.match(inviteScreen, /previewInvite\(extractInviteToken\(initialToken\)\)/);
    assert.match(inviteScreen, /invite\.joinServerTitle/);
    assert.match(inviteScreen, /serverName/);
  });

  it("refreshes the switcher and opens the invited server for an existing user", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const switcher = readFileSync("src/components/ServerSwitcher.tsx", "utf8");
    const inviteRoute = source.match(/if \(!user \|\| route\.name === "invite"\)[\s\S]*?\n  const currentNickname/)?.[0] ?? "";

    assert.match(inviteRoute, /existingUser=\{Boolean\(user\)\}/);
    assert.match(inviteRoute, /Promise\.all\(\[fetchServers\(\), fetchServerRooms\(serverId\)\]\)/);
    assert.match(inviteRoute, /setServers\(serverResponse\.servers\)/);
    assert.match(inviteRoute, /navigate\(`\/app\/server\/\$\{serverId\}\/\$\{target\.kind\}\/\$\{target\.id\}`\)/);
    assert.match(switcher, /props\.servers\.map\(\(server\) => <option key=\{server\.id\} value=\{server\.id\}>\{server\.name\}<\/option>\)/);
  });
});
