import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { MusicCommand, MusicControlAck, MusicQueueState, VoiceMemberState } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import {
  isSendableLink,
  musicBotIn,
  musicErrorKey,
  musicPanelState,
  musicQueueFor,
  musicQueueRows,
  offersStop,
  requestMusicCommand,
  trackAddedMessage,
  trackLength
} from "../src/lib/musicBot.js";

const musicPanel = readFileSync("src/features/voice/MusicPanel.tsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");
const queueHook = readFileSync("src/lib/useMusicQueue.ts", "utf8");
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

  it("confirms what was added, in both languages", () => {
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
      "queue_full",
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
      "music.summoning",
      "music.queue",
      "music.queueEmpty",
      "music.nowPlaying",
      "music.pausedTrack",
      "music.upNext",
      "music.queuePosition",
      "music.requestedBy",
      "music.queued",
      "music.requesterUnknown"
    ] as const;
    for (const key of keys) {
      assert.notEqual(translate("en", key), translate("tr", key), `${key} must be translated`);
    }
  });
});

describe("the Queue as the panel reads it", () => {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate("en", key, values);
  const ada = member("ada", { user: { userId: "ada", nickname: "Ada", role: "member" } });
  const ece = member("ece", { user: { userId: "ece", nickname: "Ece", role: "member" } });

  function queueOf(entries: Array<[string, string, number, string]>, playing = true): MusicQueueState {
    return {
      playing,
      entries: entries.map(([entryId, title, durationSeconds, requestedByUserId]) => ({
        entryId,
        requestedByUserId,
        track: { id: entryId, title, durationSeconds }
      }))
    };
  }

  it("marks the first Track as the one playing and numbers the rest", () => {
    const rows = musicQueueRows(
      queueOf([["a", "Nocturne", 273, "ada"], ["b", "Gymnopédie", 195, "ece"]]),
      [ada, ece],
      t
    );

    assert.deepEqual(rows.map((row) => row.isCurrent), [true, false]);
    assert.deepEqual(rows.map((row) => row.position), [1, 2]);
  });

  it("says the head of a paused Queue is paused, not playing", () => {
    // `playing` is on the published Queue for this. Without reading it the
    // panel would announce a Track as playing into a silent room.
    const paused = queueOf([["a", "One", 60, "ada"], ["b", "Two", 60, "ada"]], false);

    const rows = musicQueueRows(paused, [ada], t);

    assert.equal(rows[0].positionLabel, translate("en", "music.pausedTrack"));
    assert.equal(rows[0].isCurrent, true, "it is still the Track the Queue is on");
    assert.equal(rows[1].positionLabel, translate("en", "music.upNext"));
  });

  it("says where each Track is in words, not only in styling", () => {
    const rows = musicQueueRows(
      queueOf([["a", "One", 60, "ada"], ["b", "Two", 60, "ada"], ["c", "Three", 60, "ada"]]),
      [ada],
      t
    );

    assert.deepEqual(rows.map((row) => row.positionLabel), [
      translate("en", "music.nowPlaying"),
      translate("en", "music.upNext"),
      translate("en", "music.queuePosition", { position: 3 })
    ]);
    assert.equal(new Set(rows.map((row) => row.positionLabel)).size, 3);
  });

  it("shows each entry's Requester and its length", () => {
    const rows = musicQueueRows(
      queueOf([["a", "Nocturne", 273, "ada"], ["b", "Gymnopédie", 3_851, "ece"]]),
      [ada, ece],
      t
    );

    assert.deepEqual(rows.map((row) => row.requester), ["Ada", "Ece"]);
    assert.deepEqual(rows.map((row) => row.length), ["4:33", "1:04:11"]);
  });

  it("resolves the Requester's current nickname rather than one copied onto the wire", () => {
    // The bot publishes ids. A nickname the bot had copied at the moment of
    // queueing would be the one that went stale when somebody renamed
    // themselves; resolving here means the Queue follows the rename.
    const renamed = member("ada", { user: { userId: "ada", nickname: "Ada Lovelace", role: "member" } });

    const [row] = musicQueueRows(queueOf([["a", "Nocturne", 273, "ada"]]), [renamed], t);

    assert.equal(row.requester, "Ada Lovelace");
  });

  it("names a Requester who has left rather than showing their id", () => {
    const [row] = musicQueueRows(queueOf([["a", "Nocturne", 273, "ada"]]), [ece], t);

    assert.equal(row.requester, translate("en", "music.requesterUnknown"));
    assert.doesNotMatch(row.requester, /ada/, "an id is true and useless to everyone reading it");
  });

  it("keeps two additions of the same Track apart", () => {
    const rows = musicQueueRows(
      queueOf([["first", "Nocturne", 273, "ada"], ["second", "Nocturne", 273, "ece"]]),
      [ada, ece],
      t
    );

    assert.equal(new Set(rows.map((row) => row.entryId)).size, 2, "each row has its own key");
    assert.deepEqual(rows.map((row) => row.requester), ["Ada", "Ece"]);
  });

  it("has no rows at all when the bot has published nothing", () => {
    assert.deepEqual(musicQueueRows(null, [ada], t), []);
  });

  it("shows the room's own Queue and never another room's", () => {
    const queues = { lobby: queueOf([["a", "Nocturne", 273, "ada"]]), studio: queueOf([["b", "Etude", 100, "ece"]]) };

    assert.deepEqual(musicQueueFor(queues, "lobby", bot)?.entries.map((entry) => entry.track.title), ["Nocturne"]);
    assert.deepEqual(musicQueueFor(queues, "studio", bot)?.entries.map((entry) => entry.track.title), ["Etude"]);
    assert.equal(musicQueueFor(queues, "green-room", bot), null);
  });

  it("forgets the Queue once the bot has left the channel", () => {
    // The bot owns the Queue. A list left over from a Set that ended is a list
    // of Tracks nobody is going to hear.
    const queues = { lobby: queueOf([["a", "Nocturne", 273, "ada"]]) };

    assert.equal(musicQueueFor(queues, "lobby", undefined), null);
    assert.equal(musicQueueFor(queues, null, bot), null);
  });
});

