import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PresenceUser } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import {
  canOwnerModerateMembership,
  canOwnerVoiceModerate,
  countPeople,
  groupDirectoryMembers
} from "../src/lib/memberDirectory.js";

const owner: PresenceUser = { userId: "owner", nickname: "Owner", role: "owner" };
const ada: PresenceUser = { userId: "ada", nickname: "Ada", role: "member" };
const bot: PresenceUser = { userId: "bot", nickname: "Music", role: "member", isBot: true };

const memberPanel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");
const channelRail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
const appChrome = readFileSync("src/components/shell/AppChrome.tsx", "utf8");
const ownerPanel = readFileSync("src/features/owner/OwnerPanel.tsx", "utf8");
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
    assert.match(memberPanel, /<span className="badge">\{countPeople\(groupedMembers\.online\)\}<\/span>/);
    assert.match(memberPanel, /<span className="badge">\{countPeople\(groupedMembers\.offline\)\}<\/span>/);
    assert.match(appChrome, /const onlineCount = countPeople\(props\.onlineUsers\) \|\| 1;/);
  });
});

describe("bot moderation offers", () => {
  it("keeps voice moderation available, because muting a bot means what it says", () => {
    assert.equal(canOwnerVoiceModerate("owner", owner.userId, bot), true);
  });

  it("withholds the membership actions a bot cannot be the subject of", () => {
    assert.equal(canOwnerModerateMembership("owner", owner.userId, ada), true);
    assert.equal(canOwnerModerateMembership("owner", owner.userId, bot), false);
    assert.equal(canOwnerModerateMembership("member", ada.userId, bot), false);
  });

  it("wires kick and ban in both sidebars to the membership answer, not the voice one", () => {
    assert.match(memberPanel, /const canRemoveMember = canOwnerModerateMembership\(/);
    assert.match(memberPanel, /canModerate=\{canRemoveMember\}/);
    assert.match(channelRail, /const canRemoveMember = canOwnerModerateMembership\(/);
    assert.match(channelRail, /canModerate=\{canRemoveMember\}/);
  });

  it("does not offer a bot the invite grant it could never use", () => {
    assert.match(memberPanel, /const canAssignRoles = .*&& !user\.isBot;/);
    assert.match(channelRail, /const canAssignRoles = .*&& !member\.user\.isBot;/);
  });

  it("counts the owner dashboard tiles by people too", () => {
    assert.match(ownerPanel, /const people = users\.filter\(\(member\) => !member\.isBot\);/);
    assert.match(ownerPanel, /const activeMembers = people\.filter\(\(member\) => !member\.bannedAt\);/);
    assert.doesNotMatch(ownerPanel, /value: users\.length - activeMembers\.length/);
  });

  it("splits the owner panel menu so a bot keeps voice moderation and loses the rest", () => {
    assert.match(ownerPanel, /const canVoiceModerate = member\.role !== "owner";/);
    assert.match(ownerPanel, /const canManageMembership = canVoiceModerate && !member\.isBot;/);
    // The access link, ban and kick entries must sit under the membership guard.
    const membershipGroup = ownerPanel.slice(ownerPanel.indexOf("{canManageMembership ? <>"));
    assert.match(membershipGroup, /owner\.accessLink/);
    assert.match(membershipGroup, /requestBan\(member\)/);
    assert.match(membershipGroup, /member\.kickTitle/);
  });
});

describe("bot marker", () => {
  it("marks the bot row with readable text and an explanatory title", () => {
    assert.match(
      memberPanel,
      /\{user\.isBot \? <span className="member-role-tag is-bot" title=\{t\("member\.botRole"\)\}>\{t\("common\.bot"\)\}<\/span> : null\}/
    );
  });

  it("does not stack the inviter icon on top of the bot marker", () => {
    assert.match(memberPanel, /\{!user\.isBot && user\.role === "member" && user\.canInvite \?/);
  });

  it("gives the marker its own shape rather than relying on colour alone", () => {
    assert.match(styles, /\.member-role-tag\.is-bot \{[^}]*border-radius: 999px;/);
    assert.match(styles, /\.member-role-tag\.is-bot \{[^}]*text-transform: uppercase;/);
  });

  it("names a bot in the role line instead of calling it a user", () => {
    const presentation = readFileSync("src/app/presentation.tsx", "utf8");

    assert.match(presentation, /if \(user\.isBot\) return t\("common\.bot"\);/);
  });

  it("localizes the marker in both languages", () => {
    assert.equal(translate("en", "common.bot"), "Bot");
    assert.equal(translate("tr", "common.bot"), "Bot");
    assert.equal(translate("en", "member.botRole"), "Automated member");
    assert.equal(translate("tr", "member.botRole"), "Otomatik üye");
  });
});
