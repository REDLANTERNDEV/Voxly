import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PresenceUser } from "@voxly/shared";
import { groupDirectoryMembers } from "../src/lib/memberDirectory.js";
import { readFileSync } from "node:fs";

const owner: PresenceUser = { userId: "owner", nickname: "Owner", role: "owner" };
const ada: PresenceUser = { userId: "ada", nickname: "Ada", role: "member" };
const ece: PresenceUser = { userId: "ece", nickname: "Ece", role: "member" };

describe("member directory presence", () => {
  it("groups active directory members online first and keeps offline members", () => {
    const grouped = groupDirectoryMembers([owner, ada, ece], [owner, ece], owner);

    assert.deepEqual(grouped.online.map((user) => user.userId), ["ece", "owner"]);
    assert.deepEqual(grouped.offline.map((user) => user.userId), ["ada"]);
  });

  it("keeps live and current users visible while the directory is loading", () => {
    const grouped = groupDirectoryMembers([], [ece], owner);

    assert.deepEqual(grouped.online.map((user) => user.userId), ["ece", "owner"]);
    assert.deepEqual(grouped.offline, []);
  });

  it("refreshes the directory when membership changes", () => {
    const source = readFileSync("src/App.tsx", "utf8");

    assert.match(source, /socket\.on\("server:directoryChanged", \(\{ serverId \}\) => \{\s*void refreshServerDirectory\(serverId\)/);
  });

  it("applies scoped realtime nickname updates to active client caches", () => {
    const source = readFileSync("src/App.tsx", "utf8");

    assert.match(source, /socket\.on\("server:memberUpdated", \(\{ serverId, user: updatedUser \}\) => \{/);
    assert.match(source, /replacePresenceUser\(current\[serverId\][^)]*updatedUser\)/s);
    assert.match(source, /renameMessagesForServer\(current, roomServerIdsRef\.current, serverId, updatedUser\)/);
    assert.match(source, /currentNickname:/);
    assert.match(source, /onUpdateMemberNickname:/);
  });

  it("applies scoped realtime server name updates to navigation state", () => {
    const source = readFileSync("src/App.tsx", "utf8");

    assert.match(source, /socket\.on\("server:updated", \(\{ serverId, name \}\) => \{/);
    assert.match(source, /server\.id === serverId \? \{ \.\.\.server, name \} : server/);
  });
});
