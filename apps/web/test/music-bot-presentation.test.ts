import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { serverPermissions, type PresenceUser } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import { memberRoleRows } from "../src/lib/roles.js";
import {
  canModeratePerson,
  canMovePerson,
  canVoiceModerate,
  countPeople,
  groupDirectoryMembers
} from "../src/lib/memberDirectory.js";

const owner: PresenceUser = { userId: "owner", nickname: "Owner", role: "owner" };
const ada: PresenceUser = { userId: "ada", nickname: "Ada", role: "member" };
const bot: PresenceUser = { userId: "bot", nickname: "Music", role: "member", isBot: true };

const memberPanel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");
const channelRail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
const appChrome = readFileSync("src/components/shell/AppChrome.tsx", "utf8");
const membersSection = readFileSync("src/features/serverSettings/ServerMembersSection.tsx", "utf8");
const accessLinks = readFileSync("src/features/serverSettings/ServerAccessSections.tsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

describe("bot member counts", () => {
  it("counts people and leaves service accounts out", () => {
    assert.equal(countPeople([owner, ada, bot]), 2);
    assert.equal(countPeople([bot]), 0);
    assert.equal(countPeople([]), 0);
  });

  it("treats an absent flag as a person, so nothing has to be backfilled", () => {
    assert.equal(countPeople([{}, { isBot: false }]), 2);
  });

  it("still lists the bot even though it is not counted", () => {
    const grouped = groupDirectoryMembers([owner, bot], [owner, bot], owner);

    assert.deepEqual(grouped.online.map((user) => user.userId).sort(), ["bot", "owner"]);
    assert.equal(countPeople(grouped.online), 1);
  });

  it("counts the member badges and the mobile subtitle by people", () => {
    assert.match(
      memberPanel,
      /<span\s+className="badge">\s*\{\s*countPeople\(\s*onlineGroups\.rest\s*\)\s*\}\s*<\/span>\s*/
    );
    assert.match(
      memberPanel,
      /<span\s+className="badge">\s*\{\s*countPeople\(\s*visibleOffline\s*\)\s*\}\s*<\/span>\s*/
    );
    assert.match(appChrome, /const\s+onlineCount\s+=\s+countPeople\(\s*props\.onlineUsers\s*\)\s+\|\|\s+1;/);
  });
});

const asOwner = { role: "owner" as const, permissions: [...serverPermissions], rank: 3, userId: owner.userId };
const asAda = { role: "member" as const, permissions: [], rank: 0, userId: ada.userId };

describe("bot moderation offers", () => {
  it("keeps voice moderation available, because muting a bot means what it says", () => {
    assert.equal(canVoiceModerate(asOwner, [], bot), true);
  });

  it("withholds the actions a bot cannot be the subject of", () => {
    assert.equal(canModeratePerson(asOwner, [], ada), true);
    assert.equal(canModeratePerson(asOwner, [], bot), false);
    assert.equal(canModeratePerson(asAda, [], bot), false);
    assert.equal(canMovePerson(asOwner, [], bot), false);
  });

  it("wires kick and ban in both sidebars to the person answer, not the voice one", () => {
    assert.match(memberPanel, /const\s+canModeratePerson\s+=\s+canModeratePersonFor\(\s*/);
    assert.match(memberPanel, /canModerate=\{\s*canModeratePerson\s*\}\s*/);
    assert.match(channelRail, /const\s+canModeratePerson\s+=\s+canModeratePersonFor\(\s*/);
    assert.match(channelRail, /canModerate=\{\s*canModeratePerson\s*\}\s*/);
  });

  it("does not offer to move a bot, which goes where it is summoned and nowhere else", () => {
    // The same answer kick and ban read, because a move presupposes a person in
    // the same way: it says "go there", and the bot is only ever sent for.
    // Arriving would put it in a room nobody there summoned it into; leaving
    // would destroy that room's Queue from a control that never said so.
    // ADR-0010. The server refuses it too — this is presentation, not the
    // enforcement.
    assert.match(memberPanel, /moveTargets=\{\s*canMove\s+&&\s+voiceRoom\s+\?/);
    assert.match(memberPanel, /onMove=\{\s*canMove\s+&&\s+voiceRoom\s+\?/);
    assert.match(channelRail, /moveTargets=\{\s*canMove\s+\?/);
    assert.match(channelRail, /onMove=\{\s*canMove\s+\?/);
  });

  it("does not offer a bot a Role it could never hold (ADR-0038)", () => {
    const owner = { role: "owner" as const, permissions: ["manageRoles" as const], rank: 1 };
    assert.equal(memberRoleRows(owner, [], { ...bot, roleIds: [] }), null);
    // Every sidebar asks the same helper, so none can offer one.
    assert.match(memberPanel, /const\s+roles\s+=\s+rolesMenuFor\(\s*user\s*\)/);
    assert.match(channelRail, /const\s+roles\s+=\s+memberRolesMenu\(\s*props,\s*member\.user\s*\)/);
  });

  it("counts the Server settings member figures by people too", () => {
    assert.match(
      membersSection,
      /const\s+people\s+=\s+props\.users\.filter\(\s*\(\s*member\s*\)\s+=>\s+!member\.isBot\s*\);/
    );
    assert.match(
      membersSection,
      /const\s+activeMembers\s+=\s+people\.filter\(\s*\(\s*member\s*\)\s+=>\s+!member\.bannedAt\s*\);/
    );
    assert.doesNotMatch(membersSection, /value:\s+users\.length\s+-\s+activeMembers\.length/);
  });

  it("splits the Server settings member menu so a bot keeps voice moderation and loses the rest", () => {
    assert.match(membersSection, /canVoiceModerate\(\s*actor,\s*props\.serverRoles,\s*target\s*\)/);
    assert.match(membersSection, /canModeratePerson\(\s*actor,\s*props\.serverRoles,\s*target\s*\)/);
    // The ban and kick entries must sit under the membership guard.
    const membershipGroup = membersSection.slice(membersSection.search(/\{canManageMembership\s*\?\s*\(?\s*<>/));
    assert.match(membershipGroup, /requestBan\(\s*member\s*\)/);
    assert.match(membershipGroup, /member\.kickTitle/);
    // Access links have their own section, which never offers one to a Bot.
    assert.match(accessLinks, /users\.filter\(\s*\(member\)\s*=>\s*!member\.isBot\s*&&/);
  });
});

describe("bot marker", () => {
  it("marks the bot row with readable text and an explanatory title", () => {
    assert.match(
      memberPanel,
      /\{\s*user\.isBot\s+\?\s+\(?\s*<span\s+className="member-role-tag\s+is-bot"\s+title=\{\s*t\(\s*"member\.botRole"\s*\)\s*\}\s*>\s*\{\s*t\(\s*"common\.bot"\s*\)\s*\}\s*<\/span>\s*\)?\s*:\s+null\s*\}\s*/
    );
  });

  it("gives the marker its own shape rather than relying on colour alone", () => {
    assert.match(styles, /\.member-role-tag\.is-bot\s+\{\s*[^}]*border-radius:\s+999px;/);
    assert.match(styles, /\.member-role-tag\.is-bot\s+\{\s*[^}]*text-transform:\s+uppercase;/);
  });

  it("names a bot in the role line instead of calling it a user", () => {
    const presentation = readFileSync("src/app/presentation.tsx", "utf8");

    assert.match(presentation, /if\s+\(\s*user\.isBot\s*\)\s+return\s+t\(\s*"common\.bot"\s*\);/);
  });

  it("localizes the marker in both languages", () => {
    assert.equal(translate("en", "common.bot"), "Bot");
    assert.equal(translate("tr", "common.bot"), "Bot");
    assert.equal(translate("en", "member.botRole"), "Automated member");
    assert.equal(translate("tr", "member.botRole"), "Otomatik üye");
  });
});
