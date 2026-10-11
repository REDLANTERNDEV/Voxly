# Windows Chrome voice-gap investigation

## Outcome and scope

The production client now preserves progressing audio under packet loss instead
of replacing the peer because quality is `breaking`. Confirmed microphone stalls
still trigger recovery after two observations with the existing cooldown; failed
or disconnected transport recovery remains independent. Resumed decoder progress
settles media recovery even when loss persists, preventing the old deadline from
replacing audio that has returned. Quality grades and Chrome's default buffering
remain unchanged. Shared contracts, persistence, and deployment configuration
are unchanged. The fix is in the working tree and has not been deployed.

The lab reproduced multi-second received silence during severe synthetic
sustained loss. A subsequent controlled experiment isolated degradation-triggered
recovery: the current policy produced 6.4-second gaps in two of three calls,
while the stall-only control avoided them in all three. This establishes a
reproducible application regression without the affected members' participation.
Validation of their particular Windows/laptop incident remains pending.

The initial user-approved scope was investigation only. The production fix was
added after the subsequent request to apply the independently reproduced repair.

The report concerns two Windows Chrome PWA members on Wi-Fi in different homes.
Other members using Ethernet describe stable voice since the recent update.
Wi-Fi is a possible contributor, not an established cause. The affected members'
loaded PWA versions and diagnostic counters remain unverified.

Investigation baseline: `64622594`, with the lab changes in this working tree.
The [lab guide](../../scripts/voice-lab/README.md) documents reproducible commands,
measurements, and acceptance limits. Synthetic WAVs and reports are kept locally
under ignored `voice-lab-results/wifi-investigation-20261011/`; no conversation,
authentication tokens, addresses, or raw signaling are saved.

## Changes to the investigation

- Select the account menu inside the footer so the sidebar's second copy does
  not stop the settings scenario.
- Use the same scheduled synthetic capture in Voxly and the native WebRTC
  reference for transport comparisons. Measure actual capture onset and reject
  pairs differing by more than 40 ms. Device capture DSP is bypassed equally in
  this mode; the full lab retains native fake-device capture and its processing.
- Apply fixed UDP loss and delay bursts relative to fixture start, record actual
  command times, and reject non-IPv4/non-UDP measurement routes. Shaping is
  restricted to the disposable Linux container namespace.
- Record on fixed capture, publication, and reception clocks. Follow replacement
  streams every 20 ms and retain silence while no stream is attached. Compare
  capture with reception so rebuilding the sender cannot erase the interruption.
- Sample decoder counters every 500 ms. Combine disjoint stable windows, retain
  unknown windows around receiver replacement, and record anonymous replacement
  times. Missing counters never become zero loss or zero correction.
- Run browser default, 40 ms, and 80 ms buffer experiments sequentially, with
  three Voxly/native pairs per configuration. Keep genuine sender stalls separate
  from sustained packet loss.

The main profiles are three 150 ms total-loss bursts; two 400 ms periods of
150 ms delay; and 100 ms total-loss bursts every 300 ms for 16 seconds. The last
profile records for 21 seconds to observe recovery during sustained degradation.
These profiles test specific transport stresses rather than simulate a particular
Wi-Fi installation.

## Clean-network results

On macOS with Playwright Chromium `153.0.8010.12`, each buffer configuration
completed three pairs in both directions. The loaded application module was
`/assets/index-ChWR-Rvx.js`. Capture-phase differences were 0–30 ms and complete
decoder-window coverage was approximately 98.4–98.6%.

| Buffer target   | Mean estimated Voxly delay | Mean missing active speech | Longest missing active speech | Peer replacements |
| --------------- | -------------------------- | -------------------------- | ----------------------------- | ----------------- |
| Browser default | 76.7 ms                    | 0%                         | 0 ms                          | 0                 |
| 40 ms           | 86.7 ms                    | 0.084%                     | 10 ms                         | 0                 |
| 80 ms           | 110 ms                     | 0%                         | 0 ms                          | 0                 |

