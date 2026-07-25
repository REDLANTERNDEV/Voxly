import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PresenceUser } from "@voxly/shared";
import { canOwnerVoiceModerate, currentServerPresence, groupDirectoryMembers } from "../src/lib/memberDirectory.js";
import { readFileSync } from "node:fs";
import { readAppSource } from "./app-source.js";

const owner: PresenceUser = { userId: "owner", nickname: "Owner", role: "owner" };
const ada: PresenceUser = { userId: "ada", nickname: "Ada", role: "member" };
const ece: PresenceUser = { userId: "ece", nickname: "Ece", role: "member" };

describe("member directory presence", () => {
  it("limits owner voice moderation to other ordinary members", () => {
    assert.equal(canOwnerVoiceModerate("owner", owner.userId, ada), true);
    assert.equal(canOwnerVoiceModerate("owner", owner.userId, owner), false);
    assert.equal(canOwnerVoiceModerate("member", ada.userId, ece), false);
  });

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

  it("uses the server-scoped nickname for the current user without a presence snapshot", () => {
    const current = { id: "owner", nickname: "Account Owner", role: "owner" as const, bannedAt: null };

    assert.deepEqual(currentServerPresence(current, [{ ...owner, nickname: "Server Owner" }]), {
      ...owner,
      nickname: "Server Owner"
    });
    assert.deepEqual(currentServerPresence(current, []), {
      userId: "owner",
      nickname: "Account Owner",
      role: "owner"
    });
  });

  it("does not expose an empty action menu for another owner outside voice", () => {
    const panel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");

    assert.match(panel, /const hasRemoteActions = user\.userId !== currentUser\.id && Boolean\(voiceRoom \|\| canModerateRemote\)/);
  });

  it("refreshes the directory when membership changes", () => {
    const source = readAppSource();

    assert.match(source, /next\.on\("server:directoryChanged"[\s\S]*handlersRef\.current\.directoryChanged\(serverId\)/);
    assert.match(source, /directoryChanged: \(serverId\)[\s\S]*workspace\.refreshServerDirectory\(serverId\)/);
  });

  it("applies scoped realtime nickname updates to active client caches", () => {
    const source = readAppSource();

    assert.match(source, /next\.on\("server:memberUpdated"[\s\S]*handlersRef\.current\.memberUpdated\(serverId, nextUser\)/);
    assert.match(source, /replacePresenceUser\(current\[serverId\][^)]*next\)/s);
    assert.match(source, /renameMessagesForServer\(current, roomServerIds\.current, serverId, next\)/);
    assert.match(source, /currentNickname:/);
    assert.match(source, /onUpdateMemberNickname:/);
  });

  it("applies scoped realtime server name updates to navigation state", () => {
    const source = readAppSource();

    assert.match(source, /next\.on\("server:updated"[\s\S]*handlersRef\.current\.serverUpdated\(serverId, name\)/);
    assert.match(source, /server\.id === serverId \? \{ \.\.\.server, name \} : server/);
  });
});
