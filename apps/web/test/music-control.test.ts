import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { MusicCommand, MusicControlAck, VoiceMemberState } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import {
  isSendableLink,
  musicBotIn,
  musicErrorKey,
  musicPanelState,
  offersStop,
  requestMusicCommand,
  trackAddedMessage,
  trackLength
} from "../src/lib/musicBot.js";

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
  const track = { id: "aB3dE5gH7jK", title: "Nocturne in E-flat major", durationSeconds: 273 };

  function socketDouble(answer: MusicControlAck = { ok: true, track: null }) {
    const sent: Array<{ roomId: string; command: MusicCommand }> = [];
    return {
      sent,
      socket: {
        emit(_event: "music:control", payload: { roomId: string; command: MusicCommand }, ack: (response: MusicControlAck) => void) {
          sent.push(payload);
          ack(answer);
        }
      }
    };
  }

  it("sends the pasted link for the named room and resolves with the Track", async () => {
    const { sent, socket } = socketDouble({ ok: true, track });
    const command = { kind: "add", url: "https://youtu.be/aB3dE5gH7jK" } as const;

    const response = await requestMusicCommand(socket, "lobby", command);

    assert.deepEqual(sent, [{ roomId: "lobby", command }]);
    assert.deepEqual(response, { ok: true, track });
  });

  it("sends the commands that carry no link the same way", async () => {
    const { sent, socket } = socketDouble();

    for (const kind of ["play", "stop", "leave"] as const) {
      assert.deepEqual(await requestMusicCommand(socket, "lobby", { kind }), { ok: true, track: null });
    }
    assert.deepEqual(sent.map((entry) => entry.command.kind), ["play", "stop", "leave"]);
  });

  it("answers without a round trip when there is no socket or no room", async () => {
    assert.deepEqual(
      await requestMusicCommand(null, "lobby", { kind: "play" }),
      { ok: false, error: "not_in_voice_room" }
    );
    assert.deepEqual(
      await requestMusicCommand({ emit: () => assert.fail("must not emit") }, null, { kind: "play" }),
      { ok: false, error: "not_in_voice_room" }
    );
  });

  it("does not send a link that is only whitespace", () => {
    // The browser holds no opinion about which links are playable — that is the
    // bot's knowledge and a second copy of it here would be the one that drifts.
    // "Is there anything here at all" is the whole check.
    assert.equal(isSendableLink(""), false);
    assert.equal(isSendableLink("   \n "), false);
    assert.equal(isSendableLink("https://youtu.be/aB3dE5gH7jK"), true);
    assert.equal(isSendableLink("probably not a link"), true, "the bot gets to answer that one");
  });
});

describe("naming the Track that started", () => {
  it("writes a length the way a person reads one", () => {
    assert.equal(trackLength(273), "4:33");
    assert.equal(trackLength(9), "0:09");
    assert.equal(trackLength(600), "10:00");
    assert.equal(trackLength(3_851), "1:04:11", "an hour-long mix does not read as 64 minutes");
    assert.equal(trackLength(0), "0:00");
  });

  it("says what is playing, in both languages", () => {
    const track = { id: "aB3dE5gH7jK", title: "Nocturne in E-flat major", durationSeconds: 273 };
    const english = trackAddedMessage(track, (key, values) => translate("en", key, values));
    const turkish = trackAddedMessage(track, (key, values) => translate("tr", key, values));

    for (const message of [english, turkish]) {
      assert.match(message, /Nocturne in E-flat major/, "the title is not translated, and must survive");
      assert.match(message, /4:33/);
    }
    assert.notEqual(english, turkish);
  });
});

describe("what a refusal says", () => {
  it("gives every refusal its own sentence, in both languages", () => {
    const errors = [
      "bot_offline",
      "no_music_bot",
      "afk_room",
      "not_in_voice_room",
      "room_not_found",
      "unsupported_link",
      "track_unavailable",
      "live_stream",
      "extractor_failed",
      "bot_timeout",
      "bot_failed"
    ] as const;
    const english = errors.map((error) => translate("en", musicErrorKey(error)));
    const turkish = errors.map((error) => translate("tr", musicErrorKey(error)));

    assert.equal(new Set(english).size, errors.length, "no two refusals may read the same");
    assert.equal(new Set(turkish).size, errors.length);
    for (const [index, message] of english.entries()) {
      assert.notEqual(message, turkish[index], `${errors[index]} must actually be translated`);
    }
  });

  it("translates the controls themselves in both languages", () => {
    const keys = [
      "music.title",
      "music.copy",
      "music.linkLabel",
      "music.linkPlaceholder",
      "music.add",
      "music.play",
      "music.stop",
      "music.leave",
      "music.playing",
      "music.idle",
      "music.muted",
      "music.summoning"
    ] as const;
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

  it("offers the transport controls only once the bot is here", () => {
    // Before that there is nothing to stop and nothing to resume, and a Play
    // button that did nothing would look exactly like a broken one.
    assert.match(musicPanel, /\{bot \? \(/);
  });

  it("takes the link through a form, so Enter submits it", () => {
    assert.match(musicPanel, /<form\s+className="music-panel-link"/);
    assert.match(musicPanel, /type="submit"/);
    assert.match(musicPanel, /event\.preventDefault\(\);/);
  });

  it("labels the link field and refuses to send an empty one", () => {
    assert.match(musicPanel, /aria-label=\{t\("music\.linkLabel"\)\}/);
    assert.match(musicPanel, /disabled=\{busy \|\| !isSendableLink\(link\)\}/);
  });

  it("keeps a refused link in the field rather than making it be retyped", () => {
    assert.match(musicPanel, /if \(command\.kind === "add"\) setLink\(""\);/);
  });

  it("announces status changes to a screen reader", () => {
    assert.match(musicPanel, /aria-live="polite"/);
    assert.match(musicPanel, /aria-pressed=\{state === "playing"\}/);
  });
});
