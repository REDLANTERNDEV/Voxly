import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { MusicCommand, MusicControlAck, MusicQueueState, VoiceMemberState } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import {
  isSendableLink,
  musicBotIn,
  musicErrorKey,
  musicQueueFor,
  musicQueueRows,
  musicRestingKey,
  musicTransport,
  requestMusicCommand,
  trackAddedMessage,
  trackLength,
  transportToggleCommand
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

describe("what the transport controls are looking at", () => {
  const entry = (entryId: string) => ({
    entryId,
    requestedByUserId: "ada",
    track: { id: entryId, title: `Track ${entryId}`, durationSeconds: 60 }
  });
  const sounding: MusicQueueState = { playing: true, entries: [entry("a"), entry("b")] };
  const halted: MusicQueueState = { playing: false, entries: [entry("a")] };
  const mutedBot = { ...bot, moderation: { muted: true, deafened: false } };

  it("reads whether the music is playing from the Queue, not from the bot's speaking flag", () => {
    // The two can disagree — the server clamps `speaking` off for a muted
    // member, and they arrive in separate messages — and the Queue's own rows
    // already read the Queue. One fact, one publisher, one message.
    const talking = { ...bot, media: { ...bot.media, speaking: true } };

    assert.equal(musicTransport(talking, halted).playing, false, "a paused Queue is paused whatever the flag says");
    assert.equal(musicTransport(bot, sounding).playing, true, "and a playing one is playing");
  });

  it("names the entry Play, Pause and Skip act on", () => {
    assert.equal(musicTransport(bot, sounding).currentEntryId, "a", "the head, which is what a skip targets");
    assert.equal(musicTransport(bot, null).currentEntryId, null);
    assert.equal(musicTransport(bot, { playing: false, entries: [] }).currentEntryId, null);
  });

  it("never calls an empty Queue playing, whatever it was told", () => {
    // A Queue with nothing in it and `playing` true is not a state the bot
    // produces, and the panel must not offer Pause for it either way.
    assert.equal(musicTransport(bot, { playing: true, entries: [] }).playing, false);
  });

  it("says whether a bot is here at all", () => {
    assert.equal(musicTransport(bot, null).present, true);
    assert.equal(musicTransport(undefined, sounding).present, false);
  });

  it("keeps an owner's mute as information rather than as a button state", () => {
    // Media is peer-to-peer, so the mute does not by itself stop the bot's
    // packets and a member is owed that sentence. What the button offers still
    // comes from the Queue, which can now say whether there is anything to
    // pause — so a muted bot with music running still offers Pause.
    const transport = musicTransport(mutedBot, sounding);

    assert.equal(transport.muted, true);
    assert.equal(transport.playing, true);
    assert.equal(musicRestingKey(transport), "music.muted");
  });

  it("only mentions the mute while something is playing", () => {
    // The sentence tells the member to pause the bot, and Pause is offered only
    // for a Queue that is running. Saying it over a paused or empty Queue would
    // point at a control that is disabled or that says the opposite.
    assert.equal(musicRestingKey(musicTransport(mutedBot, halted)), "music.paused");
    assert.equal(musicRestingKey(musicTransport(mutedBot, null)), "music.idle");
    assert.match(translate("en", "music.muted"), /Pause/, "the sentence names the control it means");
  });

  it("says what the room is doing when nobody has just asked for anything", () => {
    assert.equal(musicRestingKey(musicTransport(bot, sounding)), "music.playing");
    assert.equal(musicRestingKey(musicTransport(bot, halted)), "music.paused");
    assert.equal(musicRestingKey(musicTransport(bot, null)), "music.idle");
    assert.equal(musicRestingKey(musicTransport(undefined, null)), "music.idle");
  });

  it("asks for the half of the toggle the member cannot see", () => {
    assert.deepEqual(transportToggleCommand(musicTransport(bot, sounding)), { kind: "stop" });
    assert.deepEqual(transportToggleCommand(musicTransport(bot, halted)), { kind: "play" });
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

  it("sends a skip and a removal with the entry they name", async () => {
    const { sent, socket } = socketDouble();

    await requestMusicCommand(socket, "lobby", { kind: "skip", entryId: "entry-1" });
    await requestMusicCommand(socket, "lobby", { kind: "remove", entryId: "entry-2" });

    assert.deepEqual(sent.map((entry) => entry.command), [
      { kind: "skip", entryId: "entry-1" },
      { kind: "remove", entryId: "entry-2" }
    ]);
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
      "music.pause",
      "music.skip",
      "music.remove",
      "music.removeTrack",
      "music.leave",
      "music.playing",
      "music.paused",
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

  it("reads playback from the published Queue rather than remembering a press", () => {
    assert.match(musicPanel, /const bot = musicBotIn\(members\);/);
    assert.match(musicPanel, /const transport = musicTransport\(bot, queue\);/);
    assert.doesNotMatch(musicPanel, /media\.speaking/, "the buttons and the rows read one fact, not two");
  });

  it("offers the transport controls only once the bot is here", () => {
    // Before that there is nothing to stop and nothing to resume, and a Play
    // button that did nothing would look exactly like a broken one. Read from
    // the same helper the rest of the controls read, so there is one answer to
    // "what are these looking at" rather than two that could part company.
    assert.match(musicPanel, /\{transport\.present \? \(/);
  });

  it("goes quiet when there is nothing queued to act on", () => {
    assert.match(musicPanel, /const transportDisabled = busy \|\| !transport\.currentEntryId;/);
    assert.match(musicPanel, /disabled=\{transportDisabled\}/);
  });

  it("catches the keyboard when the control a member pressed goes away", () => {
    // Skipping the last Track disables the button under the cursor and removing
    // a row unmounts it; either way the browser drops focus to the document and
    // a keyboard user is left at the top of the page. Only this client's own
    // press counts — pulling focus for somebody else's skip would be worse.
    assert.match(musicPanel, /droppedFocus\.current = command\.kind === "skip" \|\| command\.kind === "remove";/);
    assert.match(musicPanel, /if \(document\.activeElement === document\.body\) linkRef\.current\?\.focus\(\);/);
    assert.match(musicPanel, /\}, \[rows\.length\]\);/);
    assert.match(musicPanel, /ref=\{linkRef\}/);
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
    assert.match(musicPanel, /const resting = t\(musicRestingKey\(transport\)\);/);
  });

  it("labels the one toggle by what pressing it does, and not also by a state", () => {
    // "Pause, pressed" leaves a listener working out whether the music is
    // running or stopped — the one thing the label has already told them.
    assert.match(musicPanel, /\{transport\.playing \? t\("music\.pause"\) : t\("music\.play"\)\}/);
    assert.match(musicPanel, /onClick=\{\(\) => void send\(transportToggleCommand\(transport\)\)\}/);
    assert.doesNotMatch(musicPanel, /aria-pressed/);
  });

  it("skips by naming the entry it believes is playing", () => {
    // Not "skip whatever is at the head now": a panel one message out of date
    // must skip nothing rather than skip the Track that moved up into place.
    assert.match(musicPanel, /void send\(\{ kind: "skip", entryId: transport\.currentEntryId \}\);/);
    assert.match(musicPanel, /\{t\("music\.skip"\)\}/);
  });

  it("gives every row a remove control that names its own Track", () => {
    // A column of buttons all called "Remove" tells a screen-reader user
    // nothing about which Track they are about to lose.
    assert.match(musicPanel, /aria-label=\{t\("music\.removeTrack", \{ title: row\.title \}\)\}/);
    assert.match(musicPanel, /void send\(\{ kind: "remove", entryId: row\.entryId \}\)/);
    assert.match(musicPanel, /<button[^>]*\n?[\s\S]{0,300}?className="btn btn-ghost music-queue-remove"/);
    assert.match(musicPanel, /title=\{t\("music\.remove"\)\}/, "and a short one on hover, as the chat row controls do");
    assert.match(styles, /\.music-queue-remove \{[^}]*inline-size:/);
    // The global `button:disabled` already dims and re-cursors every button.
    assert.doesNotMatch(styles, /\.music-queue-remove:disabled/);
  });

  it("keeps every control a real button, so the keyboard reaches all of them", () => {
    // No div-with-onClick anywhere in the panel: `type="button"` on each one is
    // also what stops a control inside the link form submitting it.
    const buttons = musicPanel.match(/<button/g) ?? [];
    const typed = musicPanel.match(/type="(?:button|submit)"/g) ?? [];

    assert.equal(buttons.length, 5, "add, play/pause, skip, send away, and one per Queue row");
    assert.equal(typed.length, buttons.length);
    assert.doesNotMatch(musicPanel, /<(?:div|span|li)[^>]*onClick/);
  });
});
