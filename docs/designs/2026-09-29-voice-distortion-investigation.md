# Intermittent voice distortion investigation

## Outcome

Implementation follow-up: the two numerical defects below are corrected in the
[voice reliability overhaul](2026-10-03-voice-reliability-overhaul.md). The
original investigation and its unreproduced audible symptoms remain distinct.

The reported robotic, fast, squeaky voice has not been reproduced on an affected
device. No microphone, codec, playback, or recovery behavior was changed. Leaving
and rejoining resets several parts of the audio path together, so its success
does not identify which part failed.

Code review and executable checks confirmed two defects in voice quality
measurement/recovery eligibility. They do not establish the cause of the audible
distortion. This distinction matters: correcting a quality calculation is not
proof that the call will sound better.

Investigation baseline: commit `f003237`. Rechecked on 2026-10-02: both numerical
defects below remain in `apps/web/src/lib/voiceQuality.ts`, and the
production-helper probes still return the documented results. The earlier
[media lifetime investigation](2026-09-21-voice-media-lifecycle.md)
also identifies initial-join robot-like audio as unresolved; its confirmed
reload/peer-replacement fix concerns a different failure.

## Audio path reviewed

- `noiseSuppression.ts` requests browser noise suppression, automatic gain
  control, and echo cancellation. Voxly's additional filter defaults off.
- `microphoneInput.ts` creates the capture graph, with a requested 48 kHz context
  and a default-rate fallback, user gain, and separate publication/monitor
  destinations. The optional worklet receives the initial filter preference.
- `noise-suppressor.worklet.js` directly copies input blocks when disabled.
  Its existing executable DSP tests verify this from the first block; this
  does not test device capture or real-time browser scheduling.
- `useVoiceMedia.ts` publishes the generated microphone track to each peer.
  Repeated track synchronization checks existing senders by track identity.
  Peer replacement and late callbacks have identity/generation checks.
- `VoicePresentation.tsx` mounts remote audio by stream identity.
  `audioOutput.ts` uses native playback through 100%, or a context for boost
  and blocked-native-playback fallback. It mutes native hardware output after
  successfully routing the context. No application playback-rate adjustment was
  found in the reviewed browser audio path.
- `useVoiceQuality.ts` samples received audio every four seconds.
  `useListenerAudio.ts` passes targeted recovery requests to the media owner.
  Recovery normally requires two severe samples and has a 15-second cooldown.

Explicit leave disposes microphone capture and its graph, closes peer
connections, and removes remote streams. It also releases the shared output
context when unused. Rejoin creates fresh capture and peers. This is why a
successful rejoin cannot by itself distinguish capture, transport/decoder, and
playback problems.

## Confirmed recovery eligibility gap

In `voiceQuality.ts`, `gradeFor` returns `breaking` only for packet loss or
audible concealment. Acceleration/deceleration alone can only return `unstable`,
regardless of severity. However, `voiceQualityNeedsRecovery` requires the
`breaking` grade before testing its acceleration/deceleration thresholds.

Consequently, speed correction alone never requests recovery, even while the
remote member is speaking. This conflicts with the severe-resynchronization
recovery rule in `apps/web/src/lib/AGENTS.md`.

Executable probes against the compiled production helper, for one second of
emitted audio and 5,760 corrected samples:

| Input counter                    | Result                 | Correction | Eligible while speaking |
| -------------------------------- | ---------------------- | ---------- | ----------------------- |
| `removedSamplesForAcceleration`  | `unstable`, `speedUp`  | 120 ms/s   | No                      |
| `insertedSamplesForDeceleration` | `unstable`, `slowDown` | 120 ms/s   | No                      |
| `concealedSamples`               | `breaking`, `jitter`   | 120 ms/s   | Yes                     |

The [WebRTC stats specification](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-removedsamplesforacceleration)
defines these as playback speed-correction counters. These synthetic inputs
prove the recovery gap, not that such counters increase during the reported
incident, nor that an ICE restart would cure its cause.

## Confirmed buffer-delay calculation error

