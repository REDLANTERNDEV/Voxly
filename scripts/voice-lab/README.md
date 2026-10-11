# Voice audio regression lab

This lab runs **the built Voxly application**, its authenticated HTTP and
Socket.IO services, and two independent Chromium processes. It creates a fresh
SQLite installation, bootstraps two disposable Accounts through public APIs,
and uses the real UI to join/leave. It never connects to a production
installation. Authentication cookies remain in memory, and raw signaling,
addresses and tokens are not written into reports.

## Local run

Requires Node 22+, the repository dependencies, and a Playwright browser:

```sh
npm install
npx playwright install chromium
npm run build
npm run test:voice:metrics
npm run test:voice:browser
```

The default runs 100 fresh joins (alternating simultaneous and staggered),
individual rejoins, mute/deafen, a background tab, suppression toggling, fake
device replacement when available, synthetic screen audio and deafen during
screen playback. It then compares speech, digital silence and noisy speech
against a minimal native WebRTC reference. Each join requires received packets,
decoded samples, nonzero received speech energy, exactly one microphone capture,
and one playing remote microphone element. Leave must release all three.

A short development pass (POSIX shell):

```sh
VOICE_LAB_CYCLES=2 VOICE_LAB_SECONDS=8 VOICE_LAB_FIXTURES= npm run test:voice:browser
```

To check stalled audio recovery between two real browser peers in both offerer
roles, run:

```sh
VOICE_LAB_CYCLES=1 VOICE_LAB_STALLED_MEDIA=1 VOICE_LAB_RECOVERY_ONLY=1 npm run test:voice:browser
```

The lab removes a
sender's audio track without leaving the room, then requires the sender peer to
be replaced, inbound RTP to resume, and normal playback to return. This is a
targeted recovery test; the full suite still checks startup audio and the
native reference separately.

To record the entire interruption, replacement, and resumed speech in both peer
roles, run the synchronized transport scenario:

```sh
VOICE_LAB_COMPARE_ONLY=1 VOICE_LAB_TRIALS=1 VOICE_LAB_STALLED_MEDIA=1 \
  VOICE_LAB_OUTPUT=voice-lab-results/continuous-recovery npm run test:voice:browser
```

It records each fault for 30 seconds and requires a replaced sender and resumed
received speech. This remains separate from packet-loss experiments.

For intermittent first-join audio, set `VOICE_LAB_CAPTURE_EACH_JOIN=1` with
`VOICE_LAB_CYCLES` set to the desired repeat count. Each fresh join then saves
sender RTP counters, receiver buffer counters, and fixture audio, and fails if
the receiver emits less than 90% of the recording window or speech continuity
falls below the lab threshold.

An empty `VOICE_LAB_FIXTURES` skips additional silence/noise comparisons, **not**
the speech reference. `VOICE_LAB_SECONDS` defaults to 8 in the full clean lab,
9 in comparisons, and 21 for sustained loss. It must cover a complete speech
fixture and impairment schedule; the runner rejects shorter windows.
`VOICE_LAB_OUTPUT` selects a results directory
(default `voice-lab-results`). Use a separate directory for each comparison.
`PLAYWRIGHT_BROWSERS_PATH` may point to an installed temporary browser cache.

The probe is installed with Playwright only. It records synthetic fixture PCM
from the raw capture, published tracks and received streams, and observes the
real audio elements. Its silent analysis branch does not replace the production
output. CSP is bypassed **in the disposable contexts only** to load the analysis
worklet; this run is not a CSP test. Screen capture is a generated canvas and
tone: the application's publishing/subscription and playback are real, but the
OS picker and system-audio capture are not covered.

## Measurements and limits

Reports include per-window decoder loss, concealment, acceleration/deceleration
and buffer-delay rates, waveform RMS, clipping, 10 ms speech envelopes, approximate
cross-device delay, missing-speech fraction, missing-speech intervals and longest missing-speech interval.
WAV files let an engineer listen to each stage. Envelope comparison has unit
fixtures containing a known delay and a missing word, so it can fail on those
regressions. It is not a perceptual quality model or a reliable pitch/robotic
speech classifier. Browser scheduling adds uncertainty to estimated delay.

Digital silence must add no noise beyond the native reference plus a 0.0001
linear RMS tolerance. On clean speech the production path must correlate at
least 0.8 with its sender, lose no more than five additional percentage points
of active speech compared with native, and introduce no gap beyond the larger
of 150 ms or native's longest gap plus 100 ms. These are regression gates, not
claims of perfect audio. The muted publication must be below 0.0001 RMS.

