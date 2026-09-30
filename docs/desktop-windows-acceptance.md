# Windows 11 desktop feasibility acceptance

**Current result: INITIAL SMOKE TESTS REPORTED PASS.** The contributor reports
bidirectional voice, screen sharing with computer audio, audio continuing after
hiding to the tray, and permission-denial errors working. The complete Windows
acceptance matrix and installer acceptance remain open; see the scope below.

Use the [desktop guide](desktop.md) to build/install the test client, then record
results here or in a private test record. Exclude cookies, Invite/access links,
Link codes, private addresses, screen recordings, and browser-profile contents
from artifacts shared publicly.

## Contributor smoke report — 2026-09-29

Windows 11 is the agreed target. The tested OS build, WebView2 version, commit,
hardware, capture source type, browser peer, and hidden-call duration were not
provided, so these reports establish initial feasibility rather than completing
the broader acceptance cases.

| Report | Recorded result | Remaining scope |
| --- | --- | --- |
| Voice audible correctly on both sides | Reported pass | Camera, effective track teardown, moderation, and other peer browsers |
| Screen and computer audio sharing work | Reported pass | Monitor/window variants, games in different display modes, source loss, and output routing |
| Audio continues after hiding to tray | Reported pass | 30-minute duration, silent/muted/deafened conditions, hidden reconnect, and sleep/resume |
| Permission-denial errors work | Reported pass | Retry/reset, persistent denial, and Windows privacy settings |

The contributor also requests easier game capture, describing the current
picker as similar to Edge and Discord's game-sharing process as easier and
smoother. Capture-selection UX, fullscreen compatibility, and video frame rate
must be evaluated separately before choosing a native adapter or another shell.

The contributor subsequently reported that the new global mute shortcut
"works okay" on Windows. The focused key combination, focused application,
tray state, conflict/restart behavior, and moderation states were not supplied,
so this is an initial smoke result rather than completion of the shortcut row.

## Mouse shortcut follow-up — 2026-09-30

The contributor now reports shortcuts are generally successful and requests
continuing the desktop plan. The shallow-press cause remains unresolved; this
is not completion of the full installed shortcut matrix.
The contributor reports intermittent failures
with Mouse 4/5, including Ctrl combinations, while Ctrl+N worked for 25 presses.
The press-latch change in `71d5af61` did not resolve the reported failure.
Commit `5cb04ed8` moves mouse press/release gating to the hook thread, waits
through the settings lock for accepted presses, and suppresses bound clicks
when the installation window is foreground. Its portable gate test verifies
those rules; it does not reproduce the physical Windows failure.

The latest report distinguishes "half" presses followed by release, which fail,
from full long presses followed by release and a one-second wait, which work.
The contributor clarified that these are quick, shallow presses on a Logitech
Superlight 1. The saved binding, focus, tested build, navigation behavior, and
number of microphone transitions per failed press must still be confirmed.
This report does not establish whether a press is missing or extra transitions
occur.

On the rebuilt `5cb04ed8` app, test Mouse 5 alone with Voxly focused. Check every
transition during 20 presses, then verify a 21st press inverts the starting
state; final parity alone can hide two missed presses or extra toggles. Compare
quick clicks one second apart, full holds one second apart, and rapid full
clicks to separate press duration from the interval. Record any Back/Forward
navigation. If failure persists, capture native press/release and web-intent
delivery evidence before applying another timing or latch change.

For an independent input check, open
[`mouse-input-check.html`](../apps/desktop/scripts/mouse-input-check.html) in a
browser on the same Windows PC. Keep that browser focused and compare 10 shallow
presses with 10 full clicks, one second apart; reset between runs and copy each
report. This requires no shell rebuild or web deployment. It records middle/side
button events, modifiers, and relative timing only, with no network traffic.
It distinguishes event counts/timing delivered to that browser, not the complete
native-to-web mute path. Missing browser events alone cannot identify the failing
hardware, driver, hook, or browser stage.

