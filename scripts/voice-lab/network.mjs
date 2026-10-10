import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

// Only usable in the dedicated Linux lab container. UDP filtering leaves HTTP
// and Socket.IO untouched; browser HTTP throttling cannot model RTP loss.
export async function impairMedia(profile, action) {
  if (!profile || profile === "clean") return action();
  if (process.platform !== "linux" || process.env.VOICE_LAB_ISOLATED !== "1" || !existsSync("/.dockerenv"))
    throw new Error("Media impairment requires the isolated Linux voice-lab container");
  if (!["jitter", "loss", "outage"].includes(profile)) throw new Error("Unknown media impairment profile");
  const tc = (...args) => exec("tc", args);
  let outage;
  let rootOwned = false;
  try {
    await tc("qdisc", "add", "dev", "lo", "root", "handle", "1:", "prio");
    rootOwned = true;
    await tc(
      "qdisc",
      "add",
      "dev",
      "lo",
      "parent",
      "1:3",
      "handle",
      "30:",
      "netem",
      ...(profile === "jitter"
        ? ["delay", "40ms", "20ms", "distribution", "normal"]
        : profile === "loss"
          ? ["loss", "3%"]
          : ["loss", "0%"])
    );
    await tc(
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
    // Use the same timed outage in each Voxly/reference measurement.
    if (profile === "outage")
      outage = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await tc("qdisc", "change", "dev", "lo", "parent", "1:3", "handle", "30:", "netem", "loss", "100%");
        await new Promise((resolve) => setTimeout(resolve, 500));
        await tc("qdisc", "change", "dev", "lo", "parent", "1:3", "handle", "30:", "netem", "loss", "0%");
      })();
    // Attach a rejection handler immediately while the measurement is in flight.
    if (outage) void outage.catch(() => {});
    const result = await action();
    if (outage) await outage;
    return result;
  } finally {
    if (outage) await outage.catch(() => {});
    if (rootOwned) await tc("qdisc", "del", "dev", "lo", "root").catch(() => {});
  }
}