No real conversation is recorded. Do not replace the fixture with private audio.
A passing synthetic run cannot resolve hardware-mute noise or certify that a
real headset sounds natural. The waveform probe uses one fixed recording clock
for capture, publication, and reception. It follows live streams every 20 ms,
disconnects retired tracks, and emits zero samples while a stage has no source.
Replacement no longer discards waveform evidence. Stream detection adds up to
one polling interval of uncertainty; this is not a hardware-output loopback test.
At the lab's default output level, received analysis follows audio-element
mute, pause, and volume. It does not certify boosted output or audio drivers.

Decoder statistics are sampled every 500 ms and calculated over disjoint stable
stream windows. Intervals spanning replacement or missing counters stay unknown;
reports include measured/unavailable time and anonymous peer replacements.
They never add counters belonging to different receiver generations. Compare
capture with received audio so sender rebuilding gaps cannot disappear from the
reference signal. Entire reception loss reports missing speech and unknown delay,
not a successful unavailable comparison.

A completed impaired recording is observational. Listen to the synthetic WAVs
and inspect numerical evidence before judging continuity. Missing-speech
intervals are an envelope-based continuity measure, not transcribed missing
words or a perceptual quality score.

## Synchronized buffering comparisons

```sh
npm run test:voice:matrix
```

On a normal host this runs three direct, clean-network trials for each of browser
default, 40 ms, and 80 ms buffering. Each trial compares Voxly with native WebRTC.
Use `VOICE_LAB_CHANNEL=chrome` on Windows to select the installed Chrome.
Reports include browser versions and loaded application asset versions.

Comparison mode (`VOICE_LAB_COMPARE_ONLY=1`) schedules synthetic speech on the
same timeline as impairment. A lab-only generated capture replaces the fake
device signal equally for Voxly and native. This bypasses device capture DSP to
isolate transport; the normal full lab still tests native capture processing and
Voxly's microphone graph. The two independent browser audio clocks retain
small scheduling uncertainty. Paired trials verify the measured capture onset
within 40 ms instead of assuming requested start times were honored. Mismatched
phase exits as `measurement-incomplete` (2). A custom fixture must fit in the
recording window, including the 250 ms lead-in.

`VOICE_LAB_TRIALS` defaults to 3. `VOICE_LAB_PROFILES` and `VOICE_LAB_ROUTES` select
comma-separated matrix profiles/routes; `VOICE_LAB_OUTPUT` selects its directory.
The matrix saves each cell plus `matrix.json`, including gaps, correction,
delay, decoder coverage, replacement counts, and candidate assessments. It
requires three paired trials, matching applied impairment times within 40 ms,
and at least 90% decoder coverage for usable evidence. A buffer candidate needs
less missing speech without worse longest gaps or speed correction, the existing
clean regression gates, at most 0.5 percentage points additional clean missing
speech and 20 ms additional clean gaps versus default, and <=100 ms added delay.
Candidates still require listening and Windows/affected-laptop acceptance.
The report always retains browser default as the production recommendation.

## Actual media impairment and self-hosted TURN

Use an isolated Docker container with NET_ADMIN; do not apply netem to the
operator's host. The image includes Coturn and shapes **UDP on loopback**,
leaving HTTP and Socket.IO traffic alone. Browser peers and the test TURN
server all run in this namespace, including its local media routes. Profiles
are 40 ± 20 ms delay, 3% packet loss, and a 500 ms outage two seconds into the
measurement. Voxly and native are each measured with the same profile; random
jitter/loss trials need repetitions, not claims of identical packet sequences.

Additional profiles use fixed schedules relative to fixture start: `burst-loss`
drops UDP for 150 ms at 2, 3.5 and 5 seconds; `delay-burst` applies 150 ms delay
for 400 ms at 2 and 4.5 seconds; `sustained-loss` drops UDP for 100 ms every
300 ms from 2 through 18 seconds. The latter records for 21 seconds to exercise
quality-triggered recovery separately from missing-sender recovery. Applied
command times are recorded because OS scheduling is not perfectly deterministic.
Shaper packet/drop counters confirm UDP traffic crossed the queue and loss
experiments actually dropped packets.
These schedules are repeatable impairments, not a model of every Wi-Fi network.

```sh
docker build -f scripts/voice-lab/Dockerfile -t voxly-voice-lab .
docker run --rm --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_ROUTE=relay -e VOICE_LAB_NETWORK=jitter \
  -e VOICE_LAB_CYCLES=100 \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab
```

For the synchronized default/40/80 matrix on both direct and self-hosted TURN
routes, including clean, burst-loss, delay-burst and sustained-loss:

```sh
docker run --rm --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_MATRIX=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-matrix \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab
```

This runs sequentially; the full direct/relay matrix can take tens of minutes.
The matrix stops on a
failed or incomplete cell and preserves the partial report. It never substitutes
HTTP throttling for UDP impairment, and refuses impairment on a non-container
host. No production voice setting is modified.