One supplied browser report contains 16 complete Mouse 4 down/up pairs and 10
complete Mouse 5 pairs, no modifiers, no repeated-down or unmatched-up events,
and no button held at the end. Mouse 4 hold durations range from 23.1 to 129.8
ms, with some releases followed by another press after 50.7–126 ms. Mouse 5
holds range from 196.6 to 268 ms. The contributor describes 10 clicks, but which
button(s) that physical count covers and which sequence used shallow presses
still need confirmation. Extra complete click pairs would be different from a
missing release; this browser trace alone does not locate their source or
reproduce the Voxly native-to-web failure.

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

Unreported cases remain **not run**. Mark complete pass/fail only with runtime
version and evidence covering the whole case; a smoke report covers its stated
subset.

| Case | Evidence required | Result |
| --- | --- | --- |
| Microphone, camera | Local live tracks, correct remote presentation, audible/visible browser peer, effective stop state | Voice reported pass; camera/remaining cases not run |
| Capture permissions | First consent, denial, persistent denial/reset, Windows privacy denial, recoverable retry | Denial errors reported pass; remaining cases not run |
| Screen capture | Monitor and application window; picker cancellation, source closure, stop/restart, source minimize | Sharing reported pass; source variants/remaining cases not run |
| Computer audio | Monitor/window tested independently; returned live audio track **and audible browser-peer reception** | Sharing reported pass; source variants/track evidence pending |
| Call-audio exclusion | Sharing member hears the call, viewer hears game/content without their own voice returning through screen audio; test desktop and web sharers and record actual `restrictOwnAudio` setting | Optional request implemented; Windows audible test not run |
| Output selection | System default, explicit output, device disappearance, ordinary media element and Web Audio boost | not run |
| Voxly noise suppression | Actual worklet path, suppression on/off, background processing, no microphone reopening | not run |
| Notification cues | Voice/message/connection cues with existing preference and deafen gates | not run |
| Browser interoperability | Bidirectional voice, camera, screen and computer audio, concurrent peer joins | not run |
| Owner moderation | Locked owner mute/deafen, no transmitted microphone audio when muted, no remote playback when deafened | not run |
| Tray call continuity | Hide for 30+ minutes, verify bidirectional audio, cues, and live signaling without reopening | Audio reported pass; duration/cues/signaling not provided |
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
| Global mute shortcuts | Keyboard and Mouse 3/4/5 combinations persist; one press toggles once with another app/game focused or tray hidden; keyboard conflicts reported and owner mute cannot be bypassed | Keyboard shortcut initial contributor pass; mouse support requires installed Windows test |
| Global deafen shortcut | Separate binding persists; toggles existing self-deafen with game focus or tray hiding; preserves owner locks, microphone-test isolation, receive-only and microphone restoration rules | Implemented; installed Windows test not run |
| Browser sign-in | Signed-in browser approves the matching number; desktop profile gains its own session, browser remains signed in; refusal/expiry/cancellation/revocation stay safe | Implemented; installed Windows test not run |
| Device revocation | Existing Account & devices revocation signs desktop out and ends room access | not run |
| Deployment update | Active voice/capture/media check delays reload; idle pending notice reloads only on explicit action | not run |
| Update network failure | Current interface stays usable; polling retries without forced reload | not run |

For the mouse shortcut check, open the installed desktop chooser, select
**Record shortcut**, press Mouse 3, Mouse 4, or Mouse 5, and save the displayed binding.
Join a call, focus a game, then press and hold the button: mute must change
once, and the game must still receive the click. Release and press again to
unmute. Try ten quick presses and confirm the final microphone state matches
the starting state; an eleventh press must invert it. Repeat with Ctrl + Mouse
4, with Voxly hidden to the tray, after a restart, and after clearing the
shortcut. Mouse side buttons remapped by a driver to keyboard keys must be
tested as those keyboard keys.
With the installation window focused, a bound Mouse 4/5 press must toggle and
retain normal Back/Forward navigation. Build history by visiting several Voxly
text and voice routes. Traverse it in both directions while a browser peer
checks continuous audio; the connected voice room must not change just because
the viewed route changes. Outside Voxly, the click still reaches the focused
application. Recording a shortcut in the chooser still consumes its click.

Permission tests should include direct `window.__TAURI_INTERNALS__.invoke(...)`
attempts from remote developer tools against every generated custom command
except the request-bound `report_call_state` and parameterless
`activate_installation` grants, and against opener/event
APIs. State reports without an outstanding request, with wrong versions or
extra/missing fields, and from prior window generations must also be refused. Inspect failure without copying any session data. A hidden
button is not evidence of an IPC authorization boundary.

