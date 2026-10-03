import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { installProbe } from './probe.mjs';
import { impairMedia } from './network.mjs';
import { decodeWav, fixture, writeWav, metrics, compare, decoderRates } from './audio.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.env.VOICE_LAB_OUTPUT ?? join(root, 'voice-lab-results'));
const cycles = Number(process.env.VOICE_LAB_CYCLES ?? 100);
const seconds = Number(process.env.VOICE_LAB_SECONDS ?? 8);
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const relay = process.env.VOICE_LAB_ROUTE === 'relay';
const bufferTarget = process.env.VOICE_LAB_BUFFER ? Number(process.env.VOICE_LAB_BUFFER) : null;
assert.ok(Number.isInteger(cycles) && cycles > 0 && cycles <= 1000);
assert.ok(seconds >= 2 && seconds <= 30);
assert.ok(bufferTarget === null || bufferTarget === 40 || bufferTarget === 80);
const base = `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(join(tmpdir(), 'voxly-voice-lab-'));
const secret = randomBytes(32).toString('hex');
const children = [], browsers = [], errors = [];
const summary = { environment: { platform: process.platform, browser: process.env.VOICE_LAB_CHANNEL ?? 'chromium', route: relay ? 'relay' : 'direct', bufferTarget, cycles }, cyclesCompleted: 0, comparisons: [], scenarios: [], limitations: ['Synthetic capture does not certify Windows headset behavior or perceived voice naturalness.'] };
await mkdir(output, { recursive: true });
let server;
try {
  // Always a disposable local server/database. No production account or credential input.
  server = spawn(process.execPath, ['apps/server/dist/src/main.js'], { cwd: root, env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(temporary, 'lab.sqlite'),
    VOXLY_PUBLIC_URL: base, WEB_DIST_PATH: join(root, 'apps/web/dist'), VOXLY_LOG: 'false',
    COOKIE_SECURE: 'false', ENABLE_HTTP_OWNER_BOOTSTRAP: 'true', OWNER_BOOTSTRAP_TOKEN: secret,
    ...(relay ? {} : { TURN_REALM: '', TURN_STATIC_AUTH_SECRET: '' })
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(server);
  // Do not print server stderr: credential-bearing requests must not enter artifacts.
  server.stderr.on('data', () => {});
  await expect.poll(async () => { try { return (await fetch(`${base}/api/config`)).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  const speech = decodeWav(process.env.VOICE_LAB_SPEECH ?? join(root, 'scripts/voice-lab/fixtures/speech.wav'));
  assert.ok(seconds >= speech.length / 48000, 'Record at least one complete speech fixture (default: 8 seconds)');
  for (const kind of ['speech', 'silence', 'noise']) writeWav(join(output, `${kind}.wav`), fixture(speech, kind));
  async function launch(kind) {
    const browser = await chromium.launch({ headless: process.env.VOICE_LAB_HEADED !== '1',
      ...(process.env.VOICE_LAB_CHANNEL ? { channel: process.env.VOICE_LAB_CHANNEL } : {}),
      ...(process.env.VOICE_LAB_EXECUTABLE ? { executablePath: process.env.VOICE_LAB_EXECUTABLE } : {}),
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${join(output, `${kind}.wav`)}`, '--autoplay-policy=no-user-gesture-required'] });
    browsers.push(browser);
    // Bypass CSP solely for the injected recording worklet. Production assets and
    // capture/playback code remain unchanged; this is not a CSP acceptance test.
    const context = await browser.newContext({ permissions: ['microphone', 'camera'], locale: 'en-US', bypassCSP: true });
    await context.addInitScript(installProbe, { relay, bufferTarget });
    await context.addInitScript(() => localStorage.setItem('voxly:language', 'en'));
    context.setDefaultTimeout(15000);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.name));
    return { browser, context, page };
  }
  const a = await launch('speech'), b = await launch('speech');
  async function post(context, path, data) {
    const response = await context.request.post(`${base}${path}`, { data, headers: { origin: base } });
    assert.ok(response.ok(), `${path}: HTTP ${response.status()}`);
    return response.json();
  }
  await post(a.context, '/api/bootstrap/owner', { bootstrapToken: secret, nickname: 'Lab speaker A' });
  const invitation = await post(a.context, '/api/owner/invites', { label: 'Voice lab' });
  await post(b.context, '/api/invites/accept', { inviteToken: invitation.invite.token, nickname: 'Lab speaker B' });
  const rooms = await (await a.context.request.get(`${base}/api/rooms`)).json();
  const room = rooms.rooms.find(room => room.kind === 'voice' && !room.isAfk);
  assert.ok(room, 'Fresh installation must contain a voice room');
  const path = `${base}/app/server/${encodeURIComponent(room.serverId)}/voice/${encodeURIComponent(room.id)}`;
  const pages = [a.page, b.page];
  let activeKind = "speech";
  await Promise.all(pages.map(page => page.goto(path)));
  console.log("Voice lab: authenticated pages loaded");
  async function joinCall(page) { await page.getByRole('button', { name: 'Join this voice room', exact: true }).click(); }
  async function leaveCall(page) {
    await page.locator('.voice-dock').getByRole('button', { name: 'Leave', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.voiceLab.state())).toMatchObject({ captures: 0, peers: 0, outputs: 0 });
  }
  async function ready() {
    await Promise.all(pages.map(async page => {
      await expect.poll(() => page.evaluate(() => window.voiceLab.state()), { timeout: 20000 }).toMatchObject({ captures: 1, peers: 1, outputs: 1, playing: 1 });
      await expect.poll(() => page.evaluate(async silence => (await window.voiceLab.stats()).every(peer => peer.connection === 'connected' && peer.audio.some(audio => audio.packetsReceived > 5 && audio.jitterBufferEmittedCount > 4800 && (silence || audio.totalAudioEnergy > 0.00001))), activeKind === 'silence'), { timeout: 20000 }).toBe(true);
      const routes = await page.evaluate(() => window.voiceLab.stats());
      assert.ok(routes.every(peer => peer.route === (relay ? 'relay' : 'direct')), 'Media route does not match requested test');
      if (bufferTarget !== null) assert.ok(routes.every(peer => peer.bufferTargetSupported), 'Browser does not support the requested buffer experiment');
    }));
  }
  async function capture(label) {
    const results = await impairMedia(label.includes('network') ? process.env.VOICE_LAB_NETWORK : 'clean', () => Promise.all(pages.map(page => page.evaluate(seconds => window.voiceLab.record(seconds), seconds))));
    for (let side = 0; side < results.length; side++) {
      const result = results[side];
      result.decoderRates = decoderRates(result.statsBefore, result.stats);
      if (label.includes('network') && process.env.VOICE_LAB_NETWORK && process.env.VOICE_LAB_NETWORK !== 'clean') {
        assert.ok([...result.statsBefore, ...result.stats].every(peer => peer.mediaProtocol === 'udp' && peer.networkFamily === 'ipv4'),
          'UDP impairment requires a verified IPv4 UDP media route for the entire window');
      }
      for (const [index, recording] of result.recordings.entries()) {
        recording.metrics = metrics(recording.samples);
        writeWav(join(output, `${label}-${side}-${recording.stage}-${index}.wav`), recording.samples);
        delete recording.samples;
      }
    }
    const comparisons = results.map((result, index) => {
      const published = result.recordings.find(recording => recording.stage === 'published');
      const received = results[1 - index].recordings.find(recording => recording.stage === 'received');
      assert.ok(published && received, 'Missing publication or received recording');
      assert.ok(published.metrics.durationMs >= seconds * 800 && received.metrics.durationMs >= seconds * 800, 'Audio probe did not run for the expected interval');
      // A receiver replacement leaves the probe attached to the initial stream.
      // Preserve its WAV, but do not grade it as the current audible output.
      const measured = [result, results[1 - index]].every(side => side.decoderRates.length > 0 && side.decoderRates.every(rate => rate.available));
      return { direction: index, ...(measured
        ? compare(published.metrics, received.metrics, result.startedAt, results[1 - index].startedAt)
        : { comparisonAvailable: false, unavailableReason: 'Receiver changed or decoder window unavailable',
          envelopeCorrelation: null, estimatedDelayMs: null, missingSpeechFraction: null, longestMissingSpeechMs: null }) };
    });
    if (label.includes('network') && comparisons.some(comparison => !comparison.comparisonAvailable)) {
      summary.incompleteMeasurements ??= [];
      summary.incompleteMeasurements.push(label);
    }
    await writeFile(join(output, `${label}.json`), JSON.stringify({ results, comparisons }, null, 2));
    summary.comparisons.push({ label, comparisons });
    console.log(`Voice lab: ${label} captured`);
    return results;
  }
  for (let cycle = 0; cycle < cycles; cycle++) {
    if (cycle % 2 === 0) await Promise.all(pages.map(joinCall));
    else { await joinCall(a.page); await joinCall(b.page); }
    await ready();
    if (cycle === 0) await capture('voxly-startup');
    await Promise.all(pages.map(leaveCall));
    summary.cyclesCompleted++;
    if ((cycle + 1) % 10 === 0) console.log(`Voice lab: ${cycle + 1}/${cycles} fresh joins passed`);
  }
  await Promise.all(pages.map(joinCall)); await ready();
  for (const page of pages) { await leaveCall(page); await joinCall(page); await ready(); }
  summary.scenarios.push('individual-rejoin');
  await a.page.locator('.voice-dock').getByRole('button', { name: 'Mute mic', exact: true }).click();
  await expect.poll(() => a.page.evaluate(() => window.voiceLab.state().captures)).toBe(1);
  const muted = await capture('voxly-muted');
  assert.ok(muted[0].recordings.find(recording => recording.stage === 'published').metrics.rms < 0.0001, 'UI mute leaked publication audio');
  await a.page.locator('.voice-dock').getByRole('button', { name: 'Unmute mic', exact: true }).click();
  await a.page.locator('.voice-dock').getByRole('button', { name: 'Deafen', exact: true }).click();
  await expect.poll(() => a.page.evaluate(() => [...document.querySelectorAll('audio.remote-audio')].every(audio => audio.muted || audio.volume === 0))).toBe(true);
  await a.page.locator('.voice-dock').getByRole('button', { name: 'Enable sound', exact: true }).click();
  summary.scenarios.push('mute', 'deafen');
  const background = await a.context.newPage(); await background.goto('about:blank'); await background.bringToFront();
  await capture('voxly-background'); await background.close();
  summary.scenarios.push('background-tab');
  if (process.env.VOICE_LAB_NETWORK && process.env.VOICE_LAB_NETWORK !== 'clean') await capture('voxly-network');
  await a.page.locator('.account-menu summary').click();
  await a.page.locator('.account-menu').getByRole('button', { name: 'Settings', exact: true }).click();
  await a.page.getByRole('button', { name: 'Voice & audio', exact: true }).click();
  const suppression = a.page.getByRole('switch', { name: 'Noise suppression', exact: true });
  await suppression.click();
  await expect(suppression).toHaveAttribute('aria-checked', 'true');
  await ready(); await capture('voxly-suppression');
  await suppression.click();
  const device = a.page.getByRole('combobox', { name: 'Microphone', exact: true });
  const devices = await device.locator('option').evaluateAll(options => options.map(option => option.value));
  const alternate = devices.find(value => value && value !== 'default');
  if (alternate) { await device.selectOption(alternate); await ready(); summary.scenarios.push('device-replacement'); }
  else summary.limitations.push('Browser exposed no alternate fake microphone; device replacement needs the Windows headset run.');
  await a.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  summary.scenarios.push('suppression-toggle');
  await a.page.locator('.voice-dock').getByRole('button', { name: 'Share screen', exact: true }).click();
  await b.page.getByRole('button', { name: 'Watch stream — Lab speaker A', exact: true }).click();
  await expect.poll(() => b.page.evaluate(() => window.voiceLab.state()), { timeout: 15000 }).toMatchObject({ outputs: 2, playing: 2 });
  await b.page.locator('.voice-dock').getByRole('button', { name: 'Deafen', exact: true }).click();
  await expect.poll(() => b.page.evaluate(() => [...document.querySelectorAll('audio.remote-audio')].filter(audio => !audio.muted && audio.volume > 0).length)).toBe(1);
  await b.page.locator('.voice-dock').getByRole('button', { name: 'Enable sound', exact: true }).click();
  await a.page.locator('.voice-dock').getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await ready();
  summary.scenarios.push('screen-audio', 'screen-audio-under-deafen');
  await Promise.all(pages.map(leaveCall));
  const rtc = await (await a.context.request.get(`${base}/api/rtc/config`)).json();
  async function nativeReference(label) {
    // Same capture constraints, browser, ICE configuration and network profile.
    await Promise.all(pages.map(page => page.evaluate(servers => window.voiceLab.referenceStart(servers), rtc.iceServers)));
    const offer = await a.page.evaluate(() => window.voiceLab.referenceOffer());
    const answer = await b.page.evaluate(offer => window.voiceLab.referenceAnswer(offer), offer);
    await a.page.evaluate(answer => window.voiceLab.referenceAccept(answer), answer);
    await ready();
    const recordings = await capture(label);
    if (process.env.VOICE_LAB_NETWORK && process.env.VOICE_LAB_NETWORK !== 'clean') await capture(`${label}-network`);
    await Promise.all(pages.map(page => page.evaluate(() => window.voiceLab.referenceStop())));
    return recordings;
  }
  await nativeReference('native-reference');
  const baseline = summary.comparisons.find(result => result.label === 'native-reference');
  const production = summary.comparisons.find(result => result.label === 'voxly-startup');
  for (let index = 0; index < 2; index++) {
    const actual = production.comparisons[index], reference = baseline.comparisons[index];
    assert.ok(reference.comparisonAvailable && reference.envelopeCorrelation >= 0.8, 'Native reference did not provide usable speech');
    assert.ok(actual.comparisonAvailable && actual.envelopeCorrelation >= 0.8, 'Received speech is not following the published fixture');
    assert.ok(actual.missingSpeechFraction <= reference.missingSpeechFraction + 0.05, 'Voxly loses substantially more speech than native WebRTC');
    assert.ok(actual.longestMissingSpeechMs <= Math.max(150, reference.longestMissingSpeechMs + 100), 'Voxly introduces a long speech interruption');
  }
  const states = await Promise.all([a.context.storageState(), b.context.storageState()]);
  for (const kind of (process.env.VOICE_LAB_FIXTURES ?? 'silence,noise').split(',').filter(Boolean)) {
    assert.ok(['silence', 'noise'].includes(kind));
    activeKind = kind;
    for (const [index, client] of [a, b].entries()) {
      await client.browser.close();
      Object.assign(client, await launch(kind));
      await client.context.addCookies(states[index].cookies);
      pages[index] = client.page;
      await client.page.goto(path);
    }
    await Promise.all(pages.map(joinCall)); await ready();
    const voxly = await capture(`voxly-${kind}`);
    await Promise.all(pages.map(leaveCall));
    const native = await nativeReference(`native-${kind}`);
    if (kind === 'silence') {
      for (let side = 0; side < 2; side++) {
        const received = result => result[side].recordings.find(recording => recording.stage === 'received').metrics.rms;
        assert.ok(received(voxly) <= received(native) + 0.0001, 'Voxly adds noise to digital silence compared with native WebRTC');
      }
    }
    summary.scenarios.push(kind);
  }
  assert.equal(errors.length, 0, `Browser raised ${errors.length} unhandled errors`);
  summary.status = summary.incompleteMeasurements?.length ? 'measurement-incomplete' : 'passed';
  if (summary.status === 'measurement-incomplete') process.exitCode = 2;
} catch (error) {
  summary.status = 'failed';
  // Errors from assertions contain no tokens; never persist request/response bodies.
  summary.failure = error.message;
  for (let index = 0; index < browsers.length; index++) {
    const page = browsers[index].contexts()[0]?.pages()[0];
    if (page) await writeFile(join(output, `failure-${index}.txt`), await page.locator("body").innerText().catch(() => "Page unavailable"));
  }
  console.error(`Voice lab failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close()));
  for (const child of children) child.kill();
  if (server && server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  await rm(temporary, { recursive: true, force: true });
  console.log(`Voice lab artifacts: ${output}`);
}
