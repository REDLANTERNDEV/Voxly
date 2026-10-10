import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PresenceUser } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import {
  canOwnerModeratePerson,
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
    assert.match(
      memberPanel,
      /<span\s+className="badge">\s*\{\s*countPeople\(\s*visibleOnline\s*\)\s*\}\s*<\/span>\s*/
    );
    assert.match(
      memberPanel,
      /<span\s+className="badge">\s*\{\s*countPeople\(\s*visibleOffline\s*\)\s*\}\s*<\/span>\s*/
    );
    assert.match(appChrome, /const\s+onlineCount\s+=\s+countPeople\(\s*props\.onlineUsers\s*\)\s+\|\|\s+1;/);
  });
});

describe("bot moderation offers", () => {
  it("keeps voice moderation available, because muting a bot means what it says", () => {
    assert.equal(canOwnerVoiceModerate("owner", owner.userId, bot), true);
  });

  it("withholds the actions a bot cannot be the subject of", () => {
    assert.equal(canOwnerModeratePerson("owner", owner.userId, ada), true);
    assert.equal(canOwnerModeratePerson("owner", owner.userId, bot), false);
    assert.equal(canOwnerModeratePerson("member", ada.userId, bot), false);
  });

  it("wires kick and ban in both sidebars to the person answer, not the voice one", () => {
    assert.match(memberPanel, /const\s+canModeratePerson\s+=\s+canOwnerModeratePerson\(\s*/);
    assert.match(memberPanel, /canModerate=\{\s*canModeratePerson\s*\}\s*/);
    assert.match(channelRail, /const\s+canModeratePerson\s+=\s+canOwnerModeratePerson\(\s*/);
    assert.match(channelRail, /canModerate=\{\s*canModeratePerson\s*\}\s*/);
  });

  it("does not offer to move a bot, which goes where it is summoned and nowhere else", () => {
    // The same answer kick and ban read, because a move presupposes a person in
    // the same way: it says "go there", and the bot is only ever sent for.
    // Arriving would put it in a room nobody there summoned it into; leaving
    // would destroy that room's Queue from a control that never said so.
    // ADR-0010. The server refuses it too — this is presentation, not the
    // enforcement.
    assert.match(memberPanel, /moveTargets=\{\s*canModeratePerson\s+&&\s+voiceRoom\s+\?/);
    assert.match(memberPanel, /onMove=\{\s*canModeratePerson\s+&&\s+voiceRoom\s+\?/);
    assert.match(channelRail, /moveTargets=\{\s*canModeratePerson\s+\?/);
    assert.match(channelRail, /onMove=\{\s*canModeratePerson\s+\?/);
  });

  it("does not offer a bot the invite grant it could never use", () => {
    assert.match(memberPanel, /const\s+canAssignRoles\s+=\s+.*&&\s+!user\.isBot;/);
    assert.match(channelRail, /const\s+canAssignRoles\s+=\s+.*&&\s+!member\.user\.isBot;/);
  });

  it("counts the owner dashboard tiles by people too", () => {
    assert.match(ownerPanel, /const\s+people\s+=\s+users\.filter\(\s*\(\s*member\s*\)\s+=>\s+!member\.isBot\s*\);/);
    assert.match(
      ownerPanel,
      /const\s+activeMembers\s+=\s+people\.filter\(\s*\(\s*member\s*\)\s+=>\s+!member\.bannedAt\s*\);/
    );
    assert.doesNotMatch(ownerPanel, /value:\s+users\.length\s+-\s+activeMembers\.length/);
  });

  it("splits the owner panel menu so a bot keeps voice moderation and loses the rest", () => {
    assert.match(ownerPanel, /const\s+canVoiceModerate\s+=\s+member\.role\s+!==\s+"owner";/);
    assert.match(ownerPanel, /const\s+canManageMembership\s+=\s+canVoiceModerate\s+&&\s+!member\.isBot;/);
    // The access link, ban and kick entries must sit under the membership guard.
    const membershipGroup = ownerPanel.slice(ownerPanel.search(/\{canManageMembership\s*\?\s*\(?\s*<>/));
    assert.match(membershipGroup, /owner\.accessLink/);
    assert.match(membershipGroup, /requestBan\(\s*member\s*\)/);
    assert.match(membershipGroup, /member\.kickTitle/);
  });
});

describe("bot marker", () => {
  it("marks the bot row with readable text and an explanatory title", () => {
    assert.match(
      memberPanel,
      /\{\s*user\.isBot\s+\?\s+\(?\s*<span\s+className="member-role-tag\s+is-bot"\s+title=\{\s*t\(\s*"member\.botRole"\s*\)\s*\}\s*>\s*\{\s*t\(\s*"common\.bot"\s*\)\s*\}\s*<\/span>\s*\)?\s*:\s+null\s*\}\s*/
    );
  });

  it("does not stack the inviter icon on top of the bot marker", () => {
    assert.match(memberPanel, /\{\s*!user\.isBot\s+&&\s+user\.role\s+===\s+"member"\s+&&\s+user\.canInvite\s+\?/);
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