`activate_installation` may only show, unminimize and request focus for the
calling active exact-origin generation. It takes no destination or action
payload. Check that old windows, other origins and the local chooser cannot use
that remote grant. The connected Installation can request its own focus without
a genuine toast click; that finite permission is intentional (ADR-0024).

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
were not run in that macOS verification. The contributor smoke report above is
subsequent evidence. The Windows workflow was added; its execution/result has
not been supplied for this acceptance record.

## Next Windows test: mute shortcut and call-audio exclusion

Build the desktop client from `test/tauri-windows-11` with these changes and
**deploy the updated web client to the installation too**. The native shell
loads the installation's deployed interface; rebuilding the shell alone cannot
add its web-side mute receiver or own-audio capture request. Leave voice and
reload the installation window before starting the tests.

On a Windows development machine with the prerequisites described above:

```powershell
npm install
npm run desktop:build
```

1. In the tray menu open **Installations**, then **Global shortcut**. Record
   and save a combination such as Ctrl+Alt+M. Join voice normally, focus
   Notepad, and toggle mute/unmute. Have a peer verify silence and resumed
   speech. Hold the combination: it must toggle once. Repeat hidden to tray,
   then in your usual game; record its name and borderless/fullscreen mode.
2. Change the combination and verify the old one stops working. Restart Voxly
   and verify the new one persists. Clear it and verify it stops working.
   Try a combination already registered by another app: the chooser must
   report the conflict and retain the previous working binding. Recording in
   the chooser must not toggle the call.
3. Repeat while self-deafened, owner-muted, owner-deafened, and in an AFK room.
   The shortcut must leave those locks intact. Outside voice, disconnected,
   or after a receive-only join without microphone capture, it must do nothing
   and must not show a microphone permission prompt.
4. Wear headphones. Have a friend using the updated **web client** share a
   monitor with computer audio while receiving your voice in the same call.
   Verify that the friend still hears you, you hear their game/content, and
   your voice does not return through their screen audio. Repeat with a
   desktop sharer and application-window sharing when audio is offered.
   Record Chrome/Edge/WebView2 versions and source type for each result.
5. In Media checks, capture a screen with audio and copy the diagnostic report
   while capture is running. `api.restrictOwnAudio` reports advertised support;
   the audio track's `settings.restrictOwnAudio`, if returned, reports the
   applied setting. Neither substitutes for the audible call test above.
6. Start a chooser media probe, then confirm disconnect, switch, or retry.
   Its capture indicator and preview must stop; cancelled confirmation must
   retain capture. A failed replacement health check must preserve the
   previous installation's remote call.

Return pass/fail for each case, Windows build, runtime versions, game/display
mode, keyboard layout, chosen shortcut, and the diagnostic report. For failures include the
exact action sequence and whether the local microphone indicator and peer's
heard audio disagree. Avoid posting credentials or raw session tokens.

## Next Windows test: browser sign-in

Run an updated local or staging installation and desktop build. In a browser
already signed in to that **same** installation, keep the browser session open.
In the desktop installation's Link a device screen select **Sign in with
browser**, then **Open in browser**. Compare the confirmation number in both
windows, approve, and verify that the desktop joins the same Account without
ending the browser session. It must not join voice on its own. Confirm both
Devices appear in Account & devices and can be signed out independently.

Repeat with refusal, cancellation, and an expired 90-second request. A Link
code must still work as a fallback. Also test that approval from an unrelated
installation URL is refused, signing out the approving browser before desktop
collection prevents sign-in, and restarting the desktop window loses an
uncollected request. Record behavior and installation/runtime versions without
sharing the request URL or session cookies.

## Next Windows test: global deafen

Rebuild the native app and deploy the updated web client to the installation.
In **Global shortcuts**, save different mute/deafen combinations (for example
Ctrl+Alt+M and Ctrl+Alt+D). Join voice with a browser peer, focus Notepad or a
game, then test hidden to tray:

1. Deafen disables your microphone and participant voices. Undeafen restores
   the microphone only if it was on before deafen and its track is still live.
   A previously muted microphone remains muted. Screen audio keeps its own
   subscription/volume behavior.
2. Hold each shortcut: one action per press. Press both keys independently,
   release one, and confirm that release does not unlock repeats of the other.
   Repeat with mute on Mouse 4 and deafen on Mouse 5; the focused game still
   receives clicks, and focused Voxly navigates Back/Forward while keeping the
   same voice session connected.
3. Change, clear, and restart with both bindings. The unaffected binding keeps
   working. An identical combination is refused for the second action; an OS
   keyboard conflict retains that action's old combination.
4. Outside voice or disconnected, deafen does nothing. In a receive-only call,
   deafen/undeafen changes playback without microphone permission. Owner deafen
   remains locked. Owner mute and the AFK room cannot regain microphone audio
   through undeafen. During microphone monitoring, including startup, the
   shortcut must not cancel its temporary deafen state.

Record shell commit, installation version, Windows/WebView2 versions, chosen
bindings, focus/tray state, and pass/fail. Local helper/host tests do not complete
these Windows cases.

## Next Windows test: Push to talk and Push to mute

Rebuild the Windows app and deploy the updated web client first. With a browser
peer listening, record distinct shortcuts for **Push to talk** and **Push to
mute** in the local chooser, then select **Microphone mode**:

1. Select Push to talk and join with the microphone enabled. Before the first
   press, the peer must hear silence. Hold the shortcut and speak: the peer
   hears you only while held. Release while continuing to speak: sound stops.
   Repeat quick press/release, repeated key-down, Mouse 4/5, game focus, and
   hidden-to-tray cases. Observe the peer's microphone/speaking state too.
2. Select Push to mute. Speech is audible with the microphone enabled; holding
   the shortcut suppresses it, and release restores it. Repeat while manually
   muted: release must keep it muted. Mute/deafen toggle bindings still work
   independently, and recording in the chooser does not send a hold grant.
3. While holding Push to talk, focus the chooser, release, and verify silence.
   Change or clear the held binding and verify it ends. A duplicate binding or
   OS registration conflict must retain the previous combination. Restart and
   verify both bindings/mode persist; an unavailable Push to talk binding must
   leave the updated client silent. Select Open mic to return to normal input.
4. Release during a microphone-device change, slow installation health check,
   or delayed server acknowledgement. Neither the old nor replacement track
   may continue sending. Repeat deafen/undeafen, owner mute/unmute, AFK moves,
   receive-only joins, room changes, disconnect/reconnect, and microphone tests.
   Holds never request permission or bypass locks. A held talk grant cannot
   resume after deafen, owner mute, or a room/reconnect transition without a
   new physical press; held mute remains suppressed until release.

Record Windows/WebView2 versions, shell/installation revisions, mode, bindings,
keyboard layout, focus/tray/game state, and pass/fail. Validate the audible
result with a peer; local helper tests do not establish Windows release timing.

### Push-to-talk release delay

Navigation regression: while connected to voice room B, visit text rooms and
the stages of other voice rooms, then repeatedly traverse Mouse 4/5 and
Alt+Left/Right past both page-history boundaries. The viewed page must change
within that history, while room B, its microphone/capture and peer audio remain
connected. Viewing a previous voice stage must never join it. Repeat with
Mouse 4/5 bound and unbound, quick releases, held shortcuts, and after sign-in.
After Back then a new page selection, Forward must not restore the discarded
pages. No blank/startup document should appear at either boundary.

Select Push to talk with the saved delay off and verify it automatically enables
200 ms. Verify a saved nonzero delay survives switching modes. Turn delay off
while using Push to talk and verify it stays off until another mode is selected
and Push to talk is selected again. Test 100, 500, and 2000 ms. Continue speaking after release:
a browser peer should hear only the selected tail, with the sidebar, dock and
stage showing mute once it expires. Re-press before expiry and verify continuous
transmission until the new release deadline. Repeat with game focus, tray
hidden, and a pending health check. Self mute/deafen, owner mute, AFK locks,
room/device/reconnect transitions, mode changes, binding changes/clear, and
disabling the delay must not reopen a cancelled tail. Verify persistence and
the English/Turkish labels, keyboard slider operation, and ms readout. Push to
mute still restores immediately. Older web clients must retain immediate
release, with no publication enabled by the optional tail state.

