import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  RtcSignal,
  VoiceForceLeaveReason,
  VoiceJoinAck,
  VoiceMediaState,
  VoiceSetMediaAck,
  VoiceSnapshot
} from "@voxly/shared";
import { TrackBuffer } from "../src/audio.js";
import { createMusicSet, musicBotMedia, type SetSocket } from "../src/set.js";

const roomId = "lobby";
const botUserId = "aaaa-bot";
const packets = [Buffer.from([1, 1]), Buffer.from([2, 2])];
const track = () => TrackBuffer.of(packets);

interface Recorder {
  socket: SetSocket;
  joins: Array<{ roomId: string; media: VoiceMediaState }>;
  leaves: string[];
  mediaUpdates: Array<Partial<VoiceMediaState>>;
  snapshotHandlers: number;
  publish: (snapshot: VoiceSnapshot) => void;
}

function recordingSocket(joinAck: VoiceJoinAck = okJoin()): Recorder {
  const joins: Array<{ roomId: string; media: VoiceMediaState }> = [];
  const leaves: string[] = [];
  const mediaUpdates: Array<Partial<VoiceMediaState>> = [];
  const snapshotHandlers = new Set<(snapshot: VoiceSnapshot) => void>();
  const signalHandlers = new Set<(payload: { roomId: string; fromUserId: string; signal: RtcSignal }) => void>();
  const forceLeaveHandlers = new Set<(payload: { roomId: string; reason: VoiceForceLeaveReason }) => void>();

  const recorder: Recorder = {
    joins,
    leaves,
    mediaUpdates,
    get snapshotHandlers() {
      return snapshotHandlers.size;
    },
    publish(snapshot) {
      for (const handler of snapshotHandlers) handler(snapshot);
    },
    socket: {
      join(payload, ack) {
        joins.push(payload);
        ack(joinAck);
      },
      leave(id) {
        leaves.push(id);
      },
      setMediaState(payload, ack) {
        mediaUpdates.push(payload.media);
        ack({ ok: true, state: memberState() } satisfies VoiceSetMediaAck);
      },
      onSnapshot(handler) {
        snapshotHandlers.add(handler);
      },
      offSnapshot(handler) {
        snapshotHandlers.delete(handler);
      },
      onForceLeave(handler) {
        forceLeaveHandlers.add(handler);
      },
      offForceLeave(handler) {
        forceLeaveHandlers.delete(handler);
      },
      emit() {
        // Signalling is exercised against real peer connections in mesh.test.ts.
      },
      on(handler) {
        signalHandlers.add(handler);
      },
      off(handler) {
        signalHandlers.delete(handler);
      }
    }
  };
  return recorder;
}

function memberState() {
  return {
    user: { userId: botUserId, nickname: "Music", role: "member" as const, isBot: true },
    media: musicBotMedia,
    moderation: { muted: false, deafened: false }
  };
}

function okJoin(): VoiceJoinAck {
  return { ok: true, state: memberState() };
}

function newSet(recorder: Recorder, onListenersChanged?: (listenerUserIds: string[]) => void) {
  return createMusicSet({
    socket: recorder.socket,
    roomId,
    selfUserId: botUserId,
    iceServers: [],
    onListenersChanged
  });
}

function snapshotOf(userIds: string[], speaking = false): VoiceSnapshot {
  return {
    roomId,
    members: userIds.map((userId) => ({
      user: { userId, nickname: userId, role: "member" as const },
      media: { mic: true, camera: false, screen: false, deafened: false, speaking },
      moderation: { muted: false, deafened: false }
    }))
  };
}

/**
 * The room as the server describes it once the bot's microphone has been taken
 * away. `mic` is the server's *conclusion*: `normalizeVoiceMedia` is where an
 * owner's mute and the AFK room's forced mute both end up, and the moderation
 * flag beside it is only the first of those two reasons.
 */
function snapshotWithBotMic(mic: boolean, moderationMuted = !mic): VoiceSnapshot {
  const snapshot = snapshotOf([botUserId, "ada"]);
  return {
    ...snapshot,
    members: snapshot.members.map((member) => member.user.userId === botUserId
      ? { ...member, media: { ...member.media, mic }, moderation: { muted: moderationMuted, deafened: false } }
      : member)
  };
}