All three configurations passed the existing clean regression gates. The 80 ms
target added roughly 33 ms mean estimated delay to a default path already showing
no missing speech. Clean measurements provide no reason to change production.
These estimates include browser scheduling uncertainty and are not hardware
output latency measurements.

The full browser lab also passed two fresh join cycles, individual rejoins,
mute/deafen, backgrounding, device replacement, suppression toggling, synthetic
screen audio, deafen during screen audio, digital silence, and noisy speech.
The normal speech comparisons reported no missing active speech in this run.

## Stalled-media results

A separate continuous run removed the published audio track without leaving the
room. Both peer roles replaced the stalled sender and resumed received speech
within the 30-second recording. Replacement observations occurred around 10
seconds; one role also had a second replacement around 20 seconds. The waveform
and unavailable decoder windows persisted through those changes.

The longest missing-active-speech interval was 490 ms in the affected directions.
This measures missing portions within active speech; natural pauses split those
intervals, so it does not mean the complete stall lasted only 490 ms. The full
WAV and its quiet-duration metrics retain the complete interruption. Missing
decoder coverage around a stall is explicitly unknown and cannot qualify a
buffering recommendation.

This injected missing-sender fault is different from the reported Wi-Fi symptom.
It verifies the recorder's continuity and the existing recovery path, not a fix
for the affected laptop.

## Isolated UDP observations

The Linux container image built successfully with the current lockfile and the
same application module and Chromium version as the macOS matrix. The current
lab scripts were mounted read-only for execution. Docker published no host ports;
NET_ADMIN applied only inside its disposable network namespace.

An initial browser-default direct-route burst-loss pair measured 130–140 ms
longest missing active speech in Voxly and 120 ms in native WebRTC. Missing active
speech was approximately 3.0–4.7% in Voxly and 2.4–2.5% in native. The shaper
recorded 50 and 48 dropped UDP packets respectively. Neither path replaced a
peer. Capture-phase differences were 20–30 ms. This confirms that the harness
delivers and records transport interruptions; one pair cannot establish a
buffering recommendation or reproduce the affected laptop's cause.

The complete Linux direct-route matrix finished 36 paired trials across 12
configurations. Each row combines three pairs in both directions. Correction
rates below combine acceleration and deceleration over known decoder windows.

| Profile        | Buffer target | Missing active speech | Longest missing interval | Mean delay | Correction (ms/s) | Replacement observations | Evidence usable |
| -------------- | ------------- | --------------------- | ------------------------ | ---------- | ----------------- | ------------------------ | --------------- |
| Clean          | Default       | 0.06%                 | 10 ms                    | 71.7 ms    | 0.05              | 0                        | Yes             |
| Clean          | 40 ms         | 0.06%                 | 10 ms                    | 91.7 ms    | 0                 | 0                        | Yes             |
| Clean          | 80 ms         | 0.17%                 | 10 ms                    | 115 ms     | 0.62              | 0                        | Yes             |
| Burst loss     | Default       | 3.27%                 | 150 ms                   | 71.7 ms    | 0.58              | 0                        | Yes             |
| Burst loss     | 40 ms         | 3.23%                 | 140 ms                   | 85 ms      | 0.67              | 0                        | Yes             |
| Burst loss     | 80 ms         | 3.19%                 | 160 ms                   | 116.7 ms   | 2.98              | 0                        | Yes             |
| Delay burst    | Default       | 5.71%                 | 130 ms                   | 210 ms     | 1.59              | 0                        | Yes             |
| Delay burst    | 40 ms         | 5.27%                 | 110 ms                   | 206.7 ms   | 1.21              | 0                        | Yes             |
| Delay burst    | 80 ms         | 4.61%                 | 100 ms                   | 220 ms     | 1.08              | 0                        | Yes             |
| Sustained loss | Default       | 26.84%                | 490 ms                   | 75 ms      | 13.65             | 8                        | No              |
| Sustained loss | 40 ms         | 17.76%                | 490 ms                   | 83.3 ms    | 12.94             | 7                        | No              |
| Sustained loss | 80 ms         | 26.49%                | 490 ms                   | 116.7 ms   | 19.64             | 8                        | No              |