## Desktop notification acceptance (pending Windows validation)

Use the installed Windows build with the updated installation web client.
Record Windows/WebView2 versions and both revisions. API availability and local
tests do not establish OS toast integration.

1. In Settings → Audio, verify Desktop notifications defaults off. Enable it
   and deny permission: messages and calls still work and settings explain the
   denial. Change site/system permission, retry, and verify recovery. A runtime
   without silent notification support must show the unavailable state.
2. Allow permission, enable alerts, and focus a different application. Receive
   a peer's message: one generic localized alert appears with no message text,
   nickname, Server or room details. Focused Voxly and the listener's own
   messages produce none. Bursts coalesce rather than stack identical alerts.
3. In the connected voice room, check peer arrivals/departures, screen-share
   start/stop, and connection interruption/recovery. A first room snapshot or
   an observed room must not replay roster alerts.
4. Disable each category and the master notification switch. Check self and
   owner deafen; alerts must follow the same gating as existing cues. Verify
   exactly one sound through the selected Voxly output; the OS toast is silent.
5. Repeat while tray-hidden, locked/unlocked, and with Windows notification
   policy or Focus assist blocking alerts. Check the app's identity and toast
   history on an installed build. Record notification-click behavior; room
   routing and native activation are not implemented in this delivery step.
6. Restart and switch Accounts/installations: opt-in remains local to that
   Account/profile. Disable the option and verify future alerts stop even when
   OS permission remains granted. Repeat the text and permission states in
   English and Turkish.

## Development verification on macOS

The browser sign-in and owner-link changes type-checked across all workspaces.
`npm test` passed all workspaces before the final authorization-row cleanup:
shared 19/19, server 396/396, web 809/809, bot 277/277, and desktop 13/13.
After that cleanup, the affected server suite passed 397/397 and the web suite
passed 809/809. `npm run build` passed server, web, and bot; the web bundle still
reports its existing chunk-size warning. The stale Turkish
`connection.browserOffline` assertion was aligned with the existing copy.

The previous desktop shortcut increment passed Rust tests (11/11), clippy,
formatting, and a macOS host bundle. No native Rust code changed in the browser
sign-in increment. An installed Windows browser-approval test and the remaining
media cases above are still needed.

### Global deafen increment, 2026-09-30

The following development checks passed on macOS:

- `npm run typecheck` across all workspaces.
- `npm test`: shared 19/19, server 397/397, web 811/811, bot 277/277,
  and desktop 18/18. After adding the final independent deafen chooser
  regression, `npm test -w @voxly/desktop` passed 19/19.
