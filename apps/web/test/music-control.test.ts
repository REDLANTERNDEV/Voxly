import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { MusicControlAck, VoiceMemberState } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import { musicBotIn, musicErrorKey, musicPanelState, offersStop, requestMusicCommand } from "../src/lib/musicBot.js";

const musicPanel = readFileSync("src/features/voice/MusicPanel.tsx", "utf8");
const voiceRoom = readFileSync("src/features/voice/VoiceRoomScreen.tsx", "utf8");

function member(userId: string, overrides: Partial<VoiceMemberState> = {}): VoiceMemberState {
  return {
    user: { userId, nickname: userId, role: "member" },
    media: { mic: true, camera: false, screen: false, deafened: false, speaking: false },
    moderation: { muted: false, deafened: false },
    ...overrides
  };
}

const bot = member("music", { user: { userId: "music", nickname: "Music", role: "member", isBot: true } });

describe("finding the Music bot in a room", () => {
  it("picks the service account, not a person with a musical nickname", () => {
    const impostor = member("ada", { user: { userId: "ada", nickname: "Music", role: "member" } });

    assert.equal(musicBotIn([impostor, bot])?.user.userId, "music");
    assert.equal(musicBotIn([impostor]), undefined);
  });

  it("treats an absent flag as a person", () => {
    assert.equal(musicBotIn([member("ada")]), undefined);
  });
});

describe("what the panel is looking at", () => {
  it("reads the bot's own speaking report, the same as anyone else's", () => {
    assert.equal(musicPanelState({ ...bot, media: { ...bot.media, speaking: true } }), "playing");
    assert.equal(musicPanelState(bot), "idle");
    assert.equal(musicPanelState(undefined), "absent");
  });

  it("treats a muted bot as its own state, not as idle", () => {
    // The server clamps `speaking` off for a muted member, but media is
    // peer-to-peer so the mute does not stop the packets. Calling that idle
    // would offer Play for a bot that may well still be audible.
    const muted = { ...bot, moderation: { muted: true, deafened: false } };

    assert.equal(musicPanelState(muted), "muted");
    assert.equal(musicPanelState({ ...muted, media: { ...bot.media, speaking: true } }), "muted");
  });

  it("offers to stop whenever pressing play could do nothing", () => {
    assert.equal(offersStop("playing"), true);
    assert.equal(offersStop("muted"), true, "stopping is the request that always takes effect");
    assert.equal(offersStop("idle"), false);
    assert.equal(offersStop("absent"), false);
  });
});

describe("asking for music", () => {
  it("sends the command for the named room and resolves with the answer", async () => {
    const sent: Array<{ roomId: string; command: string }> = [];
    const socket = {
      emit(_event: "music:control", payload: { roomId: string; command: "play" | "stop" | "leave" }, ack: (response: MusicControlAck) => void) {
        sent.push(payload);
        ack({ ok: true });
      }
    };

    const response = await requestMusicCommand(socket, "lobby", "play");

    assert.deepEqual(sent, [{ roomId: "lobby", command: "play" }]);
    assert.deepEqual(response, { ok: true });
  });

  it("answers without a round trip when there is no socket or no room", async () => {
    assert.deepEqual(await requestMusicCommand(null, "lobby", "play"), { ok: false, error: "not_in_voice_room" });
    assert.deepEqual(
      await requestMusicCommand({ emit: () => assert.fail("must not emit") }, null, "play"),
      { ok: false, error: "not_in_voice_room" }
    );
  });
});

describe("what a refusal says", () => {
  it("gives every refusal its own sentence, in both languages", () => {
    const errors = ["bot_offline", "no_music_bot", "afk_room", "not_in_voice_room", "room_not_found"] as const;
    const english = errors.map((error) => translate("en", musicErrorKey(error)));
    const turkish = errors.map((error) => translate("tr", musicErrorKey(error)));

    assert.equal(new Set(english).size, errors.length, "no two refusals may read the same");
    assert.equal(new Set(turkish).size, errors.length);
    for (const [index, message] of english.entries()) {
      assert.notEqual(message, turkish[index], `${errors[index]} must actually be translated`);
    }
  });

  it("translates the controls themselves in both languages", () => {
    const keys = ["music.title", "music.play", "music.stop", "music.leave", "music.playing", "music.idle", "music.muted"] as const;
    for (const key of keys) {
      assert.notEqual(translate("en", key), translate("tr", key), `${key} must be translated`);
    }
  });
});

describe("the control's placement", () => {
  it("is offered only to someone who is in the voice channel", () => {
    // The server refuses a summon from outside the room, so offering the
    // control there would be a button that only ever produces an error. The
    // leading `viewedRoomId &&` matters: without it two nulls compare equal and
    // the panel renders for no room at all.
    assert.match(voiceRoom, /viewedRoomId && props\.activeVoiceRoomId === viewedRoomId \? \(\s*<MusicPanel/);
  });

  it("reads playback from the room snapshot rather than remembering a press", () => {
    assert.match(musicPanel, /const bot = musicBotIn\(members\);/);
    assert.match(musicPanel, /const state = musicPanelState\(bot\);/);
  });

  it("offers sending the bot away only once it is here", () => {
    assert.match(musicPanel, /\{bot \? \(/);
  });

  it("announces status changes to a screen reader", () => {
    assert.match(musicPanel, /aria-live="polite"/);
    assert.match(musicPanel, /aria-pressed=\{state === "playing"\}/);
  });
});
