# Windows 11 desktop feasibility acceptance

**Current result: NOT RUN.** This checkout was developed on macOS. Neither
Windows media behavior nor the installer has been manually exercised. Do not
advertise full-feature desktop support from a build or a local browser probe.

Use the [desktop guide](desktop.md) to build/install the test client, then record
results here or in a private test record. Exclude cookies, Invite/access links,
Link codes, private addresses, screen recordings, and browser-profile contents
from artifacts shared publicly.

## Test setup

Record:

- Commit, shell version, and installer checksum.
- Windows 11 edition/build and actual Evergreen WebView2 runtime version.
- CPU, RAM, microphone, camera, headphones/speakers, display setup.
- Installation version and whether the peer uses Chrome/Edge/Firefox.
- Direct versus TURN connection and representative network conditions.

Use separate test Accounts on the desktop and a browser peer. Also test the
same Account on multiple Devices through the existing Link code flow. In the
installation itself join voice deliberately; sign-in must not start or transfer
a call. Use a dedicated browser process/profile for resource comparisons so
unrelated tabs, extensions, and shared browser processes do not bias the result.

## Release-blocking media matrix

Every row starts **not run**. Mark pass/fail with runtime version and evidence.

| Case | Evidence required | Result |
| --- | --- | --- |
| Microphone, camera | Local live tracks, correct remote presentation, audible/visible browser peer, effective stop state | not run |
| Capture permissions | First consent, denial, persistent denial/reset, Windows privacy denial, recoverable retry | not run |
| Screen capture | Monitor and application window; picker cancellation, source closure, stop/restart, source minimize | not run |
| Computer audio | Monitor/window tested independently; returned live audio track **and audible browser-peer reception** | not run |
| Output selection | System default, explicit output, device disappearance, ordinary media element and Web Audio boost | not run |
| Voxly noise suppression | Actual worklet path, suppression on/off, background processing, no microphone reopening | not run |
| Notification cues | Voice/message/connection cues with existing preference and deafen gates | not run |
| Browser interoperability | Bidirectional voice, camera, screen and computer audio, concurrent peer joins | not run |
| Owner moderation | Locked owner mute/deafen, no transmitted microphone audio when muted, no remote playback when deafened | not run |
| Tray call continuity | Hide for 30+ minutes, verify bidirectional audio, cues, and live signaling without reopening | not run |
| Silent background conditions | Repeat hidden with self-mute, self-deafen, no incoming audio; restore and verify media | not run |
| Background recovery | Lose/recover network while hidden; verify existing retry/backoff and media normalization | not run |
| Minimize and lock | Minimize, Windows lock/unlock, competing fullscreen app, reconnect without duplicate media | not run |
| Sleep/resume | Connection may end during sleep; resume must recover or show a useful retry state | not run |
| Device changes | Unplug/replug headset/camera, default-device change, permission/device contention | not run |
| Explicit media end | Quit, disconnect, retry, switch; no tracks/processes left capturing after teardown | not run |

In the chooser run Media checks to inspect the runtime's API availability and
returned track settings. Copy its report before stopping if track settings are
needed. Capture indicators belong to Windows/the runtime; the report deliberately
contains no device IDs or source labels. Do not treat API availability, a picker
audio checkbox, or a nonempty video stream as proof of computer-audio support.
The chooser's profile/consent surface differs from an installation's, so repeat
all consequential cases inside the real remote interface.

## Shell, storage, navigation, and recovery

| Case | Expected behavior | Result |
| --- | --- | --- |
| First use | Tray explanation, equivalent English/Turkish copy, accessible close and focus return | not run |
| Valid installation | HTTPS origin accepted, health preflight then ordinary Voxly interface | not run |
| Invalid address | Refuse credentials, non-loopback HTTP, Invite/access routes, queries, fragments, native schemes | not run |
| Invalid TLS/redirect | No certificate bypass and no redirect following in health preflight | not run |
| Unreachable target | Local error and retry/change-address options; existing call stays intact if replacement preflight fails | not run |
| Later page load failure | Tray Installations remains available; explicit Retry loading recovers | not run |
| Switch/retry/disconnect | Confirmation required whenever replacing an open window; cancellation retains it | not run |
| Session persistence | Restart, reconnect same origin, session and preferences remain in its profile | not run |
| Origin isolation | Two installations under a common parent domain cannot share cookies, local storage, or permission grants | not run |
| Forget address | Entry removed only after disconnect; session survives until explicit revocation | not run |
| External links | HTTP(S) new-window links open the default browser; native schemes and cross-origin top navigation refused | not run |
| Native authority | Remote top frame and embedded content cannot invoke chooser/updater/opener/filesystem commands | not run |
| Single instance | Second launch restores first instance, no second media runtime | not run |
| Device revocation | Existing Account & devices revocation signs desktop out and ends room access | not run |
| Deployment update | Active voice/capture/media check delays reload; idle pending notice reloads only on explicit action | not run |
| Update network failure | Current interface stays usable; polling retries without forced reload | not run |