- `npm run build` and `npm run build -w @voxly/desktop`. The web build retains
  its existing chunk-size warning.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`:
  15/15, including separate keyboard/mouse holds and legacy preferences.
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`.
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`.
- `npm run bundle -w @voxly/desktop -- --no-bundle --debug -- --locked`:
  macOS host executable built; no installer produced.
- English and Turkish chooser preview at a 390-pixel width, and
  `git diff --check`.

Loopback server/fixture checks needed sandbox local-listen permission; the
authorized reruns passed. These checks did not compile the Windows-only hook
or exercise Windows/WebView2, a game, or physical mouse input. The global
deafen cases above remain pending on a rebuilt Windows app connected to the
updated installation web client.

### Push to talk / Push to mute increment, 2026-09-30

`npm run typecheck` and `npm test` passed across all workspaces: shared 19/19,
server 397/397, web 817/817, bot 277/277, desktop 20/20. The affected web and
desktop suites were rerun after the final hold-gate/bridge refinements.
`npm run build`, `npm run build -w @voxly/web`, and
`npm run build -w @voxly/desktop` passed; the existing web chunk-size warning
remains. The English and Turkish chooser preview shows the three modes and
four independent action groups.

Native checks passed on the macOS host:

- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`:
  16/16, with local-listen permission for the loopback health fixture.
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`.
- `npm run bundle -w @voxly/desktop -- --no-bundle --debug -- --locked`:
  host executable built without an installer.
- `git diff --check`.

Windows-only hook compilation, physical key/button release, WebView2 background
timing, and audible peer tests remain pending in the cases above. Existing
macOS host checks do not establish installed Windows acceptance.

## Call-aware shell transition acceptance (pending Windows validation)

Rebuild/install the Windows shell and deploy the updated installation web
client. Record both revisions and Windows/WebView2 versions. Run Disconnect,
Retry loading, switching to another saved installation, and tray Quit:

1. In a fresh idle installation with no media checks, the transition should
   complete without a confirmation. With an old installation web client, a
   missing state provider, a thrown provider, or a stalled renderer, a
   conservative localized prompt must appear instead. No report older than
   the current request may authorize termination.
2. Repeat in voice with the microphone on, manually muted, idle Push to talk,
   self/owner deafened and receive-only. Each call must prompt even without
   effective microphone publication. Test camera, screen and computer audio,
   and retained disabled capture. Confirm the described state with a peer.
3. Start a delayed voice join, microphone/camera permission request, screen
   picker, microphone-device replacement, or microphone test (including its
   deafen acknowledgement). A pending operation must prompt before termination.
   Cancel the prompt and verify the call, picker and capture remain usable.
4. Start chooser probes or a pending chooser permission request and test Quit
   with no installation open. Cancel retains them; confirmation ends capture
   and rejects any late result. Test probes alongside an installation too.
5. Confirm every transition with active media: the old capture indicator and
   peer audio must end. Retry/switch must not join a call in the new window.
   Switch to an unreachable installation and verify the old call survives.
6. Delay the replacement health response while starting voice in the old idle
   installation. Native code must recheck and require consent. Navigate/reload
   while a report is pending; missing or stale replies must require consent.
7. Check the ACL cases above from remote developer tools, including origin
   lookalikes and old window generations. Only finite replies to outstanding
   native requests may be accepted. Reports must never trigger shell actions.
8. Repeat the dialogs in English/Turkish and at a narrow/short window size,
   including Escape/cancel, keyboard focus and tray Quit. Recheck Mouse4/5
   route-only navigation, PTT/PTM and automatic 200 ms PTT defaults.

macOS compilation and VM/helper tests do not complete these Windows cases.
No updater endpoint, signing key or new update authority is introduced.

### Call-aware transition development checks, 2026-09-30

macOS development verification for ADR-0022:

- `npm run typecheck`: passed across all workspaces.
- `npm test`: passed shared 19/19, server 397/397, web 834/834, bot 277/277,
  desktop 34/34. After the final cancellation/timeout/probe regressions and
  focus refinement, the affected suites were rerun with
  `npm run test -w @voxly/web` (835/835) and
  `npm run test -w @voxly/desktop` (37/37).
- `npm run build` and `npm run build -w @voxly/desktop`: passed; the existing
  web chunk-size warning remains. The final chooser refinement also passed
  `npm run typecheck -w @voxly/desktop` and its build/test commands.
  The final effective-state integration passed
  `npm run typecheck -w @voxly/web` and `npm run build -w @voxly/web`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`:
  25/25, including request expiry/replay and exact-origin/window-generation
  caller checks.
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`:
  passed.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`: passed.
- `npm run bundle -w @voxly/desktop -- --no-bundle --debug -- --locked --offline`:
  macOS host executable; no Windows installer.
- Browser fixture using simulated native state: English and Turkish dialogs,
  Escape/cancel and restored Disconnect focus, default viewport and 390×520
  layout with no horizontal overflow. The fixture opened no media and was
  removed after inspection. It does not exercise real IPC or Windows capture.
- `git diff --check`: passed.

Native commands used the temporary stable toolchain environment documented in
this record. Initial root/native fixture runs could not bind loopback in the
sandbox (`EPERM`); authorized local-listen reruns passed. No new dependencies,
server configuration, updater trust or deployment was added. Pre-existing
working-tree changes remain unstaged. The Windows acceptance cases above are
pending; these checks do not certify WebView2 background delivery or teardown.

### Notification activation acceptance, 2026-09-30

Requires the rebuilt desktop shell and updated Installation web deployment.
All installed Windows cases below remain **not run** on this macOS host.

