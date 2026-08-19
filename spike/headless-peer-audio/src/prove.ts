import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledTrackPath, readOggOpus } from "./audio.js";
import { Ear, describeHearing, soundedLikeMusic } from "./ear.js";
import { VoiceMesh } from "./mesh.js";
import { joinAsParticipant, meshFor } from "./participant.js";
import { TrackPlayer } from "./player.js";
import { getJson, sessionCookieName, sessionTokenFrom } from "./voxly.js";

/**
 * One command, no setup: boot a throwaway Voxly, put the bot in a voice room
 * with two headless Listeners, and check that both of them decoded real audio
 * at the same time.
 *
 * This does not replace the person with the headphones — nothing here proves a
 * browser's decoder is happy or that the result sounds good. It proves the path
 * is live before anyone bothers to plug them in.
 */

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const serverEntry = join(repoRoot, "apps/server/dist/src/main.js");
const listenSeconds = Number(process.env.VOXLY_LISTEN_SECONDS ?? "10");
// With VOXLY_RELAY=1 every peer refuses host and reflexive candidates, so the
// run only passes if the audio went through TURN. Point TURN_REALM and
// TURN_STATIC_AUTH_SECRET at a running TURN server; the throwaway Voxly hands
// the same credentials to the bot and the Listeners that it would to a browser.
const relayOnly = process.env.VOXLY_RELAY === "1";

if (!existsSync(serverEntry)) {
  console.error(`No built server at ${serverEntry}`);
  console.error("Build it first:  npm run build -w @voxly/server");
  process.exit(1);
}

const databasePath = join(tmpdir(), `voxly-spike-${randomUUID()}.sqlite`);
const bootstrapToken = randomBytes(32).toString("hex");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

let voxly: ChildProcess | undefined;
let failure: unknown;

try {
  voxly = spawn(process.execPath, [serverEntry], {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: databasePath,
      COOKIE_SECURE: "false",
      VOXLY_LOG: "false",
      ENABLE_HTTP_OWNER_BOOTSTRAP: "true",
      OWNER_BOOTSTRAP_TOKEN: bootstrapToken
    }
  });
  await waitForHealth(baseUrl);
  log(`throwaway Voxly on ${baseUrl}`);
  if (relayOnly) log(`relay only, via ${process.env.TURN_REALM ?? "(no TURN_REALM set)"}`);

  const owner = await bootstrapOwner(baseUrl, bootstrapToken);
  const inviteToken = await createInvite(baseUrl, owner.sessionToken, owner.serverId);

  const track = readOggOpus(readFileSync(bundledTrackPath));
  const player = new TrackPlayer(track.packets);
  const bot = await joinAsParticipant({
    baseUrl,
    inviteToken,
    nickname: "Music bot (spike)",
    media: { mic: true },
    log: (message) => log(`bot: ${message}`)
  });
  const botMesh = new VoiceMesh({
    ...meshFor(bot),
    relayOnly,
    createOutput: (peerUserId) => player.outputFor(peerUserId),
    onPeerRemoved: (peerUserId) => player.release(peerUserId)
  });
  botMesh.start();
  player.start();

  const listeners = await Promise.all([1, 2].map(async (index) => {
    const participant = await joinAsParticipant({
      baseUrl,
      inviteToken,
      nickname: `Listener ${index}`,
      roomName: bot.room.id,
      log: (message) => log(`listener ${index}: ${message}`)
    });
    const ear = new Ear();
    const mesh = new VoiceMesh({
      ...meshFor(participant),
      relayOnly,
      onRemoteTrack: (userId, remoteTrack) => ear.listenTo(userId, remoteTrack),
      onPeerRemoved: (userId) => ear.forget(userId)
    });
    mesh.start();
    return { index, participant, ear, mesh };
  }));

  log(`playing to ${listeners.length} headless listeners for ${listenSeconds}s`);
  await delay(listenSeconds * 1_000);

  player.stop();
  const results = listeners.map((listener) => ({
    index: listener.index,
    hearing: listener.ear.report().find((entry) => entry.userId === bot.identity.userId)
  }));

  for (const result of results) {
    log(result.hearing ? `listener ${result.index} ${describeHearing(result.hearing)}` : `listener ${result.index} heard nothing at all`);
  }

  await Promise.all(listeners.map(async (listener) => {
    listener.ear.close();
    await listener.mesh.stop();
    await listener.participant.leave();
  }));
  await botMesh.stop();
  await bot.leave();

  const heard = results.filter((result) => result.hearing && soundedLikeMusic(result.hearing));
  const overlapped = heard.length === results.length
    && Math.max(...heard.map((result) => result.hearing!.firstHeardAt))
      < Math.min(...heard.map((result) => result.hearing!.lastHeardAt));

  console.log("");
  log(`${heard.length}/${results.length} listeners decoded real audio`);
  log(overlapped ? "both were hearing it at the same time" : "they did NOT overlap in time");
  if (heard.length !== results.length || !overlapped) {
    failure = new Error("The media path did not deliver audio to every listener");
  }
} catch (error) {
  failure = error;
} finally {
  await stop(voxly);
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${databasePath}${suffix}`, { force: true });
}

if (failure) {
  console.error(`\n[prove] FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exit(1);
}
console.log("\n[prove] PASSED — now do the part software cannot do: put headphones on.");
process.exit(0);

async function bootstrapOwner(url: string, token: string) {
  const response = await fetch(new URL("/api/bootstrap/owner", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrapToken: token, nickname: "Spike owner" })
  });
  if (!response.ok) throw new Error(`Owner bootstrap failed: ${response.status} ${await response.text()}`);
  const sessionToken = sessionTokenFrom(response);

  const body = await getJson<{ servers: Array<{ id: string }> }>(url, "/api/servers", sessionToken);
  const serverId = body.servers[0]?.id;
  if (!serverId) throw new Error("The new owner belongs to no server");
  return { sessionToken, serverId };
}

async function createInvite(url: string, sessionToken: string, serverId: string) {
  const response = await fetch(new URL(`/api/servers/${serverId}/invites`, url), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${sessionCookieName}=${sessionToken}` },
    body: JSON.stringify({ label: "Spike", expiresInMinutes: 60, maxUses: 5 })
  });
  if (!response.ok) throw new Error(`Invite creation failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { invite: { token: string } };
  return body.invite.token;
}


async function waitForHealth(url: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/health", url));
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(150);
  }
  throw new Error("The throwaway Voxly never became healthy");
}

/** Wait for the server to actually exit, so the database is not removed from
 *  under a process still flushing it. */
function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(giveUp);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("Could not find a free port")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string) {
  console.log(`[prove] ${message}`);
}
