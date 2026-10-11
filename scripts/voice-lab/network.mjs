import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
const exec = promisify(execFile);

export function mediaProfile(name = "clean") {
  const clean = ["loss", "0%"];
  const events = [];
  const burst = (atMs, durationMs, parameters) => {
    events.push({ atMs, parameters }, { atMs: atMs + durationMs, parameters: clean });
  };
  let initial = clean;
  let minimumSeconds = 8;
  if (name === "jitter") initial = ["delay", "40ms", "20ms", "distribution", "normal"];
  else if (name === "loss") initial = ["loss", "3%"];
  else if (name === "outage") burst(2000, 500, ["loss", "100%"]);
  else if (name === "burst-loss") {
    for (const atMs of [2000, 3500, 5000]) burst(atMs, 150, ["loss", "100%"]);
  } else if (name === "delay-burst") {
    for (const atMs of [2000, 4500]) burst(atMs, 400, ["delay", "150ms"]);
  } else if (name === "sustained-loss") {
    minimumSeconds = 20;
    for (let atMs = 2000; atMs < 18000; atMs += 300) burst(atMs, 100, ["loss", "100%"]);
  } else if (name !== "clean") throw new Error("Unknown media impairment profile");
  return { name, initial, events, minimumSeconds };
}

/** Injectable command runner for tests; only impairMedia supplies real tc. */
export async function runMediaImpairment(
  profile,
  action,
  { execute, startAt, now = Date.now, sleep: pause = sleep, inspect = async () => null }
) {
  const measurement = { profile: profile.name, startAt, events: [] };
  const controller = new AbortController();
  let schedule;
  let rootOwned = false;
  try {
    await execute("qdisc", "add", "dev", "lo", "root", "handle", "1:", "prio");
    rootOwned = true;
    await execute("qdisc", "add", "dev", "lo", "parent", "1:3", "handle", "30:", "netem", ...profile.initial);
    // Shape IPv4 UDP only. HTTP and Socket.IO are not impaired.
    await execute(
      "filter",
      "add",
      "dev",
      "lo",
      "protocol",
      "ip",
      "parent",
      "1:",
      "prio",
      "1",
      "u32",
      "match",
      "ip",
      "protocol",
      "17",
      "0xff",
      "flowid",
      "1:3"
    );
    schedule = (async () => {
      for (const event of profile.events) {
        await pause(Math.max(0, startAt + event.atMs - now()), undefined, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await execute("qdisc", "change", "dev", "lo", "parent", "1:3", "handle", "30:", "netem", ...event.parameters);
        measurement.events.push({
          requestedAtMs: event.atMs,
          appliedAtMs: now() - startAt,
          parameters: event.parameters
        });
      }
    })();
    // Observe errors immediately, even while browser recordings are still pending.
    const [value] = await Promise.all([action(), schedule]);
    measurement.shaper = await inspect();
    return { value, network: measurement };
  } finally {
    controller.abort();
    if (schedule) await schedule.catch(() => {});
    if (rootOwned) await execute("qdisc", "del", "dev", "lo", "root");
  }
}

// Never apply shaping to the operator's host, including a Linux host.
export async function impairMedia(name, action, { startAt = Date.now() } = {}) {
  const profile = mediaProfile(name || "clean");
  if (profile.name === "clean") return { value: await action(), network: { profile: "clean", startAt, events: [] } };
  if (process.platform !== "linux" || process.env.VOICE_LAB_ISOLATED !== "1" || !existsSync("/.dockerenv"))
    throw new Error("Media impairment requires the isolated Linux voice-lab container");
  return runMediaImpairment(profile, action, {
    startAt,
    execute: (...args) => exec("tc", args),
    inspect: async () => {
      const { stdout } = await exec("tc", ["-j", "-s", "qdisc", "show", "dev", "lo"]);
      const queue = JSON.parse(stdout).find((queue) => queue.kind === "netem" && queue.handle === "30:");
      if (!queue || !Number.isFinite(queue.packets) || !Number.isFinite(queue.drops))
        throw new Error("UDP shaper counters unavailable");
      if (queue.packets + queue.drops === 0) throw new Error("No UDP traffic traversed the isolated shaper");
      if (
        profile.events.some((event) => event.parameters[0] === "loss" && event.parameters[1] === "100%") &&
        queue.drops === 0
      )
        throw new Error("Loss experiment did not drop UDP packets");
      return { packets: queue.packets, drops: queue.drops };
    }
  });
}