Replacement observations count new peers at each endpoint; they are not
deduplicated recovery operations. Sustained-loss decoder rates describe only
known windows and cannot fairly assess the missing replacement intervals.

Both fixed targets passed the numerical candidate gates for delay bursts, with
maximum matched-trial added delay of 40 ms and 60 ms respectively. Neither passed
the burst-loss gates: 40 ms increased correction, while 80 ms increased both the
longest gap and correction. No sustained-loss candidate qualified. Audible
improvement and Windows acceptance have not been checked, so retain browser
default in production.

The sustained-loss default native reference averaged 5.73% missing active speech
with no replacements, compared with Voxly's 26.84%. In the first Voxly trial,
received quiet periods lasted 6.42–6.44 seconds, while capture/publication quiet
periods were only 270–300 ms. Native reception's longest quiet period was 330 ms.
The original peer remained connected and its received packet count increased
from 413 to 464 between approximately 8 and 9.5 seconds, before replacement near
10 seconds. This distinguishes degradation with continuing RTP from the separate
missing-sender fault. This initial observation motivated the controlled recovery
comparison below; it does not identify the affected laptop's failure.

A separate isolated netem check confirmed that changing the queue back to
`loss 0%` clears its injected delay. The default delay-burst trial's measured
decoder buffer averaged about 127 ms. Persisting browser delay after a burst
therefore remains part of the observed comparison, rather than an uncleared
shaper setting.

A single browser-default burst-loss pair also passed through local Coturn on
verified IPv4 UDP routes. Capture-phase differences were 10 ms. Voxly's longest
missing active-speech intervals were 130–140 ms; native's were 100 ms. The shaper
counted 53 and 49 dropped packets respectively, with no replacements. This is a
relay smoke test; the repeated matrix covered direct routes only.

## Recommendation gates and remaining acceptance

The matrix only marks a candidate for Windows validation after at least three
phase-aligned pairs, matching impairment command times within 40 ms, and at least
90% complete decoder coverage in both Voxly and the native reference. A candidate
must reduce missing speech without worse longest gaps or speed correction, pass
the clean gates, and add at most 100 ms estimated delay in every matched trial
direction. Clean speech may add at most 0.5 percentage points missing speech and
20 ms longest missing-speech interval versus browser default.

Buffering adoption still requires repeated audible improvement in the saved
synthetic WAVs and repeated Windows Chrome runs. An affected-laptop call is needed
before claiming that particular incident is fixed. The independently reproduced
recovery regression can be repaired without that member's participation.
Envelope omissions are not transcribed missing words or a perceptual
quality score. The lab does not certify headset DSP, boosted playback, audio
drivers, PWA background behavior on Windows, or a deployed TURN route.

For the affected call, verify both loaded PWA versions, record browser versions,
note the bad direction and approximate time, and export the existing voice
diagnostics from speaker and listener while the gap is occurring. Repeat after
recovery. This remains a validation requirement, not a prerequisite for continuing
the synthetic investigation.

## Historical recovery control experiment

Affected members are currently unavailable for a paired call or diagnostics
export. Continue with the independent lab reproduction; their participation is
needed to validate their particular incident, not to diagnose a reproducible
application regression.

At this stage the lab built two temporary, instrumented versions without editing any
application source. `VOICE_LAB_RECOVERY=production` preserves the recovery
policy. `VOICE_LAB_RECOVERY=stall-only` changes only the degradation predicate
`voiceQualityNeedsRecovery` to false; the real stalled-media predicate,
transport recovery, signaling, negotiation, and playback remain intact. Both
versions record anonymous controller decisions, including whether the trigger
was degradation or a genuine stall. Environment files are not loaded by these
temporary builds.

Run three paired trials under the same sustained-loss schedule, inspect waveform
coverage and fixture phase, and compare clean calls separately. The optional
`VOICE_LAB_MAX_QUIET_MS=1000` assertion provides a failing command for multi-second
silence in this speech fixture. Retain separate forced missing-sender tests in
both roles to ensure the control still exercises genuine recovery.

