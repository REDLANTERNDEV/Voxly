import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  createNotificationSoundPlayer,
  NOTIFICATION_SOUND_REPLAY_MS,
  type NotificationSoundElement
} from "../src/lib/notificationSoundPlayer.js";
import { notificationSoundSources } from "../src/lib/notificationSounds.js";

function fakeElement(onPlay: () => unknown = () => undefined) {
  const element = {
    volume: 1,
    currentTime: 5,
    plays: 0,
    play() {
      element.plays += 1;
      return onPlay();
    }
  };
  return element;
}

function harness(options: { onPlay?: () => unknown; applyOutputDevice?: () => Promise<unknown> } = {}) {
  const created: string[] = [];
  const elements: ReturnType<typeof fakeElement>[] = [];
  const outputApplications: NotificationSoundElement[] = [];
  let clock = 0;
  const player = createNotificationSoundPlayer({
    createElement(source) {
      created.push(source);
      const element = fakeElement(options.onPlay);
      elements.push(element);
      return element;
    },
    applyOutputDevice(element) {
      outputApplications.push(element);
      return options.applyOutputDevice?.() ?? Promise.resolve("ok");
    },
    now: () => clock
  });
  return { player, created, elements, outputApplications, advance: (ms: number) => { clock += ms; } };
}

describe("notification sound player", () => {
  it("loads one element per cue and reuses it", async () => {
    const { player, created, elements, advance } = harness();

    player.play("message", 100);
    advance(NOTIFICATION_SOUND_REPLAY_MS);
    player.play("message", 100);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(created, [notificationSoundSources.message]);
    assert.equal(elements.length, 1);
    assert.equal(elements[0].plays, 2);
    assert.equal(elements[0].currentTime, 0, "a repeat restarts the cue from the beginning");
  });

  it("drops a repeat that lands inside the replay window", () => {
    const { player, advance } = harness();

    assert.equal(player.play("voicePeerJoin", 100), true);
    advance(NOTIFICATION_SOUND_REPLAY_MS - 1);
    assert.equal(player.play("voicePeerJoin", 100), false, "a burst of arrivals must not stutter");
    advance(1);
    assert.equal(player.play("voicePeerJoin", 100), true);
  });

  it("keeps cues independent of each other in the replay window", () => {
    const { player } = harness();

    assert.equal(player.play("voicePeerJoin", 100), true);
    assert.equal(player.play("voicePeerLeave", 100), true);
  });

  it("scales the element volume and never exceeds the element maximum", () => {
    const { player, elements, advance } = harness();

    player.play("message", 50);
    advance(NOTIFICATION_SOUND_REPLAY_MS);
    assert.equal(elements[0].volume, 0.5);

    player.play("message", 400);
    assert.equal(elements[0].volume, 1);
  });

  it("applies the selected output device before playing", async () => {
    const { player, outputApplications, elements } = harness();

    player.play("message", 100);
    assert.equal(outputApplications.length, 1);
    assert.equal(elements[0].plays, 0, "playback waits for the output device");

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(elements[0].plays, 1);
  });

  it("stays silent instead of failing when playback is refused", async () => {
    const { player, elements } = harness({ onPlay: () => Promise.reject(new Error("NotAllowedError")) });

    assert.equal(player.play("message", 100), true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(elements[0].plays, 1);
  });

  it("stays silent when the environment cannot create audio elements", () => {
    const player = createNotificationSoundPlayer({ createElement: () => null });

    assert.equal(player.play("message", 100), false);
  });

  it("stops playing after disposal", () => {
    const { player } = harness();

    player.dispose();
    assert.equal(player.play("message", 100), false);
  });
});

describe("notification sound wiring", () => {
  it("derives arrivals and departures from the voice snapshot rather than a separate event", () => {
    const hook = readFileSync("src/app/useNotificationSounds.ts", "utf8");

    assert.match(hook, /advanceVoiceRoster\(rosterRef\.current/);
    assert.match(hook, /voiceSnapshot\?\.roomId === activeVoiceRoomId/);
    assert.match(hook, /filter\(\(userId\) => userId !== currentUserId\)/);
  });

  it("prefers the deafen cue over the microphone change it implies", () => {
    const hook = readFileSync("src/app/useNotificationSounds.ts", "utf8");

    assert.match(hook, /previous\.deafen !== current\.deafen[\s\S]*?play\(current\.deafen \? "deafen" : "undeafen"\);\s*return;/);
  });

  it("plays message cues from the realtime handler without reordering chat state", () => {
    const app = readFileSync("src/App.tsx", "utf8");

    assert.match(app, /messageNew: \(message\) => \{ chat\.applyNewMessage\(message\); notifyMessageRef\.current\(message\); \}/);
    assert.match(app, /notifyMessageRef\.current = audio\.notifyMessage/);
  });

  it("mutes cues for owner-enforced deafen as well as self deafen", () => {
    const listener = readFileSync("src/app/useListenerAudio.ts", "utf8");

    assert.match(listener, /deafened: voice\.controls\.deafen\.on \|\| voice\.voiceModeration\.deafened/);
    assert.match(listener, /connectionInterrupted: connectionHealth\.overlayVisible/);
  });
});