describe("joining a voice room", () => {
  it("arrives with the microphone on and hearing nobody", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);

    await set.begin();

    assert.deepEqual(recorder.joins, [{ roomId, media: musicBotMedia }]);
    // Both matter: the server clamps `speaking` off for a member whose
    // microphone is off, and `deafened` would clamp the microphone in turn.
    assert.equal(musicBotMedia.mic, true);
    assert.equal(musicBotMedia.deafened, false);
    await set.end();
  });

  it("listens for the room's snapshot before joining, not after", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    let handlersAtJoin = 0;
    const original = recorder.socket.join;
    recorder.socket.join = (payload, ack) => {
      handlersAtJoin = recorder.snapshotHandlers;
      original(payload, ack);
    };

    await set.begin();

    assert.equal(handlersAtJoin, 1, "the snapshot the join publishes must not be missed");
    await set.end();
  });

  it("reports a refused join and leaves nothing attached", async () => {
    const recorder = recordingSocket({ ok: false, error: "forbidden" });
    const set = newSet(recorder);

    await assert.rejects(set.begin(), /forbidden/);

    assert.equal(recorder.snapshotHandlers, 0);
    assert.deepEqual(recorder.leaves, [], "a bot that never joined has nothing to leave");
    assert.deepEqual(recorder.mediaUpdates, [], "nor anything to report about itself");
  });
});

describe("the speaking indicator", () => {
  it("lights while the Track plays and clears when it stops", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();

    set.loadTrack(track());
    set.play();
    set.stop();

    assert.deepEqual(recorder.mediaUpdates, [{ speaking: true }, { speaking: false }]);
    await set.end();
  });

  it("clears before the bot leaves, so the room's last word is not that it was playing", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    set.loadTrack(track());
    set.play();

    await set.end();

    assert.deepEqual(recorder.mediaUpdates, [{ speaking: true }, { speaking: false }]);
    assert.deepEqual(recorder.leaves, [roomId]);
  });

  it("says nothing at all when the Set never played", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();

    await set.end();

    assert.deepEqual(recorder.mediaUpdates, []);
  });

  it("stays dark when there is no Track to play", async () => {
    // A Summon that resolved nothing must not light the bot's row in the room.
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();

    set.play();

    assert.deepEqual(recorder.mediaUpdates, []);
    await set.end();
  });
});

describe("who is in the room", () => {
  it("reports every arrival and every departure", async () => {
    let reported = 0;
    const recorder = recordingSocket();
    const set = newSet(recorder, () => { reported += 1; });
    await set.begin();

    recorder.publish(snapshotOf([botUserId, "ada"]));
    recorder.publish(snapshotOf([botUserId, "ada", "bob"]));
    recorder.publish(snapshotOf([botUserId, "bob"]));

    assert.equal(reported, 3);
    await set.end();
  });

  it("says nothing when a snapshot only reports somebody talking", async () => {
    // A snapshot lands on every media change, and whoever is listening for this
    // wants the roster. Republishing the Queue on every speaking flicker would
    // be a broadcast per syllable.
    let reported = 0;
    const recorder = recordingSocket();
    const set = newSet(recorder, () => { reported += 1; });
    await set.begin();

    recorder.publish(snapshotOf([botUserId, "ada"]));
    recorder.publish(snapshotOf([botUserId, "ada"], true));
    recorder.publish(snapshotOf(["ada", botUserId]));

    assert.equal(reported, 1, "the same people talking, or listed in another order, are the same people");
    await set.end();
  });

  it("ignores another room's snapshot", async () => {
    let reported = 0;
    const recorder = recordingSocket();
    const set = newSet(recorder, () => { reported += 1; });
    await set.begin();

    recorder.publish({ ...snapshotOf([botUserId, "ada"]), roomId: "studio" });

    assert.equal(reported, 0);
    await set.end();
  });
});

describe("ending a Set", () => {
  it("stops listening to the room and leaves exactly once", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();

    await set.end();
    await set.end();

    assert.equal(recorder.snapshotHandlers, 0);
    assert.deepEqual(recorder.leaves, [roomId]);
  });

  it("ignores a snapshot that arrives after it ended", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    await set.end();

    recorder.publish({
      roomId,
      members: [{
        user: { userId: "ada", nickname: "Ada", role: "member" },
        media: { mic: true, camera: false, screen: false, deafened: false, speaking: false },
        moderation: { muted: false, deafened: false }
      }]
    });

    assert.deepEqual(set.listenerUserIds, []);
  });
});

