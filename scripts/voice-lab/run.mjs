import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { installProbe } from "./probe.mjs";
import { impairMedia, mediaProfile } from "./network.mjs";
import { buildRecoveryExperiment } from "./recovery-experiment.mjs";
import {
  decodeWav,
  fixture,
  writeWav,
  metrics,
  compare,
  decoderRates,
  decoderTimeline,
  phaseDifference
} from "./audio.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.VOICE_LAB_OUTPUT ?? join(root, "voice-lab-results"));
const cycles = Number(process.env.VOICE_LAB_CYCLES ?? 100);
const compareOnly = process.env.VOICE_LAB_COMPARE_ONLY === "1";
const recoveryExperiment = process.env.VOICE_LAB_RECOVERY !== undefined;
const recoveryPolicy = process.env.VOICE_LAB_RECOVERY ?? "production";
assert.ok(["production", "legacy-degradation"].includes(recoveryPolicy));
assert.ok(!recoveryExperiment || compareOnly, "Recovery variants require the synchronized comparison scenario");
const maximumQuietMs = process.env.VOICE_LAB_MAX_QUIET_MS ? Number(process.env.VOICE_LAB_MAX_QUIET_MS) : null;
assert.ok(maximumQuietMs === null || (compareOnly && Number.isFinite(maximumQuietMs) && maximumQuietMs >= 500));
const trials = Number(process.env.VOICE_LAB_TRIALS ?? 3);
const profile = mediaProfile(process.env.VOICE_LAB_NETWORK || "clean");
const seconds = Number(
  process.env.VOICE_LAB_SECONDS ?? (compareOnly || profile.name !== "clean" ? profile.minimumSeconds + 1 : 8)
);
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 20);
if (compareOnly || profile.name !== "clean")
  assert.ok(
    seconds >= profile.minimumSeconds + (compareOnly ? 0.25 : 0),
    "Recording must cover the fixture and complete impairment schedule"
  );
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const relay = process.env.VOICE_LAB_ROUTE === "relay";
const bufferTarget = process.env.VOICE_LAB_BUFFER ? Number(process.env.VOICE_LAB_BUFFER) : null;
assert.ok(Number.isInteger(cycles) && cycles > 0 && cycles <= 1000);
assert.ok(seconds >= 2 && seconds <= 30);
assert.ok(bufferTarget === null || bufferTarget === 40 || bufferTarget === 80);
const base = `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(join(tmpdir(), "voxly-voice-lab-"));
const secret = randomBytes(32).toString("hex");
const children = [],
  browsers = [],
  errors = [];
const stop = () => {
  for (const browser of browsers) void browser.close().catch(() => {});
  for (const child of children) child.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const summary = {
  environment: {
    platform: process.platform,
    browser: process.env.VOICE_LAB_CHANNEL ?? "chromium",
    route: relay ? "relay" : "direct",
    bufferTarget,
    cycles,
    profile: profile.name,
    trials: compareOnly ? trials : null,
    synchronizedTransportFixture: compareOnly,
    recoveryPolicy,
    recoveryDecisionsInstrumented: recoveryExperiment,
    maximumQuietMs
  },
  cyclesCompleted: 0,
  comparisons: [],
  scenarios: [],
  limitations: ["Synthetic capture does not certify Windows headset behavior or perceived voice naturalness."]
};
await mkdir(output, { recursive: true });
let server;
try {
  const webDistPath = recoveryExperiment
    ? await buildRecoveryExperiment(root, temporary, recoveryPolicy)
    : join(root, "apps/web/dist");
  // Always a disposable local server/database. No production account or credential input.
  server = spawn(process.execPath, ["apps/server/dist/src/main.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(temporary, "lab.sqlite"),
      VOXLY_PUBLIC_URL: base,
      WEB_DIST_PATH: webDistPath,
      VOXLY_LOG: "false",
      COOKIE_SECURE: "false",
      ENABLE_HTTP_OWNER_BOOTSTRAP: "true",
      OWNER_BOOTSTRAP_TOKEN: secret,
      ...(relay ? {} : { TURN_REALM: "", TURN_STATIC_AUTH_SECRET: "" })
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  children.push(server);
  // Do not print server stderr: credential-bearing requests must not enter artifacts.
  server.stderr.on("data", () => {});
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${base}/api/config`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 20000 }
    )
    .toBe(200);
  const speech = decodeWav(process.env.VOICE_LAB_SPEECH ?? join(root, "scripts/voice-lab/fixtures/speech.wav"));
  assert.ok(
    seconds >= speech.length / 48000 + (compareOnly ? 0.25 : 0),
    "Record a complete speech fixture including its synchronized lead-in"
  );
  for (const kind of ["speech", "silence", "noise"]) writeWav(join(output, `${kind}.wav`), fixture(speech, kind));
  async function launch(kind) {
    const browser = await chromium.launch({
      headless: process.env.VOICE_LAB_HEADED !== "1",
      ...(process.env.VOICE_LAB_CHANNEL ? { channel: process.env.VOICE_LAB_CHANNEL } : {}),
      ...(process.env.VOICE_LAB_EXECUTABLE ? { executablePath: process.env.VOICE_LAB_EXECUTABLE } : {}),
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${join(output, `${kind}.wav`)}`,
        "--autoplay-policy=no-user-gesture-required"
      ]
    });
    browsers.push(browser);
    // Bypass CSP solely for the injected recording worklet. Production assets and
    // capture/playback code remain unchanged; this is not a CSP acceptance test.
    const context = await browser.newContext({
      permissions: ["microphone", "camera"],
      locale: "en-US",
      bypassCSP: true
    });
    await context.addInitScript(installProbe, {
      relay,
      bufferTarget,
      synchronizedFixture: compareOnly ? Array.from(speech) : null
    });
    await context.addInitScript(() => localStorage.setItem("voxly:language", "en"));
    context.setDefaultTimeout(15000);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.name));
    return { browser, context, page };
  }
  const a = await launch("speech"),
    b = await launch("speech");
  summary.environment.browserVersions = [a.browser.version(), b.browser.version()];
  async function post(context, path, data) {
    const response = await context.request.post(`${base}${path}`, { data, headers: { origin: base } });
    assert.ok(response.ok(), `${path}: HTTP ${response.status()}`);
    return response.json();
  }
  const owner = await post(a.context, "/api/bootstrap/owner", { bootstrapToken: secret, nickname: "Lab speaker A" });
  const invitation = await post(a.context, "/api/owner/invites", { label: "Voice lab" });
  const member = await post(b.context, "/api/invites/accept", {
    inviteToken: invitation.invite.token,
    nickname: "Lab speaker B"
  });
  const rooms = await (await a.context.request.get(`${base}/api/rooms`)).json();
  const room = rooms.rooms.find((room) => room.kind === "voice" && !room.isAfk);
  assert.ok(room, "Fresh installation must contain a voice room");
  const path = `${base}/app/server/${encodeURIComponent(room.serverId)}/voice/${encodeURIComponent(room.id)}`;
  const pages = [a.page, b.page];
  let activeKind = "speech";
  await Promise.all(pages.map((page) => page.goto(path)));
  summary.environment.loadedClientVersions = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        const script = document.querySelector('script[type="module"][src]');
        return script ? new URL(script.src).pathname : null;
      })
    )
  );
  console.log("Voice lab: authenticated pages loaded");
  async function joinCall(page) {
    await page.getByRole("button", { name: "Join this voice room", exact: true }).click();
  }
  async function leaveCall(page) {
    await page.locator(".voice-dock").getByRole("button", { name: "Leave", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.voiceLab.state()))
      .toMatchObject({ captures: 0, peers: 0, outputs: 0 });
  }
  async function ready() {
    await Promise.all(
      pages.map(async (page) => {
        await expect
          .poll(() => page.evaluate(() => window.voiceLab.state()), { timeout: 20000 })
          .toMatchObject({ captures: 1, peers: 1, outputs: 1, playing: 1 });
        await expect
          .poll(
            () =>
              page.evaluate(
                async (silence) =>
                  (await window.voiceLab.stats()).every(
                    (peer) =>
                      peer.connection === "connected" &&
                      peer.audio.some(
                        (audio) =>
                          audio.packetsReceived > 5 &&
                          audio.jitterBufferEmittedCount > 4800 &&
                          (silence || audio.totalAudioEnergy > 0.00001)
                      )
                  ),
                activeKind === "silence" || compareOnly
              ),
            { timeout: 20000 }
          )
          .toBe(true);
        const routes = await page.evaluate(() => window.voiceLab.stats());
        assert.ok(
          routes.every((peer) => peer.route === (relay ? "relay" : "direct")),
          "Media route does not match requested test"
        );
        if (bufferTarget !== null)
          assert.ok(
            routes.every((peer) => peer.bufferTargetSupported),
            "Browser does not support the requested buffer experiment"
          );
      })
    );
  }
  async function capture(
    label,
    { networkProfile = label.includes("network") ? profile.name : "clean", inject = null, duration = seconds } = {}
  ) {
    const startAt = Date.now() + 2000;
    const fixtureStartAt = startAt + 250;
    if (compareOnly)
      await Promise.all(
        pages.map((page) => page.evaluate((start) => window.voiceLab.armFixture(start), fixtureStartAt))
      );
    let injection = null;
    const { value: results, network } = await impairMedia(
      networkProfile,
      async () => {
        const recording = Promise.all(
          pages.map((page) =>
            page.evaluate(({ duration, startAt }) => window.voiceLab.record(duration, startAt), { duration, startAt })
          )
        );
        if (!inject) return recording;
        const fault = (async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, fixtureStartAt + 2000 - Date.now())));
          const peerAlias = await inject.evaluate(() => window.voiceLab.dropPublishedAudio());
          injection = { atMs: Date.now() - startAt, peerAlias };
        })();
        const [results] = await Promise.all([recording, fault]);
        return results;
      },
      { startAt: compareOnly ? fixtureStartAt : startAt }
    );
    for (let side = 0; side < results.length; side++) {
      const result = results[side];
      result.decoderRates = decoderRates(result.statsBefore, result.stats);
      result.decoderTimeline = decoderTimeline(result.statsTimeline);
      if (networkProfile !== "clean") {
        // Replacement may temporarily have no selected ICE pair. Preserve that
        // interruption; validate every selected connected route, not pending ICE.
        const connected = result.statsTimeline.flatMap((snapshot) =>
          snapshot.peers.filter((peer) => peer.connection === "connected")
        );
        assert.ok(
          connected.length > 0 &&
            connected.every((peer) => peer.mediaProtocol === "udp" && peer.networkFamily === "ipv4"),
          "UDP impairment requires verified IPv4 UDP routes whenever media is connected"
        );
      }
      for (const [index, recording] of result.recordings.entries()) {
        assert.ok(recording.recordedSamples >= duration * 48000 * 0.95, "Recorder missed audio timeline samples");
        recording.metrics = metrics(recording.samples);
        writeWav(join(output, `${label}-${side}-${recording.stage}-${index}.wav`), recording.samples);
        delete recording.samples;
      }
    }
    const comparisons = results.map((result, index) => {
      // Capture remains continuous while publication and receivers are replaced.
      // Comparing only the current sender would hide silence caused by a rebuild.
      const source = result.recordings.find((recording) => recording.stage === "capture");
      const received = results[1 - index].recordings.find((recording) => recording.stage === "received");
      assert.ok(source && received, "Missing capture or received recording");
      return {
        direction: index,
        ...compare(source.metrics, received.metrics, result.startedAt, results[1 - index].startedAt)
      };
    });
    if (networkProfile !== "clean" && comparisons.some((comparison) => !comparison.comparisonAvailable)) {
      summary.incompleteMeasurements ??= [];
      summary.incompleteMeasurements.push(label);
    }
    await writeFile(
      join(output, `${label}.json`),
      JSON.stringify({ results, comparisons, network, injection }, null, 2)
    );
    summary.comparisons.push({
      label,
      comparisons,
      network,
      waveforms: results.map((result) =>
        Object.fromEntries(
          result.recordings.map(({ stage, metrics }) => [
            stage,
            { longestQuietMs: metrics.longestQuietMs, firstSpeechMs: metrics.firstSpeechMs }
          ])
        )
      ),
      recoveryDecisions: results.map((result) => result.recoveryDecisions),
      decoders: results.map((result) => ({ ...result.decoderTimeline, windows: undefined }))
    });
    console.log(`Voice lab: ${label} captured`);
    return results;
  }
  const rtc = await (await a.context.request.get(`${base}/api/rtc/config`)).json();
  async function nativeReference(label, networkProfile = "clean") {
    await Promise.all(
      pages.map((page) => page.evaluate((servers) => window.voiceLab.referenceStart(servers), rtc.iceServers))
    );
    const offer = await a.page.evaluate(() => window.voiceLab.referenceOffer());
    const answer = await b.page.evaluate((offer) => window.voiceLab.referenceAnswer(offer), offer);
    await a.page.evaluate((answer) => window.voiceLab.referenceAccept(answer), answer);
    await ready();
    try {
      return await capture(label, { networkProfile });
    } finally {
      await Promise.all(pages.map((page) => page.evaluate(() => window.voiceLab.referenceStop())));
    }
  }
  if (compareOnly) {
    summary.pairedTrials = [];
    summary.limitations.push(
      "Synchronized transport fixtures bypass device capture DSP equally in both paths; default runs still test browser capture processing."
    );
    for (let trial = 0; trial < trials; trial++) {
      await Promise.all(pages.map(joinCall));
      await ready();
      const actual = await capture(`voxly-network-${trial}`, { networkProfile: profile.name });
      await Promise.all(pages.map(leaveCall));
      const reference = await nativeReference(`native-network-${trial}`, profile.name);
      const phaseDifferenceMs = actual.map((result, side) => phaseDifference(result, reference[side]));
      const paired = phaseDifferenceMs.every((difference) => difference !== null && difference <= 40);
      if (!paired) {
        summary.incompleteMeasurements ??= [];
        summary.incompleteMeasurements.push(`fixture-phase-${trial}`);
      }
      summary.pairedTrials.push({ trial, phaseDifferenceMs, paired });
    }
    if (maximumQuietMs !== null) {
      summary.quietGapViolations = summary.comparisons
        .filter((comparison) => comparison.label.startsWith("voxly-network-"))
        .flatMap((comparison) =>
          comparison.waveforms.flatMap((waveform, side) =>
            waveform.received.longestQuietMs > maximumQuietMs
              ? [{ label: comparison.label, side, longestQuietMs: waveform.received.longestQuietMs }]
              : []
          )
        );
      assert.equal(summary.quietGapViolations.length, 0, "Received silence exceeded the experimental continuity gate");
    }
    if (process.env.VOICE_LAB_STALLED_MEDIA === "1") {
      const offerer = owner.user.userId < member.user.userId ? a.page : b.page;
      const answerer = offerer === a.page ? b.page : a.page;
      for (const [role, sender] of [
        ["offerer", answerer],
        ["answerer", offerer]
      ]) {
        await Promise.all(pages.map(joinCall));
        await ready();
        const oldPeer = (await sender.evaluate(() => window.voiceLab.stats()))[0].peerAlias;
        const results = await capture(`stalled-${role}`, { inject: sender, duration: 30, networkProfile: "clean" });
        assert.ok(
          results.some((result) => result.decoderTimeline.replacements.length > 0),
          "Stall did not exercise receiver replacement"
        );
        const current = (await sender.evaluate(() => window.voiceLab.stats()))[0];
        assert.ok(current && current.peerAlias !== oldPeer, "Stalled sender was not replaced");
        await ready();
        // Speech must return in the final fixture cycle, not merely connected ICE.
        assert.ok(
          results.every((result) =>
            result.recordings
              .find((recording) => recording.stage === "received")
              .metrics.envelope.slice(-200)
              .some((rms) => rms > 0.001)
          ),
          "Speech did not resume after stalled-media recovery"
        );
        await Promise.all(pages.map(leaveCall));
        summary.scenarios.push(`${role}-continuous-stall-recovery`);
      }
    }
  } else {
    for (let cycle = 0; cycle < cycles; cycle++) {
      if (cycle % 2 === 0) await Promise.all(pages.map(joinCall));
      else {
        await joinCall(a.page);
        await joinCall(b.page);
      }
      await ready();
      if (cycle === 0 || process.env.VOICE_LAB_CAPTURE_EACH_JOIN === "1") {
        const result = await capture(cycle === 0 ? "voxly-startup" : `voxly-startup-${cycle}`);
        if (process.env.VOICE_LAB_CAPTURE_EACH_JOIN === "1") {
          const comparisons = summary.comparisons.at(-1).comparisons;
          for (let side = 0; side < 2; side++) {
            const before = result[side].statsBefore[0].audio[0];
            const after = result[side].stats[0].audio[0];
            const emittedSeconds = (after.jitterBufferEmittedCount - before.jitterBufferEmittedCount) / 48000;
            assert.ok(
              emittedSeconds >= seconds * 0.9,
              `Fresh join ${cycle}, side ${side}: receiver emitted only ${emittedSeconds.toFixed(2)} seconds`
            );
            assert.ok(
              comparisons[side].comparisonAvailable && comparisons[side].envelopeCorrelation >= 0.8,
              `Fresh join ${cycle}, direction ${side}: received speech did not follow the published fixture`
            );
          }
        }
      }
      await Promise.all(pages.map(leaveCall));
      summary.cyclesCompleted++;
      if ((cycle + 1) % 10 === 0) console.log(`Voice lab: ${cycle + 1}/${cycles} fresh joins passed`);
    }
    await Promise.all(pages.map(joinCall));
    await ready();
    for (const page of pages) {
      await leaveCall(page);
      await joinCall(page);
      await ready();
    }
    summary.scenarios.push("individual-rejoin");
    if (process.env.VOICE_LAB_STALLED_MEDIA === "1") {
      const offerer = owner.user.userId < member.user.userId ? a.page : b.page;
      const answerer = offerer === a.page ? b.page : a.page;
      for (const [role, receiver, sender] of [
        ["offerer", offerer, answerer],
        ["answerer", answerer, offerer]
      ]) {
        const oldSenderPeer = await sender.evaluate(() => window.voiceLab.dropPublishedAudio());
        const oldReceiverStats = (await receiver.evaluate(() => window.voiceLab.stats()))[0];
        const before = oldReceiverStats.audio[0].packetsReceived;
        await expect
          .poll(
            async () => {
              const [senderStats, receiverStats] = await Promise.all([
                sender.evaluate(() => window.voiceLab.stats()),
                receiver.evaluate(() => window.voiceLab.stats())
              ]);
              const current = receiverStats[0];
              return Boolean(
                senderStats[0] &&
                senderStats[0].peerAlias !== oldSenderPeer &&
                current?.connection === "connected" &&
                current.audio.some(
                  (audio) =>
                    audio.packetsReceived > (current.peerAlias === oldReceiverStats.peerAlias ? before + 20 : 20)
                )
              );
            },
            { timeout: 45000, intervals: [1000] }
          )
          .toBe(true);
        await ready();
        summary.scenarios.push(`${role}-recovers-stalled-remote-sender`);
      }
    }
    if (process.env.VOICE_LAB_RECOVERY_ONLY === "1") {
      assert.equal(process.env.VOICE_LAB_STALLED_MEDIA, "1", "Recovery-only run must inject stalled media");
    } else {
      await a.page.locator(".voice-dock").getByRole("button", { name: "Mute mic", exact: true }).click();
      await expect.poll(() => a.page.evaluate(() => window.voiceLab.state().captures)).toBe(1);
      const muted = await capture("voxly-muted");
      assert.ok(
        muted[0].recordings.find((recording) => recording.stage === "published").metrics.rms < 0.0001,
        "UI mute leaked publication audio"
      );
      await a.page.locator(".voice-dock").getByRole("button", { name: "Unmute mic", exact: true }).click();
      await a.page.locator(".voice-dock").getByRole("button", { name: "Deafen", exact: true }).click();
      await expect
        .poll(() =>
          a.page.evaluate(() =>
            [...document.querySelectorAll("audio.remote-audio")].every((audio) => audio.muted || audio.volume === 0)
          )
        )
        .toBe(true);
      await a.page.locator(".voice-dock").getByRole("button", { name: "Enable sound", exact: true }).click();
      summary.scenarios.push("mute", "deafen");
      const background = await a.context.newPage();
      await background.goto("about:blank");
      await background.bringToFront();
      await capture("voxly-background");
      await background.close();
      summary.scenarios.push("background-tab");
      if (process.env.VOICE_LAB_NETWORK && process.env.VOICE_LAB_NETWORK !== "clean") await capture("voxly-network");
      const accountMenu = a.page.getByRole("contentinfo").locator(".account-menu");
      await accountMenu.locator("summary").click();
      await accountMenu.getByRole("button", { name: "Settings", exact: true }).click();
      await a.page.getByRole("button", { name: "Voice & audio", exact: true }).click();
      const suppression = a.page.getByRole("switch", { name: "Noise suppression", exact: true });
      await suppression.click();
      await expect(suppression).toHaveAttribute("aria-checked", "true");
      await ready();
      await capture("voxly-suppression");
      await suppression.click();
      const device = a.page.getByRole("combobox", { name: "Microphone", exact: true });
      const devices = await device.locator("option").evaluateAll((options) => options.map((option) => option.value));
      const alternate = devices.find((value) => value && value !== "default");
      if (alternate) {
        await device.selectOption(alternate);
        await ready();
        summary.scenarios.push("device-replacement");
      } else
        summary.limitations.push(
          "Browser exposed no alternate fake microphone; device replacement needs the Windows headset run."
        );
      await a.page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      summary.scenarios.push("suppression-toggle");
      await a.page.locator(".voice-dock").getByRole("button", { name: "Share screen", exact: true }).click();
      await b.page.getByRole("button", { name: "Watch stream — Lab speaker A", exact: true }).click();
      await expect
        .poll(() => b.page.evaluate(() => window.voiceLab.state()), { timeout: 15000 })
        .toMatchObject({ outputs: 2, playing: 2 });
      await b.page.locator(".voice-dock").getByRole("button", { name: "Deafen", exact: true }).click();
      await expect
        .poll(() =>
          b.page.evaluate(
            () =>
              [...document.querySelectorAll("audio.remote-audio")].filter((audio) => !audio.muted && audio.volume > 0)
                .length
          )
        )
        .toBe(1);
      await b.page.locator(".voice-dock").getByRole("button", { name: "Enable sound", exact: true }).click();
      await a.page.locator(".voice-dock").getByRole("button", { name: "Stop sharing", exact: true }).click();
      await ready();
      summary.scenarios.push("screen-audio", "screen-audio-under-deafen");
      await Promise.all(pages.map(leaveCall));
      await nativeReference("native-reference");
      if (profile.name !== "clean") await nativeReference("native-reference-network", profile.name);
      const baseline = summary.comparisons.find((result) => result.label === "native-reference");
      const production = summary.comparisons.find((result) => result.label === "voxly-startup");
      for (let index = 0; index < 2; index++) {
        const actual = production.comparisons[index],
          reference = baseline.comparisons[index];
        assert.ok(
          reference.comparisonAvailable && reference.envelopeCorrelation >= 0.8,
          "Native reference did not provide usable speech"
        );
        assert.ok(
          actual.comparisonAvailable && actual.envelopeCorrelation >= 0.8,
          "Received speech is not following the published fixture"
        );
        assert.ok(
          actual.missingSpeechFraction <= reference.missingSpeechFraction + 0.05,
          "Voxly loses substantially more speech than native WebRTC"
        );
        assert.ok(
          actual.longestMissingSpeechMs <= Math.max(150, reference.longestMissingSpeechMs + 100),
          "Voxly introduces a long speech interruption"
        );
      }
      const states = await Promise.all([a.context.storageState(), b.context.storageState()]);
      for (const kind of (process.env.VOICE_LAB_FIXTURES ?? "silence,noise").split(",").filter(Boolean)) {
        assert.ok(["silence", "noise"].includes(kind));
        activeKind = kind;
        for (const [index, client] of [a, b].entries()) {
          await client.browser.close();
          Object.assign(client, await launch(kind));
          await client.context.addCookies(states[index].cookies);
          pages[index] = client.page;
          await client.page.goto(path);
        }
        await Promise.all(pages.map(joinCall));
        await ready();
        const voxly = await capture(`voxly-${kind}`);
        await Promise.all(pages.map(leaveCall));
        const native = await nativeReference(`native-${kind}`);
        if (kind === "silence") {
          for (let side = 0; side < 2; side++) {
            const received = (result) =>
              result[side].recordings.find((recording) => recording.stage === "received").metrics.rms;
            assert.ok(
              received(voxly) <= received(native) + 0.0001,
              "Voxly adds noise to digital silence compared with native WebRTC"
            );
          }
        }
        summary.scenarios.push(kind);
      }
    }
  }
  assert.equal(errors.length, 0, `Browser raised ${errors.length} unhandled errors`);
  summary.status = summary.incompleteMeasurements?.length ? "measurement-incomplete" : "passed";
  if (summary.status === "measurement-incomplete") process.exitCode = 2;
} catch (error) {
  summary.status = "failed";
  // Errors from assertions contain no tokens; never persist request/response bodies.
  summary.failure = error.message;
  for (let index = 0; index < browsers.length; index++) {
    const page = browsers[index].contexts()[0]?.pages()[0];
    if (page)
      await writeFile(
        join(output, `failure-${index}.json`),
        JSON.stringify(
          await page
            .evaluate(async () => ({
              state: window.voiceLab.state(),
              stats: await window.voiceLab.stats()
            }))
            .catch(() => ({ unavailable: true })),
          null,
          2
        )
      );
  }
  console.error(`Voice lab failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await Promise.allSettled(browsers.map((browser) => browser.close()));
  for (const child of children) child.kill();
  if (server && server.exitCode === null)
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  await rm(temporary, { recursive: true, force: true });
  console.log(`Voice lab artifacts: ${output}`);
}