describe("the Queue on the page", () => {
  it("renders the Queue the bot published rather than anything it remembered", () => {
    assert.match(musicPanel, /const queue = musicQueueFor\(queues, roomId, bot\);/);
    assert.match(musicPanel, /const rows = musicQueueRows\(queue, members, t\);/);
    assert.doesNotMatch(musicPanel, /useState<MusicTrackSummary/, "no locally remembered Track survives");
  });

  it("tells the playing Track apart by words as well as by colour", () => {
    assert.match(musicPanel, /<span className="music-queue-position">\{row\.positionLabel\}<\/span>/);
    assert.match(musicPanel, /className=\{`music-queue-row \$\{row\.isCurrent \? "is-current" : ""\}`\}/);
    assert.match(styles, /\.music-queue-row\.is-current \{[^}]*border-color:/);
  });

  it("gives the Queue a role, so the heading labelling it is not dropped", () => {
    // `aria-labelledby` on a plain div names nothing: without a role there is
    // no region for the heading to be the name of.
    assert.match(musicPanel, /<section className="music-queue" aria-labelledby="musicQueueTitle">/);
    assert.match(musicPanel, /<p className="label" id="musicQueueTitle">\{t\("music\.queue"\)\}<\/p>/);
  });

  it("gives every row its Requester and its length", () => {
    assert.match(musicPanel, /t\("music\.requestedBy", \{ nickname: row\.requester \}\)/);
    assert.match(musicPanel, /className="music-queue-length">\{row\.length\}/);
  });

  it("takes the Queue whole rather than merging what it was told before", () => {
    // A room where two members disagree about what is coming next is the
    // failure the published Queue exists to prevent, and a merged delta is
    // exactly how that happens.
    assert.match(queueHook, /setQueues\(\(current\) => \(\{ \.\.\.current, \[roomId\]: state \}\)\);/);
    assert.doesNotMatch(queueHook, /entries: \[/, "nothing here builds a Queue of its own");
  });

  it("starts a new connection with no Queue it has not been told", () => {
    assert.match(queueHook, /setQueues\(\{\}\);\s*\n\s*if \(!socket\) return;/);
  });

  it("sits after the participant list, in the page's own flow", () => {
    const voiceRoomFlow = voiceRoom.slice(voiceRoom.indexOf('className="voice-participants"'));

    assert.match(voiceRoomFlow, /<MusicPanel/, "the panel comes after the participants, not before them");
    assert.doesNotMatch(styles, /\.music-panel\s*\{[^}]*position:\s*(?:fixed|absolute|sticky)/);
  });

  it("introduces no scroll region of its own, so the stage is never squeezed", () => {
    // The call surface is the sole scroll owner. A Queue with its own scrollbar
    // would also be a fixed-height block the screen-share stage has to shrink
    // to make room for, which is the one thing the panel must not do.
    for (const selector of ["music-panel", "music-queue", "music-queue-list"]) {
      const rule = styles.match(new RegExp(`\\.${selector}\\s*\\{[^}]+\\}`))?.[0];
      // Found, not merely absent: a rule this test cannot see is a rule it
      // cannot hold, and a renamed class would pass silently.
      assert.ok(rule, `${selector} must have a rule for this to be asserting anything`);
      assert.doesNotMatch(rule, /overflow(?:-y|-block)?:\s*(?:auto|scroll)/, selector);
      assert.doesNotMatch(rule, /(?:max-)?(?:block-size|height):/, selector);
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
