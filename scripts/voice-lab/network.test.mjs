import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaProfile, runMediaImpairment } from "./network.mjs";

test("burst profiles have repeatable absolute schedules and return to clean UDP", () => {
  for (const name of ["burst-loss", "delay-burst", "sustained-loss", "outage"]) {
    const profile = mediaProfile(name);
    assert.deepEqual(profile, mediaProfile(name));
    assert.ok(profile.events.every((event, index, events) => index === 0 || event.atMs > events[index - 1].atMs));
    assert.deepEqual(profile.events.at(-1).parameters, ["loss", "0%"]);
  }
  assert.ok(mediaProfile("sustained-loss").minimumSeconds >= 20);
  assert.throws(() => mediaProfile("not-a-profile"));
});

test("impairment is anchored to fixture time and records actual command timing", async () => {
  let now = 1000;
  const commands = [];
  const result = await runMediaImpairment(mediaProfile("outage"), async () => "recording", {
    startAt: 2000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    execute: async (...args) => {
      commands.push(args);
      now += 5;
    },
    inspect: async () => ({ packets: 200, drops: 25 })
  });
  assert.equal(result.value, "recording");
  assert.equal(result.network.events[0].appliedAtMs, 2005);
  assert.equal(result.network.events[1].appliedAtMs, 2505);
  assert.deepEqual(result.network.shaper, { packets: 200, drops: 25 });
  assert.ok(commands.some((args) => args.includes("17") && args.includes("0xff")));
  assert.deepEqual(commands.at(-1), ["qdisc", "del", "dev", "lo", "root"]);
});

test("failed recording cleans up owned shaping and propagates the failure", async () => {
  const commands = [];
  await assert.rejects(
    runMediaImpairment(
      mediaProfile("loss"),
      async () => {
        throw new Error("recording failed");
      },
      {
        startAt: 0,
        now: () => 0,
        sleep: async () => {},
        execute: async (...args) => {
          commands.push(args);
        }
      }
    ),
    /recording failed/
  );
  assert.deepEqual(commands.at(-1), ["qdisc", "del", "dev", "lo", "root"]);
});

test("a failed root acquisition never deletes someone else's qdisc", async () => {
  const commands = [];
  await assert.rejects(
    runMediaImpairment(mediaProfile("loss"), async () => {}, {
      startAt: 0,
      now: () => 0,
      sleep: async () => {},
      execute: async (...args) => {
        commands.push(args);
        throw new Error("already exists");
      }
    }),
    /already exists/
  );
  assert.equal(commands.length, 1);
});