Repeat for `VOICE_LAB_ROUTE=direct` and `VOICE_LAB_NETWORK=clean`, `loss`, and
`outage`. The lab verifies the selected media route and fails rather than
calling a direct connection a successful relay test. Coturn allows loopback
peers **only in this isolated lab**; do not copy its configuration to production.
The lab requires Linux, `VOICE_LAB_ISOLATED=1` and a Docker container before applying impairment.
It verifies IPv4 UDP routes while media is connected; pending replacement
connections retain unknown decoder windows. TCP or IPv6 cannot pass a UDP impairment trial.

Run each profile with `VOICE_LAB_BUFFER` unset, `40`, and `80`; unsupported
receiver buffer control fails that experimental run explicitly. It never
changes production defaults. Compare at least three trials per configuration.
Only adopt a production target after fewer missing-speech intervals or less
speed correction, no clean-network regression, and <=100 ms additional one-way
delay are demonstrated on the supported Windows browsers. Decoder correction
counters and waveform timing must agree; a nicer indicator is insufficient.

## Recovery control experiment

Set `VOICE_LAB_RECOVERY=production` or `legacy-degradation` with
`VOICE_LAB_COMPARE_ONLY=1`. Both build disposable web assets in the lab's
temporary directory and observe the real quality controller's decisions.
`production` observes the current stall-only policy. `legacy-degradation`
restores the pre-fix loss/concealment/correction trigger and its requirement
for clear quality before confirming recovery. Historical result files named
`production` and `stall-only` refer to the policies before this production fix.
Missing-RTP/decoder-stall detection, transport recovery, negotiation, and
playback remain unchanged. Repository source and
the normal application build are never overwritten. The temporary build does
not load environment files.

For the isolated sustained-loss comparison, run each policy with the same image
and fixture, and use a separate results directory:

```sh
docker run --rm --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_CYCLES=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_ROUTE=direct -e VOICE_LAB_NETWORK=sustained-loss \
  -e VOICE_LAB_RECOVERY=production -e VOICE_LAB_MAX_QUIET_MS=1000 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/recovery-production \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/apps/web/src:/lab/apps/web/src:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab
```

Repeat with `VOICE_LAB_RECOVERY=legacy-degradation` and a different output directory.
`VOICE_LAB_MAX_QUIET_MS=1000` makes the command fail after collecting all paired
trials if any Voxly received waveform has more than one second of consecutive
quiet. This gate is specific to the lab's speech fixture with short natural
pauses; it is not a silence detector for real conversations. The summaries
retain all measured gaps and anonymous recovery decisions even when the gate
fails. Verify fixture phases, applied loss schedules, and healthy source audio
before attributing a difference to recovery.

Repeat both policies with `VOICE_LAB_NETWORK=clean`. Add
`VOICE_LAB_STALLED_MEDIA=1` to the clean `production` run to require both genuine
sender stalls to recover during the 30-second continuous recordings. No
affected member needs to participate in these tests. An affected-device check
is still needed before claiming their particular incident is resolved.

To verify the ordinary production assets, run `npm run build`, omit
`VOICE_LAB_RECOVERY`, and mount `"$PWD/apps/web/dist:/lab/apps/web/dist:ro"`
instead of the source directory. This serves the real build without controller
instrumentation or policy transforms. Use the same quiet gate and repeat clean
calls and stalled-media scenarios separately from the loss profile.

## Windows acceptance

Run from PowerShell with the installed browser channel:

```powershell
$env:VOICE_LAB_CHANNEL = 'chrome' # repeat with 'msedge'
npm run test:voice:browser
Remove-Item Env:VOICE_LAB_CHANNEL
$env:VOICE_LAB_EXECUTABLE = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
npm run test:voice:browser
```

Use the actual Brave installation path if different. Record browser versions,
headset/device connection type and the commit tested. Automated fake capture
still needs the following engineer-run checks with two Windows machines:

1. Twenty simultaneous fresh joins with each browser pairing. Speech must be
   clear in both directions without anyone leaving/rejoining.
2. Hardware-mute each headset, then UI-mute each member separately. Compare the
   local microphone test and remote sound; note which direction has noise.
3. Enable/disable additional suppression during speech and pauses. Check word
   beginnings/endings, metallic sound, and changing noise floor.
4. Change the selected headset, unplug/reconnect it, and move between foreground
   and background windows. Check mute/deafen and owner moderation remain intact.
5. Share screen audio while talking and while deafened. Stop sharing; voice
   must remain continuous and there must be no doubled playback.
6. Sustain a 30-minute call, then briefly interrupt the media network. Confirm
   recovery of the affected peer without resetting healthy peers or losing
   microphone intent.

Record pass/fail and limitations in the feature design, separately from the
synthetic results. Windows hardware acceptance is a release gate, not something
an unattended fake-device run can mark complete.