The sustained-loss runs completed with Chromium `153.0.8010.12` in the same
isolated image, default buffering, three calls per policy, and two recorded
directions per call. The instrumented production module was
`/assets/index-CUoyuTMA.js`; the stall-only module was
`/assets/index-D0MX4riq.js`.

| Recovery policy | Longest received quiet | Mean missing active speech | Replacement observations | One-second quiet gate                |
| --------------- | ---------------------- | -------------------------- | ------------------------ | ------------------------------------ |
| Current policy  | 6,440 ms               | 25.10%                     | 8                        | Failed: four directions in two calls |
| Stall only      | 360 ms                 | 5.37%                      | 0                        | Passed: all six directions           |

The first production call recovered quickly (340–360 ms longest quiet). The
next two had 6,400–6,440 ms quiet periods. All three control calls stayed within
340–360 ms. Capture remained healthy, with 270–280 ms longest quiet in both
policies. The control still lost hundreds of UDP packets in each trial.

Each production call made one degradation recovery request with `stalled: false`
and `eligible: true`, near 9.8 seconds. In a failing call, the connected original
receiver's packet count increased from 328 to 461 and its emitted sample count
from 314,880 to 454,080 over the four seconds before the request. The long gap
followed peer replacement rather than a pre-existing missing-sender stall.

The actual production/control applied schedules matched within 15 ms in every
trial, and their measured capture phases differed by at most 10 ms. One
production/native reference pair had a 101 ms shaper timing mismatch
and must be excluded from native-reference acceptance. The policy-to-policy
comparison remains separate from the buffering recommendation gates. Decoder windows spanning
replacement remain unknown, so the comparison uses continuous waveforms rather
than pretending the absent decoder counters were healthy.

Both policies also completed three clean pairs, passed the existing native
regression gates, and had approximately 98.3–98.5% decoder coverage. Mean
estimated delay was 70 ms for both; the maximum added delay in a matched direction
was 10 ms. Mean missing active speech was 0.028% for production and 0.140% for
the control, within the predeclared 0.5 percentage point aggregate allowance.
Both had a 10 ms longest missing-active-speech interval and no replacements.
This establishes numerical clean acceptance, not headset/perceptual acceptance.

The control's separate 30-second missing-sender scenarios passed in both roles:
peers were replaced and received speech returned. Each controller request had
`stalled: true`, `eligible: false`; disabling the degradation predicate did not
disable stall recovery. Complete quiet during these genuine faults still reached
11.52–17.91 seconds, and one direction had an additional 6.44-second interruption
during repair. These results certify eventual recovery in the scenario, not
fast or seamless repair. Recovery/negotiation timing remains a separate issue
to improve rather than something this control fixes.

The experiment's corrective direction was to preserve media that is still progressing under
packet loss and let Chrome conceal short losses, while retaining genuine
stalled-media and failed-transport recovery. Quality measurements can continue
to show degradation. These control runs changed only temporary lab assets.
The production implementation and verification are described below; neither
comparison certifies the affected laptop.

The four historical commands for this control used the baseline image and read-only lab
scripts. The production-loss command exited 1 because its new continuity
assertion caught the regression after recording all three pairs. The other
three commands exited 0. Reports, including `comparison.json`, are under
`voice-lab-results/wifi-investigation-20261011/recovery-control/`.

These commands document the pre-fix lab revision. The current guide uses
`production` for the fixed client and `legacy-degradation` to reproduce the old
policy; the historical `stall-only` experiment name is no longer accepted.

