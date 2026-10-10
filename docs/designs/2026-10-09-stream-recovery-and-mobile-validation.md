# Ongoing stream recovery and mobile changes

The approved changes preserve Watch selection while an ongoing publisher remains
in the active room. Screen readiness has its own deadline: connected transport
alone does not prove that a screen frame arrived. Subscription restoration uses
an acknowledgement before the existing media-recovery signal, and validates the
peer generation and current selection before continuing. The watchdog never
watches a new share automatically or leaves other voice peers to repair a screen.

A decoded first frame or the video playback callback establishes readiness.
Missing initial frames have a ten-second deadline; muted or ended tracks have a
four-second grace period. Static frames are healthy. Repairs have a fifteen-second
cooldown and defer to an ongoing transport restart/rebuild. Ten minutes of a
continuous fault exposes Retry, with Unwatch still available.

Screen startup now favors detail over smooth motion: full capture resolution,
15 FPS, and a 1.4 Mbps ceiling, with `detail` and `maintain-resolution`. Capture
limits, independent viewer profiles, congestion hysteresis, and native fallbacks
remain unchanged. See [screen quality design](2026-07-15-smart-invite-and-adaptive-screen-share.md).

## Local receiver measurements

Ten independent Brave browser trials used a moving synthetic 1280×720 canvas,
real local WebRTC peers, and the production quality controller. Late-viewer
trials began capture three seconds before subscribing. Sampling was once per
second; times below are the first sample with received height 720, so actual
arrival can be earlier. Decoded frame counts were read from receiver statistics.

| Trial | Fresh first 720p | Late-viewer first 720p |
| ----- | ---------------: | ---------------------: |
| 1     |          1165 ms |                1033 ms |
| 2     |          1035 ms |                1045 ms |
| 3     |          1035 ms |                1037 ms |
| 4     |          1035 ms |                1046 ms |
| 5     |          1035 ms |                1040 ms |

All trials met the five-second healthy-fixture target. Final receiver samples
confirmed 89–120 decoded frames. This fixture is a local direct connection;
these results do not establish TURN or impaired-network performance.

## Automated validation

Run the browser fixtures with `npm run dev:ux-check -w @voxly/web` in another
terminal. The checks use Playwright's Chromium by default; set
`VOXLY_TEST_BROWSER_PATH` to an installed Chromium-family browser when needed.

- `node apps/web/scripts/desktop-ux/screen-quality-check.mjs`: five fresh and five
  late-viewer trials; writes receiver samples to `/private/tmp/voxly-screen-trials.json`.
- `node apps/web/scripts/desktop-ux/device-link-check.mjs`: actual link screen
  under StrictMode, scanned and typed code normalization, fragment removal,
  challenge expiry, fresh verification without editing, failed-claim CAPTCHA
  reset/retry, approval and refusal.
- `node apps/web/scripts/desktop-ux/control-shortcut-check.mjs`: Ctrl-only recording
  saves `Control`; a later Ctrl chord replaces that draft and remains recordable.
- `node apps/web/scripts/desktop-ux/mobile-shell-check.mjs`: actual shell at 320,
  390, 560 and 900 pixels in English and Turkish, touch and reduced motion,
  landscape/reduced-height composition, drawer download geometry, account access,
  Server menu and Escape focus restoration, and call controls without account
  duplication. The reduced-height check caught and corrected a mismatch between
  the topbar's actual height and the shell's reserved height.

Unit regressions cover first-frame timeout, static screens, sustained mute/end,
peer replacement and stale playback/statistics, cancellation, retry budget and
reset after recovery. Native tests cover both physical Ctrl keys, repeats,
partial releases, rebinding and exact duplicates; existing hold and owner/deafen
safety tests remain in the suites. Quality tests retain per-viewer congestion
and unsupported-API coverage.

## Acceptance still requiring devices or infrastructure

- Installed Windows/WebView2: background/tray Ctrl observation, ordinary Ctrl
  combinations passing through, release delay, installation switching, shutdown
  and owner/deafen locks. The native suite ran on macOS; it does not execute the
  Windows hook.
- Real iPhone Brave: scan, CAPTCHA completion, approval/refusal and keyboard/safe
  areas. Reduced-height browser fixtures are not an actual iPhone keyboard.
- Real direct and TURN paths with outages, simultaneous healthy/constrained
  viewers, both offerer roles, and confirmation of unrelated voice continuity
  and absence of duplicate playback during repair.

## Quiet recovery and standalone modifiers

An ongoing watched screen keeps its last decoded picture during a peer repair.
Its recovery overlay waits five seconds from the first interruption, including
across repeated peer replacements. Initial Watch still shows Connecting. Quality
adaptation stays independent per viewer; low resolution alone is not a fault.

The retained picture lives only in the browser component's bounded canvas,
updated at most once per second and during live-track teardown. Muted or ended
tracks cannot overwrite it. Unwatch and removal of the ongoing share unmount the
component and release the canvas. This is a narrow recovery presentation policy;
it does not add discovery thumbnails, storage, uploads, or recording.

Windows standalone bindings now include Ctrl, Alt, and Shift. Both physical
keys of a modifier form one hold, independent of other registered modifiers and
longer shortcuts. Normal keyboard events pass through. Super/Windows alone stays
unsupported. A new Windows desktop release is required for the native changes.

### Follow-up validation

- `npm test`: shared 19, server 411, web 951, bot 278, desktop 71, release 3,
  and audio fixtures 6; all passed.
- `npm run test:native -w @voxly/desktop`: 56 passed on macOS. The initial
  sandbox run failed only in two tests that bind loopback sockets; the permitted
  loopback rerun passed. This does not validate the Windows hook in WebView2.
- `npm run typecheck`, `npm run build`, and `git diff --check` passed. Vite
  retains its existing large-chunk advisory.
- Focused screen, recovery, and desktop-settings tests passed. The initial
  focused command ran from the wrong working directory for one source-reading
  test; rerunning from `apps/web` passed.
- `control-shortcut-check.mjs` passed in Brave for standalone Ctrl, Alt, and
  Shift and a longer Ctrl chord.
- `screen-recovery-check.mjs` passed in Brave with Strict Mode, English and
  Turkish overlays, native video-frame callbacks and the fallback without them.
  It checks retained 1280x720 pixels, the five-second grace, repeated replacement,
  decoded replacement and Unwatch cleanup. Regression tests also cover the exact
  timer deadline without another statistics sample and cancellation of that timer.
- `screen-congestion-check.mjs` used direct local WebRTC with synthetic congestion
  reports. The constrained viewer first received 640x360 at 3.152 seconds, then
  finished at 1280x720/30 FPS with 358 decoded frames. The other viewer finished
  at 1280x720/30 FPS with 595 decoded frames. Reports controlled the profile;
  this fixture did not impair network packets or test a TURN route.

Installed Windows/WebView2, real Wi-Fi impairment, TURN paths, and real iPhone
acceptance still require their corresponding environments. No release was
published and no commit was created.
