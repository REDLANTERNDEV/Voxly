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

For intermittent first-join audio, set `VOICE_LAB_CAPTURE_EACH_JOIN=1` with
`VOICE_LAB_CYCLES` set to the desired repeat count. Each fresh join then saves
sender RTP counters, receiver buffer counters, and fixture audio, and fails if
the receiver emits less than 90% of the recording window or speech continuity
falls below the lab threshold.

An empty `VOICE_LAB_FIXTURES` skips additional silence/noise comparisons, **not**
the speech reference. `VOICE_LAB_SECONDS` defaults to 8 and must cover at least one complete speech
fixture; the runner rejects shorter windows. `VOICE_LAB_OUTPUT` selects a results directory
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
cross-device delay, missing-speech fraction and longest missing-speech interval.
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
real headset sounds natural. The waveform probe taps the streams present when
a recording starts. A changed or disappeared receiver invalidates that
comparison: WAVs remain available, decoder rates are explicitly unavailable,
and an impaired run exits with status `measurement-incomplete` (exit code 2).
It must not be counted as a healthy or passing impaired-audio comparison.
A completed impaired recording is observational: compare its measurements and
listen to the WAVs before judging continuity. The clean-speech assertions do
not automatically grade impaired speech. Outages have the same duration and
offset within each recording, but the looping fixture phase is not synchronized
between Voxly and native; different word/pause positions can change the longest
detected missing-speech interval. Repeated, phase-controlled comparisons are
needed before attributing an outage difference to an audio stage.

## Actual media impairment and self-hosted TURN

Use an isolated Docker container with NET_ADMIN; do not apply netem to the
operator's host. The image includes Coturn and shapes **UDP on loopback**,
leaving HTTP and Socket.IO traffic alone. Browser peers and the test TURN
server all run in this namespace, including its local media routes. Profiles
are 40 ± 20 ms delay, 3% packet loss, and a 500 ms outage two seconds into the
measurement. Voxly and native are each measured with the same profile; random
jitter/loss trials need repetitions, not claims of identical packet sequences.

```sh
docker build -f scripts/voice-lab/Dockerfile -t voxly-voice-lab .
docker run --rm --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_ROUTE=relay -e VOICE_LAB_NETWORK=jitter \
  -e VOICE_LAB_CYCLES=100 \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab
```

Repeat for `VOICE_LAB_ROUTE=direct` and `VOICE_LAB_NETWORK=clean`, `loss`, and
`outage`. The lab verifies the selected media route and fails rather than
calling a direct connection a successful relay test. Coturn allows loopback
peers **only in this isolated lab**; do not copy its configuration to production.
The lab requires Linux, `VOICE_LAB_ISOLATED=1` and a Docker container before applying impairment. It verifies IPv4 UDP media routes; TCP or IPv6 cannot pass a UDP impairment trial.

Run each profile with `VOICE_LAB_BUFFER` unset, `40`, and `80`; unsupported
receiver buffer control fails that experimental run explicitly. It never
changes production defaults. Compare at least three trials per configuration.
Only adopt a production target after fewer missing-speech intervals or less
speed correction, no clean-network regression, and <=100 ms additional one-way
delay are demonstrated on the supported Windows browsers. Decoder correction
counters and waveform timing must agree; a nicer indicator is insufficient.

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