Permission tests should include direct `window.__TAURI_INTERNALS__.invoke(...)`
attempts from remote developer tools against every generated custom command and
opener/event APIs. Inspect failure without copying any session data. A hidden
button is not evidence of an IPC authorization boundary.

## Resource measurements

Measure the **entire process tree**, not only `voxly-desktop.exe`. A WebView2
renderer, GPU process, browser process, and the retained local shell all consume
resources. Use Windows Task Manager's Details view to obtain the shell process
ID (and the root process of a dedicated browser baseline), then run:

```powershell
.\apps\desktop\scripts\measure-process-tree.ps1 `
  -RootProcessIds 1234 -DurationSeconds 120 `
  -OutputPath "$env:TEMP\voxly-desktop-idle.json"
```

Replace `1234` with the actual root process ID. For a baseline with multiple
independent roots, pass a comma-separated array. The sampler reads process IDs,
parents, CPU time and memory; it never reads command lines or window titles.
It records machine-normalized CPU, aggregate working set and private bytes.
Working sets may double-count shared pages and short-lived processes can be
missed, so compare like-for-like and keep the stated limitations with results.

Warm both applications for 60 seconds, sample each workload for two minutes,
and repeat at least three times on the same hardware and network. Use identical
room size, devices, display resolution, source content, and noise suppression.
Include foreground and hidden voice; do not run the browser baseline and desktop
workload simultaneously because each changes the other's CPU/memory budget.

| Workload | Desktop private MiB / working-set MiB / CPU % | Browser baseline | Result |
| --- | --- | --- | --- |
| Installation idle with chooser retained | unmeasured | unmeasured | not run |
| Two-peer voice, foreground | unmeasured | unmeasured | not run |
| Two-peer voice, hidden | unmeasured | unmeasured | not run |
| Voice + camera | unmeasured | unmeasured | not run |
| Voice + screen + computer audio | unmeasured | unmeasured | not run |
| Representative maximum group | unmeasured | unmeasured | not run |

Set budgets after measuring; do not invent a resource advantage or treat the
Tauri binary size as a runtime memory measurement.

## Gate decision

Record blockers, recovery behavior, runtime versions, measurements, and the
decision to continue Tauri or propose a capture/framework alternative. Computer
audio and hidden-call continuity must pass before the browser authorization and
production native integrations are committed to this engine. Installer creation
in Windows CI is only a build result; Windows 11 media acceptance is separate.
Signed updater/code-signing tests follow in the release milestone.

## Development verification — macOS, 2026-09-29

These checks validate the implementation and build paths. They do not complete
any Windows acceptance row above. Rust ran with a temporary Rust 1.98.1
toolchain under `/private/tmp`; no system toolchain was installed. Commands
below ran from the repository root.

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts --dry-run` | Passed; workspace/lockfile validation only |
| `npm run typecheck` | Passed across all workspaces |
| `npm run typecheck -w @voxly/desktop` | Passed after the final Vite watch configuration change |
| `npm run build` | Passed server, web, bot; existing web chunk-size warning |
| `npm run build -w @voxly/desktop` | Passed chooser bundle |
| `npm test` | Shared 19/19, server 392/392, web 800/801; stopped at the existing copy assertion below |
| `npm run test -w @voxly/web` | 800/801; update-deferral and modularity tests passed |
| `npm run test -w @voxly/bot` | Passed 277/277, run separately because root tests stopped at web |
| `npm run test -w @voxly/desktop` | Passed 8/8 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | Passed |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked` | Passed |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked` | Passed 7/7, including bounded loopback health checks |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | Passed |
| `npm run bundle -w @voxly/desktop -- --no-bundle --debug -- --locked` | Passed native macOS executable with bundled chooser; no installer |
| `docker compose config --quiet` | Passed |
| `docker compose --profile music config --quiet` | Passed |
| `git diff --check` | Passed |

The optional TURN overlay also passed configuration validation with synthetic
inputs; no services were started:

```sh
TURN_REALM=turn.example.test TURN_EXTERNAL_IP=192.0.2.1 \
  TURN_STATIC_AUTH_SECRET=config-validation-only \
  TURN_CERT_DIR=/private/tmp/voxly-turn-config-placeholder \
  docker compose -f compose.yaml -f compose.turn.yaml config --quiet
```

The existing `apps/web/test/i18n.test.ts:89` assertion expects
`Tarayıcının internet bağlantısı yok.` for the Turkish browser-offline message;
the committed translation already says
`Çevrimdışısınız. Bağlantınızı kontrol edin.`. That key and assertion were not
changed by this work. The failure remains visible rather than changing unrelated
copy to make this milestone appear green.

Browser inspection verified the chooser's English/Turkish rendering and a
390px-wide layout without horizontal overflow. Native IPC, WebView2 capture,
Windows NSIS packaging, the PowerShell sampler, and interactive installer tests
remain unrun here. Windows CI has been added but has not been dispatched.