describe("who the Listeners are", () => {
  it("reports the room's Listeners, which never include the bot itself", async () => {
    // The bot is in its own roster — it is an ordinary member of the voice room
    // — so a hook that handed the roster straight through would report a
    // Listener for an empty room forever.
    const reported: string[][] = [];
    const recorder = recordingSocket();
    const set = newSet(recorder, (listenerUserIds) => reported.push(listenerUserIds));
    await set.begin();

    recorder.publish(snapshotOf([botUserId, "ada", "bob"]));

    assert.deepEqual(reported, [["ada", "bob"]]);
    await set.end();
  });

  it("reports nobody at all for a room holding only the bot", async () => {
    const reported: string[][] = [];
    const recorder = recordingSocket();
    const set = newSet(recorder, (listenerUserIds) => reported.push(listenerUserIds));
    await set.begin();

    recorder.publish(snapshotOf([botUserId, "ada"]));
    recorder.publish(snapshotOf([botUserId]));

    assert.deepEqual(reported, [["ada"], []], "the last Listener leaving is a room with only the bot in it");
    await set.end();
  });
});

/**
 * Media is peer-to-peer, so the server cannot stop packets it never sees: its
 * moderation state is advisory for audio and the bot has to honour it itself.
 * The ticket 03 spike watched a bot the server had marked muted keep playing
 * into a browser, which is what this is here to prevent.
 *
 * What is read is the server's *conclusion* rather than its reasons. `mic` on
 * the bot's own member state is where `normalizeVoiceMedia` records both an
 * owner's mute and the AFK room's forced mute, and the AFK room is not on the
 * snapshot at all — so the microphone is the only fact that says both.
 */
describe("enforcing its own silence", () => {
  it("stops sending when the server says its microphone is off", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    set.loadTrack(track());
    set.play();

    recorder.publish(snapshotWithBotMic(false));

    assert.equal(set.playing, false);
    assert.deepEqual(recorder.mediaUpdates, [{ speaking: true }, { speaking: false }]);
    await set.end();
  });

  it("carries on from where it stopped when the microphone comes back", async () => {
    // An owner unmuting the bot is not a member pressing Play, so nothing is
    // restarted: what the Queue asked for is what resumes.
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    set.loadTrack(track());
    set.play();
    recorder.publish(snapshotWithBotMic(false));

    recorder.publish(snapshotWithBotMic(true));

    assert.equal(set.playing, true);
    await set.end();
  });

  it("will not play at all while the microphone is off", async () => {
    // The Queue does not know about the mute and will go on advancing through
    // Tracks. Every one of them has to be silent, not just the one that was
    // playing when the mute landed.
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    recorder.publish(snapshotWithBotMic(false));

    set.loadTrack(track());
    set.play();

    assert.equal(set.playing, false);
    assert.deepEqual(recorder.mediaUpdates, [], "and it never claimed to be speaking");
    await set.end();
  });

  it("does not start music a member had paused when the mute is lifted", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    set.loadTrack(track());
    set.play();
    set.stop();
    recorder.publish(snapshotWithBotMic(false));

    recorder.publish(snapshotWithBotMic(true));

    assert.equal(set.playing, false);
    await set.end();
  });

  it("is silent in the AFK room, whose mute names nobody", async () => {
    // The AFK room mutes everyone in it, the bot included, and it is a property
    // of the room rather than of the member — so the moderation flag stays
    // clear and only the microphone says so. That the AFK room really does
    // arrive as a microphone and not as a flag is asserted where it is decided,
    // in the server's `realtime.test.ts`; this is the bot's half of it.
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    set.loadTrack(track());
    set.play();

    recorder.publish(snapshotWithBotMic(false, false));

    assert.equal(set.playing, false);
    await set.end();
  });

  it("says nothing about a snapshot it is not in", async () => {
    // A room the bot has not joined has no microphone of the bot's to describe,
    // and reading an absent member as a muted one would silence a Set that
    // nobody moderated.
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    set.loadTrack(track());
    set.play();

    recorder.publish(snapshotOf(["ada", "bob"]));

    assert.equal(set.playing, true);
    await set.end();
  });
});
