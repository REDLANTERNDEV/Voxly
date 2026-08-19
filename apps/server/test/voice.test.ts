import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VoiceMediaState, VoiceMemberState, VoiceModerationState, PresenceUser } from "@voxly/shared";
import { normalizeVoiceMedia, voiceModeration, voiceSnapshot, type VoiceRoomMembership } from "../src/voice.js";
import type { ServerMemberRow } from "../src/members.js";

/**
 * The rules these cover are enforced for every join, media change and
 * moderation recalculation, so they are asserted directly rather than only
 * through a socket round trip — `realtime.test.ts` still covers the wire
 * behaviour that carries them.
 */

function media(overrides: Partial<VoiceMediaState> = {}): VoiceMediaState {
  return { mic: true, camera: false, screen: false, deafened: false, speaking: false, ...overrides };
}

const ordinaryRoom = { isAfk: false };
const afkRoom = { isAfk: true };
const noModeration: VoiceModerationState = { muted: false, deafened: false };

function member(userId: string, mediaState: VoiceMediaState): VoiceMemberState {
  const user: PresenceUser = { userId, nickname: userId, role: "member" };
  return { user, media: mediaState, moderation: noModeration };
}

function membership(...members: VoiceMemberState[]): VoiceRoomMembership {
  return new Map(members.map((entry) => [entry.user.userId, entry]));
}

describe("voice media normalization", () => {
  it("closes the microphone when the member deafens themselves", () => {
    const next = normalizeVoiceMedia(media({ mic: true, deafened: true, speaking: true }), noModeration, ordinaryRoom);
    assert.equal(next.mic, false);
    assert.equal(next.speaking, false);
  });

  it("closes the microphone under an owner mute but leaves the ears open", () => {
    const next = normalizeVoiceMedia(media({ mic: true, speaking: true }), { muted: true, deafened: false }, ordinaryRoom);
    assert.equal(next.mic, false);
    assert.equal(next.speaking, false);
    assert.equal(next.deafened, false);
  });

  it("leaves the microphone alone under an owner deafen", () => {
    const next = normalizeVoiceMedia(media({ mic: true }), { muted: false, deafened: true }, ordinaryRoom);
    assert.equal(next.mic, true);
  });

  it("mutes everyone in an AFK room, owners included, and the mute cannot be lifted from inside", () => {
    const joined = normalizeVoiceMedia(media({ mic: true }), noModeration, afkRoom);
    assert.equal(joined.mic, false);

    // An explicit unmute arriving later has to be refused by the same rule.
    const unmuteAttempt = normalizeVoiceMedia({ ...joined, mic: true, speaking: true }, noModeration, afkRoom);
    assert.equal(unmuteAttempt.mic, false);
    assert.equal(unmuteAttempt.speaking, false);
  });

  it("keeps camera and screen usable in an AFK room", () => {
    const next = normalizeVoiceMedia(media({ mic: true, camera: true, screen: true }), noModeration, afkRoom);
    assert.equal(next.camera, true);
    assert.equal(next.screen, true);
  });

  it("never reports speaking without an open microphone", () => {
    const next = normalizeVoiceMedia(media({ mic: false, speaking: true }), noModeration, ordinaryRoom);
    assert.equal(next.speaking, false);
  });

  it("defaults to no moderation and an ordinary room", () => {
    assert.deepEqual(normalizeVoiceMedia(media({ mic: true })), media({ mic: true }));
  });
});

describe("voice moderation state", () => {
  it("reads the persisted SQLite integers as owner mute and deafen flags", () => {
    const row = {
      server_id: "the-basement",
      user_id: "listener",
      role: "member",
      banned_at: null,
      removed_at: null,
      moderator_muted: 1,
      moderator_deafened: 0,
      can_invite: 0
    } satisfies ServerMemberRow;
    assert.deepEqual(voiceModeration(row), { muted: true, deafened: false });
  });
});

describe("voice snapshots", () => {
  it("carries live speaking state to the room itself", () => {
    const members = membership(member("ece", media({ mic: true, speaking: true })));
    assert.equal(voiceSnapshot("stage", members, true).members[0].media.speaking, true);
  });

  it("redacts every member's speaking flag for an audience outside the room", () => {
    const members = membership(
      member("ece", media({ mic: true, speaking: true })),
      member("kerem", media({ mic: true, speaking: true }))
    );
    const snapshot = voiceSnapshot("stage", members, false);
    assert.deepEqual(snapshot.members.map((entry) => entry.media.speaking), [false, false]);
  });

  it("leaves the stored state untouched when redacting", () => {
    const members = membership(member("ece", media({ mic: true, speaking: true })));
    voiceSnapshot("stage", members, false);
    assert.equal(members.get("ece")?.media.speaking, true);
  });

  it("reports an empty room rather than failing when nobody is present", () => {
    assert.deepEqual(voiceSnapshot("stage", undefined, true), { roomId: "stage", members: [] });
  });
});