```sh
docker run --rm --name voxly-recovery-production-20261011 --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_CYCLES=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_ROUTE=direct -e VOICE_LAB_NETWORK=sustained-loss \
  -e VOICE_LAB_RECOVERY=production -e VOICE_LAB_MAX_QUIET_MS=1000 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/recovery-control/production-loss \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation

docker run --rm --name voxly-recovery-stall-only-20261011 --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_CYCLES=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_ROUTE=direct -e VOICE_LAB_NETWORK=sustained-loss \
  -e VOICE_LAB_RECOVERY=stall-only -e VOICE_LAB_MAX_QUIET_MS=1000 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/recovery-control/stall-only-loss \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation

docker run --rm --name voxly-recovery-clean-production-20261011 --shm-size=1g \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_CYCLES=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_ROUTE=direct -e VOICE_LAB_NETWORK=clean \
  -e VOICE_LAB_RECOVERY=production -e VOICE_LAB_MAX_QUIET_MS=1000 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/recovery-control/production-clean \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation

docker run --rm --name voxly-recovery-clean-stall-only-20261011 --shm-size=1g \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_CYCLES=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_ROUTE=direct -e VOICE_LAB_NETWORK=clean \
  -e VOICE_LAB_RECOVERY=stall-only -e VOICE_LAB_STALLED_MEDIA=1 -e VOICE_LAB_MAX_QUIET_MS=1000 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/recovery-control/stall-only-clean \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation
```

Additional verification: `npm run test:voice:metrics` (19 passed),
`npx eslint scripts/voice-lab`, Prettier checks, and `git diff --check`.

## Production implementation and verification

`VoiceQualityController` now requests media recovery only for confirmed stalls.
The former degradation predicate and its unused recovery wrapper were removed
from application code. Quality readings remain unchanged. A fresh fully measured
sample with progressing audio also confirms recovery despite a `breaking` grade,
so a previously armed media deadline cannot replace audio that has resumed.
Transport repair, two-sample eligibility, generation checks, and the 15-second
cooldown remain intact. The library guide and operator troubleshooting document
describe the new behavior.

Before the fix, focused controller regressions failed both the progressing-audio
and resumed-audio cases. After the fix, they passed. A further lifecycle test
executes the real controller and media-owner callbacks together, proving that
resumed audio under continued loss cancels the pending deadline before expiry.

The real production build, `/assets/index-frPBUghA.js`, was served read-only in
the isolated container with **no** `VOICE_LAB_RECOVERY` override or controller
instrumentation. Three direct sustained-loss pairs passed the one-second quiet
gate. Longest received quiet per pair was 360/360, 360/380, and 350/360 ms;
there were no peer replacements. Mean missing active speech was 5.71%, versus
25.10% in the historical pre-fix policy run; native WebRTC averaged 5.49% in the
new comparison. The longest missing-active-speech interval was 100 ms.

All three native pairs had capture-phase differences of 10–20 ms and matched
applied impairment schedules. The fixed client and historical policy schedules
matched within 15 ms per trial. Decoder coverage was approximately 99.3%, and
the shaper counted 612, 618, and 617 dropped UDP packets in the Voxly trials.
These are actual loss measurements, not an unimpeded call labeled as degraded.

Three clean pairs also passed the predeclared numerical regression gates.
Estimated delay was 70 ms in every fixed-client direction, identical to the
historical clean baseline: maximum matched added delay was 0 ms. Mean missing
active speech was 0.084%, versus 0.028% previously, within the 0.5 percentage
point allowance. Both had a 10 ms longest missing-active-speech interval. The
fixed client had no replacements and 340–350 ms longest received quiet; paired
capture phases differed by 0–20 ms and decoder coverage was 98.3–98.5%.

Both separate 30-second missing-sender scenarios passed: the stalled sender
was replaced and received speech returned in the final two seconds in both
directions. Complete quiet during those genuine faults still reached
11.23–17.89 seconds, with an additional 6.43-second opposite-direction repair
interruption in one case. That slow repair is preserved, not fixed by this
change. The one-second quiet gate applies to progressing transport trials,
not to intentional missing-sender faults.

Results and the comparison are retained locally under
`voice-lab-results/wifi-investigation-20261011/production-fix/`. The latest
production-build runs covered direct routes; relay evidence above remains
the earlier smoke test. Numerical acceptance does not establish perceptual
or Windows hardware acceptance.

Production verification commands:

```sh
npm run build
npm test
npm run test -w @voxly/web
npx eslint apps/web/src/lib/voiceQuality.ts apps/web/src/lib/voiceQualityController.ts apps/web/src/lib/voicePeerRecovery.ts apps/web/test/voice-quality*.test.ts scripts/voice-lab
git diff --check

docker run --rm --name voxly-voice-fixed-loss-20261011 --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_CYCLES=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_ROUTE=direct -e VOICE_LAB_NETWORK=sustained-loss \
  -e VOICE_LAB_MAX_QUIET_MS=1000 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/production-fix/direct-loss \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/apps/web/dist:/lab/apps/web/dist:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation

docker run --rm --name voxly-voice-fixed-clean-20261011 --shm-size=1g \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_CYCLES=1 -e VOICE_LAB_TRIALS=3 \
  -e VOICE_LAB_ROUTE=direct -e VOICE_LAB_NETWORK=clean \
  -e VOICE_LAB_STALLED_MEDIA=1 -e VOICE_LAB_MAX_QUIET_MS=1000 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/production-fix/direct-clean \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/apps/web/dist:/lab/apps/web/dist:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation
```

The build and full root suite passed. The subsequent web run, including the
new combined lifecycle regression, passed 979 tests; the lab suite passed 19.
Focused lint and formatting checks passed. Root lint retained 91 existing
warnings in unchanged React lifecycle code; the build retained its existing
large-chunk warning. The production source has no lab observer or debug logging.
Windows hardware/perceptual acceptance and the affected member's particular
incident remain unverified. No changes were staged, committed, or deployed.

## Initial investigation verification

Commands run from the repository root:

```sh
npm run build
npm run test -w @voxly/web
npx eslint scripts/voice-lab
npm run test:voice:metrics
VOICE_LAB_CYCLES=2 VOICE_LAB_OUTPUT=voice-lab-results/wifi-investigation-20261011/acceptance npm run test:voice:browser
VOICE_LAB_COMPARE_ONLY=1 VOICE_LAB_CYCLES=1 VOICE_LAB_TRIALS=1 VOICE_LAB_SECONDS=9 VOICE_LAB_STALLED_MEDIA=1 VOICE_LAB_OUTPUT=voice-lab-results/wifi-investigation-20261011/recovery npm run test:voice:browser
VOICE_LAB_PROFILES=clean VOICE_LAB_ROUTES=direct VOICE_LAB_TRIALS=3 VOICE_LAB_OUTPUT=voice-lab-results/wifi-investigation-20261011/matrix npm run test:voice:matrix
git diff --check
```

The isolated image and direct matrix were also run:

```sh
docker build -f scripts/voice-lab/Dockerfile -t voxly-voice-lab:wifi-investigation .
docker run --rm --name voxly-wifi-matrix-20261011 --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_MATRIX=1 -e VOICE_LAB_TRIALS=3 -e VOICE_LAB_ROUTES=direct \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/linux-matrix \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation
docker run --rm --name voxly-wifi-relay-smoke-20261011 --cap-add=NET_ADMIN --shm-size=1g \
  -e VOICE_LAB_ROUTE=relay -e VOICE_LAB_NETWORK=burst-loss \
  -e VOICE_LAB_COMPARE_ONLY=1 -e VOICE_LAB_TRIALS=1 -e VOICE_LAB_CYCLES=1 \
  -e VOICE_LAB_OUTPUT=/lab/voice-lab-results/wifi-investigation-20261011/linux-relay-smoke \
  -v "$PWD/scripts/voice-lab:/lab/scripts/voice-lab:ro" \
  -v "$PWD/voice-lab-results:/lab/voice-lab-results" voxly-voice-lab:wifi-investigation
```

Build, 976 web tests, 17 lab tests, ESLint, both browser scenarios, the clean
buffer matrix, and whitespace verification passed. Browser tests required local
loopback permission in the sandbox. The Linux direct matrix completed with
matched schedules and paired fixture phases in every cell; sustained-loss rows
retain incomplete decoder evidence. The relay smoke test also passed.
Docker Desktop was started for the isolated
UDP investigation; no shaping was applied to the host.
