# Voice reliability overhaul

## Implemented stages

The engineer lab uses two authenticated disposable Accounts and the built
application's real join, signaling, microphone graph and playback paths.
Playwright is a development dependency. Raw capture, publication and reception
of synthetic fixtures are preserved as WAV files with numerical measurements.
A test-only native WebRTC reference uses the same capture constraints and ICE
configuration. No member conversation, credential or SDP is written to artifacts.
See [lab instructions](../../scripts/voice-lab/README.md).

The confirmed measurement defects were reproduced with failing tests before
fixing them. Average buffer delay now uses delta jitterBufferDelay divided by
delta jitterBufferEmittedCount, multiplied by 1000, per the
[WebRTC statistics specification](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-jitterbufferdelay).
Acceleration or deceleration of at least 60 ms per emitted second now qualifies
as breaking. Recovery still requires expected speech, two consecutive severe
samples and a 15-second cooldown.

The quality controller owns measurements and requests only. Baselines follow
peer and inbound-stream identity, including track/SSRC replacement. Missing
measurements remain measuring; stopped receivers cannot pollute live-stream
measurements. Actual recovery attempts have separate English/Turkish copy from
observed instability. Signaling ping does not stand in for media quality.
Fresh clear measurements confirm quality recovery through the existing hook.

Ownership moved in small steps behind the public voice hook: MicrophoneOwner
owns active capture graph adoption/disposal; VoicePeerOwner owns peer lifetime,
generations and receiver identities; the existing playback owner remains in
place. Negotiation and recovery sequencing remain in the orchestrator. This is
an incremental refactor, not a complete replacement of the voice stack.

## Evidence and limits

On macOS Chromium, 100 alternating simultaneous/staggered fresh joins passed
without a missing decoded speech signal, duplicate microphone playback or
manual rejoining. The first acceptance run also passed individual rejoining,
mute/deafen, background-tab, fake device replacement, suppression toggling,
synthetic screen audio and screen audio under deafen. Speech, silence and noisy
speech comparisons passed against native WebRTC. Startup envelope correlation
was 0.977–0.982, estimated delay 60–70 ms, and longest detected missing speech
20–30 ms; native measured 0.973–0.981, 50–60 ms and 10–30 ms respectively.
These are synthetic regression measurements, not perceptual or headset proof.
Artifacts stay in ignored voice-lab-results directories.

Focused controller and owner regressions, npm run typecheck, npm test (1,694
tests including lab metric tests), npm run build and git diff --check passed.
The complete final browser run also passed 100 joins and all ten scenarios in
voice-lab-results/final/summary.json. The follow-up after tightening unavailable
metric baselines also passed 100 fresh joins, speech reference and lifecycle
scenarios (voice-lab-results/final-counter-check/summary.json); silence/noise
fixtures were not repeated in that follow-up.

The Docker Hub retry succeeded on 2026-10-03. The isolated Linux image built,
and the clean direct-route smoke test passed both fixture directions. The
self-hosted Coturn clean run passed 100 fresh joins and all fixture/lifecycle
comparisons. UDP jitter, loss and outage recordings completed on direct and
relay routes, with verified IPv4 UDP candidates. HTTP throttling was not used.

Two original TURN impairment recordings changed receiver generations and lack
matched decoder counters. Their original artifacts remain preserved; they are
not accepted audio comparisons. A failing regression reproduced a lab-reporting
bug: disappeared receivers yielded an empty rate list. The fix explicitly marks
those receivers unavailable and invalidates comparisons attached to the initial
streams. Impaired runs now report measurement-incomplete (exit code 2) rather
than treating such recordings as passing. All six lab metric tests passed and
the corrected Docker image rebuilt successfully. No production voice behavior
changed during these retries. Verification used docker build, disposable Docker
runs, npm run test:voice:metrics (6 passing tests), node --check on the runner,
and git diff --check. All lab containers exited; the reusable image is retained.

The repeated TURN loss recording has usable counters and a longest detected gap
of 20 ms, versus 10–30 ms in native WebRTC. The repeated TURN outage recording
measured 280/190 ms gaps versus 150/150 ms in native. This is a result to
investigate, not a proven production regression: the 500 ms outage has the same
measurement offset, but the looping fixture's word/pause phase is not aligned
between paths. The further repeat measured 220/200 ms in Voxly versus 270/270 ms in native
and passed with complete decoder windows. The larger Voxly gap did not repeat;
these results show trial variation, not a consistent Voxly-specific regression.

Measured longest missing-speech interval per trial (maximum of two directions):

| Route | Impairment | Voxly | Native |
| --- | --- | --- | --- |
| Direct | 40 ± 20 ms jitter | 10 ms | 10 ms |
| Direct | 3% packet loss | 10 ms | 10 ms |
| Direct | 500 ms outage | 290 ms | 300 ms |
| TURN | 40 ± 20 ms jitter | 50 ms | 50 ms |
| TURN | 3% packet loss, repeat | 20 ms | 30 ms |
| TURN | 500 ms outage, repeat | 280 ms | 150 ms |
| TURN | 500 ms outage, verification | 220 ms | 270 ms |

Each impairment run used two fresh joins before degrading the established call.
These are individual synthetic trials; random impairment and fixture phase
limit causal comparisons. The original artifacts, corrected repeats and derived
reviews are in ignored voice-lab-results/docker-retry. Continuous waveform
measurement across a receiver replacement remains a harness limitation, and
these trials do not prove recovery improves audible continuity. Browser buffer
40/80 ms trials and Windows hardware acceptance remain pending; browser defaults
are retained.

Windows Chrome, Edge and Brave headset checks remain a release gate. Hardware
mute electrical noise and perceived first-join robotic speech remain explicitly
unresolved. Synthetic capture cannot reproduce headset electronics. The lab's
OS screen picker, real system-audio capture, autoplay prompts and CSP enforcement
are also outside the synthetic run.

## Rollout boundaries

Keep measurement corrections, ownership refactoring and the engineer lab as
separately reviewable changes. No capture constraints, suppression algorithm,
production receiver buffer target, codec, wire contract, database or hosted
service changed. There is no proven failing audio stage to replace yet.

The lab can compare browser default, 40 ms and 80 ms receiver targets without
changing production. Ship a target only after repeatable impaired-network
improvement, no clean-network regression and at most 100 ms added one-way delay
on supported Windows browsers. Record Windows hardware results and impairment
artifacts here before claiming the audible symptoms resolved.
