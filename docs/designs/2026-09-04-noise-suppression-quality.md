# Microphone Noise Suppression Audio Quality Design

## Problem

Voxly's microphone capture path runs the browser's native audio processing and
also enables its own spectral noise filter by default. On some microphones,
these two layers together produce metallic or crackly speech artifacts. The
artifact disappears when the additional noise suppression control is disabled
in Voxly's settings.

## Goals

- Keep default microphone audio natural and stable.
- Keep the browser's native noise suppression enabled.
- Make Voxly's additional filter explicitly opt-in without removing it.
- Safely disable legacy preferences that were saved as enabled by default.
- Leave voice calls, microphone testing, device switching, and the existing
  WebRTC lifecycle unchanged.

## Out of scope

- Adding a new DSP library or third-party audio provider.
- Trying to disable the browser's native noise suppression through the user
  preference.
- Changing the peer-to-peer voice architecture.
- Redesigning the existing spectral processor in this change.

## Design

### Capture layer

`microphoneProcessingConstraints()` continues to request these browser audio
processing flags:

- `noiseSuppression: true`
- `autoGainControl: true`
- `echoCancellation: true`

These settings are sent as plain boolean constraints when the device is opened.
Voxly's additional filter remains in the Web Audio graph and does not alter the
browser processing layer.

### Preference and migration

`DEFAULT_NOISE_SUPPRESSION` becomes `false`. The preference key changes to
`v2`. As a result, a `true` value stored under `v1`, which represented the old
default, is ignored; users use only the browser's native processing until they
explicitly enable Voxly's additional filter. The old key does not need to be
deleted because it is no longer read.

When `createMicrophoneInput` is called directly, its fallback is also disabled.
Passing `noiseSuppression: true` explicitly continues to use the existing
AudioWorklet and expander paths.

### User interface

The existing switch remains available. Its hint makes clear that it controls
Voxly's optional additional filter rather than the browser's native filter.
English and Turkish copy are updated together.

### Testing and verification

- Verify that the default preference is disabled.
- Verify that a legacy `v1` value of `true` does not enable the new default.
- Verify that `v2` preferences remain independent per user.
- Verify that browser capture constraints still request all three processing
  flags.
- Verify that explicitly enabling the filter preserves the existing live graph
  and microphone test behavior.
- Run the web workspace tests, typecheck, build, and `git diff --check`.

## Failure behavior

If the additional filter is unsupported, preserve the existing recoverable
fallback. Native browser microphone processing and basic capture must continue
to work. Keeping the additional filter out of the default path is the primary
quality safeguard for microphones that produce artifacts with both layers.

