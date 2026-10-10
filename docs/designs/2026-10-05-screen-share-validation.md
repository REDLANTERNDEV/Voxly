# Screen adaptation and interaction validation

The per-viewer controller uses the profiles and thresholds from
[the existing design](2026-07-15-smart-invite-and-adaptive-screen-share.md).
Sender ceilings do not guarantee delivered dimensions. Low resolution alone
never enables the connection warning.

## Measurements on October 5, 2026

A single 60-second headless Brave trial used one moving 1280×720 canvas at
30 FPS, sent concurrently to two independent loopback WebRTC peers. One used
native motion-first adaptation; the other used the production sender controller.
The fixture measured actual video dimensions rather than treating parameter
changes as delivery. Sampling was once per second.

| Path     | First received 720p |
| -------- | ------------------- |
| Native   | 25.247 seconds      |
| Adaptive | 24.246 seconds      |

Both paths initially delivered 180p while Chromium reported bandwidth limitation.
The adaptive path honored the startup and low frame-rate ceilings and ultimately
reached the high profile. This one trial does **not** demonstrate a meaningful
startup improvement or resolve the reported 30-second delay. Browser bandwidth
estimation still controls delivered quality.

The existing authenticated two-browser voice lab passed one join cycle with
8-second recording windows, mute, background playback, suppression, synthetic
screen audio, and native speech comparison. These synthetic fixtures do not
certify the OS capture picker, actual desktop WebViews, or headset behavior.

Deterministic tests cover profile thresholds, healthy recovery, sender isolation,
unsupported statistics/parameters, stale results, cleanup, and warning hysteresis.
Menu browser checks cover all four edges at 1200×800, 680×360, and 360×260,
resizing, long lists, keyboard selection, child-first Escape, outside click,
focus restoration, touch selection, fullscreen portal hosting, and warning hover/focus details. Real-app
notification browser checks cover two authenticated Devices, badge capping,
per-channel clearing, mute/backlog restoration, reload, failed settings writes, and failed history.
Headless Chromium treats separate contexts as focused; the background Device's
blur is explicitly simulated for that check.

## Reproducing the browser checks

Build with `npm run build`. Start the fixture server in a second terminal:

```sh
npm run dev:ux-check -w @voxly/web
```

Then run with an installed Chromium-family executable if Playwright's browser
is unavailable:

```sh
VOXLY_TEST_BROWSER_PATH='/path/to/browser' node apps/web/scripts/desktop-ux/features-check.mjs
VOXLY_TEST_BROWSER_PATH='/path/to/browser' VOXLY_SCREEN_BENCHMARK=1 node apps/web/scripts/desktop-ux/features-check.mjs
VOXLY_TEST_BROWSER_PATH='/path/to/browser' node apps/web/scripts/desktop-ux/notifications-check.mjs
```

The optional benchmark writes sanitized metrics to
`/private/tmp/voxly-screen-benchmark.json`; no tokens, candidates, or SDP are saved.
The notification check creates and disposes an in-memory installation.

## Remaining acceptance work

The local Docker daemon is unavailable. Direct/TURN comparisons under actual
network impairment therefore remain unverified; use the isolated setup in
[the voice lab](../../scripts/voice-lab/README.md) rather than shaping the host.
Repeat the first-minute comparison with a healthy viewer and a constrained
viewer concurrently, and include a viewer joining an existing share. Validate
actual browser and desktop clients, zoom, safe diagonal hover travel,
and voice continuity under those conditions before claiming the delay resolved.