`voiceQualityReading` divides accumulated `jitterBufferDelay` by seconds of
emitted audio. The [specified average](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-jitterbufferdelay)
divides it by the emitted sample count instead.

For 48,000 emitted samples each delayed by 0.04 seconds:

- Accumulated delay: 1,920 seconds.
- Correct average: `1920 / 48000 * 1000 = 40 ms`.
- Current result: `1920 / 1 * 1000 = 1,920,000 ms`.

The reported buffer delay is inflated by 48,000 in this example. It affects the
quality detail shown to members. It does not control playback or drive the
current grade/recovery decision, so it cannot directly create distorted audio.
Existing unit fixtures use a nonstandard accumulated-delay value and therefore
do not catch this error.

## Reproduce the two confirmed findings

From the repository root, compile the existing web tests first:

```sh
npm run build:tests -w @voxly/web
node --input-type=module <<'JS'
import { voiceQualityReading, voiceQualityNeedsRecovery } from './apps/web/dist-test/src/lib/voiceQuality.js';
const base = {
  packetsReceived: 0, packetsLost: 0, concealedSamples: 0,
  silentConcealedSamples: 0, removedSamplesForAcceleration: 0,
  insertedSamplesForDeceleration: 0, jitterBufferDelay: 0,
  jitterBufferEmittedCount: 0
};
for (const field of ['removedSamplesForAcceleration', 'insertedSamplesForDeceleration', 'concealedSamples']) {
  const reading = voiceQualityReading(base, {
    ...base, packetsReceived: 50, jitterBufferEmittedCount: 48000,
    [field]: 5760
  });
  console.log(field, reading, voiceQualityNeedsRecovery(reading, true));
}
console.log('40 ms buffer fixture', voiceQualityReading(base, {
  ...base, packetsReceived: 50, jitterBufferEmittedCount: 48000,
  jitterBufferDelay: 48000 * 0.04
}));
JS
```

The same production-helper probes were executed during this investigation.
These are deterministic numerical checks, not an audible incident reproduction.

## Evidence needed before a voice fix

The existing download button beside the in-call voice quality indicator exports
`voxly-voice-diagnostics.json`. It records bounded measurements in memory,
without audio, account/room/device names, addresses, SDP, or authentication
tokens. It does not upload automatically. Reload and logout clear the history;
leaving and rejoining retain recent calls for comparison.

For the next occurrence:

1. The affected speaker and one affected listener download diagnostics while
   distortion is present, before leaving or reloading.
2. Note the direction of the bad audio, approximately when it started, whether
   all listeners hear the same speaker badly, browsers/operating systems, and
   whether the extra filter or effective output boost is enabled.
3. Leave/rejoin as usual, then download again from both sides once audio clears.
   Note who rejoined and approximately when.
4. If practical, compare the affected speaker's microphone test with what the
   listener hears. It shares the active processed microphone graph; starting
   it temporarily deafens the speaker, so perform this deliberately.

If the processed microphone test is also bad, investigate capture/processing
with that affected device. If it is clean but the listener's correction or
concealment counters rise, investigate the measured media path. If received
counters look normal while playback sounds bad, investigate output scheduling
and routing. Normal counters cannot prove correct pitch or waveform quality;
additional device-side reproduction may still be needed. The four-second
sampling interval can also miss brief disturbances.

Implement a voice change only after the relevant failure is reproduced or
incident evidence identifies the failing stage. The two confirmed numerical
defects can be corrected with focused regression tests as a separate quality
measurement/recovery change, without claiming that it solves the reported
distortion.

## Verification limits

On 2026-10-02, the compiled production helper again returned `unstable` and no
recovery eligibility for each 120 ms/s speed-correction input. The 40 ms buffer
fixture returned 1,920,000 ms. These reproduce the two numerical findings only.

No affected-device microphone, audible browser-to-browser reproduction, or
production TURN-path test was available. Automated coverage cannot certify that
the reported audio distortion is resolved. Retain this investigation until the
findings are resolved or transferred to another maintained issue record.
