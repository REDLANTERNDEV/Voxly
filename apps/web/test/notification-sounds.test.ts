import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import {
  advanceVoiceRoster,
  clampNotificationVolume,
  DEFAULT_NOTIFICATION_SOUNDS,
  EMPTY_VOICE_ROSTER,
  notificationSoundAllowed,
  notificationSoundCategories,
  notificationSoundSources,
  notificationSoundStorageKey,
  readNotificationSounds,
  shouldPlayMessageSound,
  voiceRosterTransitions,
  writeNotificationSounds,
  type NotificationSoundKey,
  type NotificationSoundPreferences
} from "../src/lib/notificationSounds.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
  };
}

function preferences(patch: Partial<NotificationSoundPreferences> = {}): NotificationSoundPreferences {
  return { ...DEFAULT_NOTIFICATION_SOUNDS, ...patch };
}

describe("notification sound catalogue", () => {
  it("ships an asset for every cue the client can play", () => {
    for (const [key, source] of Object.entries(notificationSoundSources)) {
      assert.match(source, /^\/sounds\/[a-z-]+\.wav$/, `${key} must resolve to a public sound file`);
      assert.equal(existsSync(`public${source}`), true, `${source} must exist`);
    }
  });

  it("assigns every cue to exactly one preference category", () => {
    const keys = Object.keys(notificationSoundSources) as NotificationSoundKey[];
    assert.deepEqual(keys.sort(), (Object.keys(notificationSoundCategories) as NotificationSoundKey[]).sort());
  });
});

describe("notification sound preferences", () => {
  it("persists preferences independently per user", () => {
    const storage = memoryStorage();

    writeNotificationSounds("user-a", preferences({ enabled: false, volume: 40 }), storage);
    writeNotificationSounds("user-b", preferences({ message: false }), storage);

    assert.equal(notificationSoundStorageKey("user-a"), "voxly:notification-sounds:v1:user-a");
    assert.equal(readNotificationSounds("user-a", storage).enabled, false);
    assert.equal(readNotificationSounds("user-a", storage).volume, 40);
    assert.equal(readNotificationSounds("user-b", storage).message, false);
    assert.deepEqual(readNotificationSounds("user-c", storage), DEFAULT_NOTIFICATION_SOUNDS);
  });

  it("keeps the notification level within the slider range", () => {
    const storage = memoryStorage();
    storage.setItem(notificationSoundStorageKey("loud"), JSON.stringify({ ...DEFAULT_NOTIFICATION_SOUNDS, volume: 400 }));

    assert.equal(clampNotificationVolume(400), 100);
    assert.equal(clampNotificationVolume(-20), 0);
    assert.equal(readNotificationSounds("loud", storage).volume, 100);
  });

  it("falls back per field for malformed or partial values", () => {
    const storage = memoryStorage();
    storage.setItem(notificationSoundStorageKey("broken"), "not json");
    storage.setItem(notificationSoundStorageKey("partial"), JSON.stringify({ voice: false, volume: "loud" }));

    assert.deepEqual(readNotificationSounds("broken", storage), DEFAULT_NOTIFICATION_SOUNDS);
    assert.equal(readNotificationSounds("partial", storage).voice, false);
    assert.equal(readNotificationSounds("partial", storage).volume, DEFAULT_NOTIFICATION_SOUNDS.volume);
    assert.equal(readNotificationSounds("partial", storage).message, true);
  });

  it("reads and writes safely when storage is unavailable", () => {
    assert.deepEqual(readNotificationSounds("user-a", undefined), DEFAULT_NOTIFICATION_SOUNDS);
    assert.doesNotThrow(() => writeNotificationSounds("user-a", DEFAULT_NOTIFICATION_SOUNDS, undefined));
  });
});

describe("notification sound gating", () => {
  it("respects the master switch and the category switches", () => {
    assert.equal(notificationSoundAllowed("message", preferences({ enabled: false }), { deafened: false }), false);
    assert.equal(notificationSoundAllowed("message", preferences({ message: false }), { deafened: false }), false);
    assert.equal(notificationSoundAllowed("voicePeerJoin", preferences({ voice: false }), { deafened: false }), false);
    assert.equal(notificationSoundAllowed("connectionLost", preferences({ connection: false }), { deafened: false }), false);
    assert.equal(notificationSoundAllowed("message", preferences(), { deafened: false }), true);
  });

  it("stays silent while deafened except for the deafen cues themselves", () => {
    assert.equal(notificationSoundAllowed("voicePeerJoin", preferences(), { deafened: true }), false);
    assert.equal(notificationSoundAllowed("message", preferences(), { deafened: true }), false);
    assert.equal(notificationSoundAllowed("connectionLost", preferences(), { deafened: true }), false);
    assert.equal(notificationSoundAllowed("deafen", preferences(), { deafened: true }), true);
    assert.equal(notificationSoundAllowed("undeafen", preferences(), { deafened: true }), true);
  });
});

describe("message cue rule", () => {
  const context = { currentUserId: "me", activeTextRoomId: "general", windowFocused: true };

  it("never announces the listener's own message", () => {
    assert.equal(shouldPlayMessageSound({ roomId: "random", userId: "me" }, context), false);
  });

  it("stays silent for the room already on screen and focused", () => {
    assert.equal(shouldPlayMessageSound({ roomId: "general", userId: "ada" }, context), false);
  });

  it("announces other rooms and messages arriving while the window is away", () => {
    assert.equal(shouldPlayMessageSound({ roomId: "random", userId: "ada" }, context), true);
    assert.equal(shouldPlayMessageSound({ roomId: "general", userId: "ada" }, { ...context, windowFocused: false }), true);
    assert.equal(shouldPlayMessageSound({ roomId: "general", userId: "ada" }, { ...context, activeTextRoomId: null }), true);
  });
});

describe("voice roster transitions", () => {
  it("reports arrivals and departures", () => {
    assert.deepEqual(voiceRosterTransitions(["ada", "lin"], ["lin", "kai"]), { joined: ["kai"], left: ["ada"] });
    assert.deepEqual(voiceRosterTransitions(["ada"], ["ada"]), { joined: [], left: [] });
  });

  it("treats the first snapshot of a room as a baseline", () => {
    const joinedRoom = advanceVoiceRoster(EMPTY_VOICE_ROSTER, { roomId: "voice-1", userIds: null });
    assert.deepEqual(joinedRoom.joined, []);
    assert.equal(joinedRoom.state.seeded, false);

    const firstSnapshot = advanceVoiceRoster(joinedRoom.state, { roomId: "voice-1", userIds: ["ada", "lin"] });
    assert.deepEqual(firstSnapshot.joined, [], "the participants already present must not be announced");
    assert.equal(firstSnapshot.state.seeded, true);

    const arrival = advanceVoiceRoster(firstSnapshot.state, { roomId: "voice-1", userIds: ["ada", "lin", "kai"] });
    assert.deepEqual(arrival.joined, ["kai"]);
    assert.deepEqual(arrival.left, []);
  });

  it("re-seeds on a room move and on leaving", () => {
    const seeded = { roomId: "voice-1", seeded: true, userIds: ["ada"] };

    const moved = advanceVoiceRoster(seeded, { roomId: "voice-2", userIds: ["lin", "kai"] });
    assert.deepEqual(moved.joined, []);
    assert.deepEqual(moved.left, []);

    const leftRoom = advanceVoiceRoster(seeded, { roomId: null, userIds: null });
    assert.deepEqual(leftRoom.left, [], "leaving is announced by the self cue, not by every remaining participant");
    assert.equal(leftRoom.state.seeded, false);
  });
});