1. Opt in to desktop alerts, hide Voxly to tray, receive a message and click its
   banner. Repeat from Notification Center and with Voxly minimized. The current
   window must appear and its channel open without a full-document reload.
2. Keep a voice call active while opening a text alert or a peer/screen alert.
   A peer verifies uninterrupted audio and unchanged voice membership. Opening
   a different viewed voice channel must never join/move/leave the active call.
3. Repeat with another app or fullscreen game focused, and after lock/unlock.
   Record foreground behavior; do not hide an OS focus refusal with repeated
   focus requests or always-on-top behavior.
4. Replace an alert, sign out/change Account, navigate/reload, disconnect or
   switch Installation, then attempt old alert activation. It must not navigate
   or reveal a replacement Installation. A denied/failed activation stays inert.
5. Recheck permission denial, default-off preference, English/Turkish generic
   copy, master/category/deafen gates and silent OS delivery. OS content contains
   no member, channel or message content; existing web cues own audio.
6. Exercise the finite ACL exception described above and confirm installation,
   shortcut, browser-opening and updater commands remain inaccessible remotely.
7. Quit fully. Page-created alerts do not promise cold-launch activation.
   Registered external desktop links remain a separate pending integration.

Development verification: `npm test` passed shared 19/19, server 397/397, web
839/839, bot 277/277 and desktop 40/40. `npm run typecheck`, `npm run build`,
`npm run build -w @voxly/desktop`, and final affected web typecheck/build passed.
Native `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`
passed 25/25; `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`
and `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` passed.
`npm run bundle -w @voxly/desktop -- --no-bundle --debug -- --locked --offline`
built the macOS debug executable. Native commands used the temporary stable
toolchain documented above, and loopback fixture runs used authorized local
listening. `git diff --check` passed. The existing web chunk-size warning remains.
No dependency, signing key, updater endpoint or protocol registration was added.

## Windows 11 permission recovery and chrome (pending)

- Install the updated desktop build and deploy the updated web client. Start
  with a profile whose Notification permission was previously denied. In
  Settings → Audio, reset permission and enable notifications again. If the
  current document caches denied state, finish the call, Quit/reopen, then
  enable. Check that login and microphone/camera permissions were preserved.
- Receive a message while minimized or tray-hidden; verify a silent banner,
  notification-center entry and click restoration. Record Windows delivery
  separately from WebView2 permission. Test Windows notification suppression.
- With a contrasting Windows accent color, select Voxly Light/Dark/Auto.
  Check caption/text/border colors, inactive windows, maximize/restore and
  normal window buttons. Change OS light/dark with Auto selected. Toggle
  Windows high contrast and check accessibility colors take precedence.
- Check the welcome window matches its dark surface. Close during a call and
  restore from the tray; confirm media remains connected.

## Native Windows notification delivery (pending installed acceptance)

1. Install the new NSIS build with a Start-menu shortcut and deploy the new web
   client. Enable Desktop notifications in Settings → Audio and leave Delivery
   set to Windows notifications. Trigger a message while Voxly is minimized or
   tray-hidden. Confirm Voxly identity, Windows banner, no extra WebView2 popup,
   silent delivery and notification-center history. After the banner times out,
   click its history entry; confirm current channel navigation without joining
   or switching voice. Record banner and history activation independently.
2. Verify native category/deafen/focus/master gates and English/Turkish generic
   copy. Check repeated alerts replace the old category and remain silent.
3. Select Compatibility (WebView2); check the previous delivery path and click
   behavior. Reopen Settings and verify the per-Account choice persists.
4. Disable Voxly notifications in Windows; verify no fallback bypasses the OS
   setting. With Do Not Disturb, verify Windows controls banner suppression.
5. Sign out/switch Account, navigate/retry/switch Installation, or Quit during
   pending delivery. Verify old alerts are retired, old clicks cannot act on
   the new session, and media stays connected when only hiding the window.
6. Simulate native API/send failure and check one WebView2 fallback. A native
   `Show` return is not proof of delivery, history retention or click dispatch;
   these require the installed test. Full Windows compilation also remains a
   release gate. A Windows-target probe checked the actual WinRT API module
   with minimal Tauri interface stubs; full cross-check on macOS was blocked
   by missing `x86_64-w64-mingw32-gcc` for the existing ring dependency.
