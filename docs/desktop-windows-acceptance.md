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

## Mouse shortcut result

The contributor reports the earlier Mouse 4/5 input issue resolved. The temporary
independent input harness and its diagnostic instructions have been retired.
Production shortcut regression tests remain. Full installed shortcut acceptance,
including conflicts, restart and moderation, remains in the matrix below.

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

### Native notification result

The contributor reports native Windows delivery, banner/history activation and
foreground suppression working. The one-off PowerShell diagnostic is retired.
This closes the reported troubleshooting issues; the full release matrix above
still covers OS settings, cancellation, session isolation and failure recovery.

The shell checks Windows foreground ownership before delivery and before Show.
Focus suppression returns blocked, while asynchronous failure after returning to
Voxly retires the alert. Supported WebView2 runtimes also suppress focused
Compatibility alerts. These protections and their production regression tests
remain in place.

### Open in desktop links, 2026-10-01

The updated browser landing page and Settings → Account provide an English/
Turkish app-opening link containing only the current canonical Installation
origin. The shell registers `voxly` through the pinned Tauri deep-link plugin
and single-instance integration. Original startup/forwarded URI arguments are
bounded and validated independently of plugin normalization. Matching active
Installations restore their current window; other requests are shown only in
the local chooser and require the existing Remember/Open actions. No web route,
authentication material, automatic connection, native remote permission or
voice action was added.

Installed Windows acceptance remains **not run**:

Browser-launch diagnosis: the reported Windows process argument contains
`voxly://open/?origin=http%3A%2F%2F127.0.0.1%3A5173`, while the direct executable
test used the form without the root slash and displayed **Use this address**.
The original parser rejected that root slash. The correction accepts both
envelopes through the shared cold/running argument handler, retaining all origin
checks and rejecting non-root and normalized dot paths. The regression failed
before the correction. Rebuild/reinstall the corrected NSIS shell and fully quit
Voxly before retrying the browser launch; installed Windows retesting remains
pending. The reported command also ends with a curly quote, so verify the fresh
installer's handler uses ASCII double quotes if launching still fails.

Local correction checks passed: native tests (36/36), desktop workspace tests
(50/50), desktop typecheck/build, native Clippy with warnings denied, Rust
format checking, and `git diff --check`. These do not verify an installed Windows
browser launch.

1. Rebuild/reinstall the NSIS shell and deploy the updated web interface. From
   the signed-out landing page, choose Open in desktop while Voxly is fully
   quit. After approving the browser's launch prompt, the chooser must show
   the exact origin. No health request, saved address or login occurs until
   the normal chooser actions. Repeat from signed-in Settings → Account.
2. Repeat while the chooser is already running, including its startup and
   first-use tray dialog. Only one Voxly instance remains. Cancel the offered
   address and verify saved Installations and local probes are unchanged.
3. Keep the matching Installation in a call, minimize it and hide it to tray.
   Open its link: its window restores with the same viewed room and a peer
   confirms uninterrupted audio. No full-document reload or automatic join.
4. Open a different Installation's link during that call. The chooser offers
   its address while the original call continues. Remembering an address does
   not switch. Open follows health checking and media confirmation; cancelling
   or an unreachable destination preserves the original call.
5. Try wrong schemes/actions, credentials, paths, fragments, duplicate/extra
   parameters and oversized arguments. They must not navigate, save, switch,
   authenticate or join voice. Installation content must still be unable to
   invoke the local link command or open custom protocols through its opener.
6. Repeat first-install, reinstall and uninstall protocol behavior. Without
   Voxly installed, the browser remains usable and Link code remains available.
   Check English/Turkish copy and keyboard operation at narrow widths.

Development verification passed:

- `npm run typecheck`, `npm test`, and `npm run build` across the repository.
- `npm run typecheck -w @voxly/desktop`, `npm run test -w @voxly/desktop`
  (50/50), and `npm run build -w @voxly/desktop`.
- `npm run build:tests -w @voxly/web` and
  `node --test dist-test/test/desktop-links.test.js` from `apps/web` (2/2).
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`
  (35/35). The initial sandbox run failed only on the existing loopback health
  fixture's `EPERM`; rerunning with local-listen permission passed.
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`.
- Browser inspection of the landing action at desktop and 390px width in English
  and Turkish. This did not launch the Windows protocol or exercise an installed
  Windows webview. The existing web bundle chunk-size warning remains.
- `npm run bundle -w @voxly/desktop -- --no-bundle --debug -- --locked --offline`:
  macOS host debug executable built; this is not Windows NSIS packaging.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` and
  `git diff --check`.

Development checks for this correction passed:

- `npm run test -w @voxly/desktop`: 48/48 at the time of this correction.
- `npm run typecheck -w @voxly/desktop`.
- `npm run build -w @voxly/desktop`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline native_notifications`:
  4/4; the focused-sender regression failed before applying suppression.
- `cargo check --manifest-path /private/tmp/voxly-windows-api-check/Cargo.toml --target x86_64-pc-windows-gnu --tests --locked --offline`:
  actual notification/foreground/WebView2 APIs with the corrected minimal Tauri
  interface stubs. This is not a full Windows app build. The probe retains two
  unrelated unused-fixture warnings.
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`.
- `git diff --check`.

Native commands used the previously documented temporary stable toolchain.
No new dependency, remote permission, web code, staging or publishing was added.

### Browser-to-desktop sign-in handoff, 2026-10-01

The member confirmed the browser-normalized link now displays the address offer
in installed Windows. This verifies that specific parser correction only. The
following smoother handoff is a new change and has **not** been accepted on
installed Windows.

Follow-up member report: the smoother handoff works on their Windows setup.
Record the main happy path as member-confirmed. The report does not individually
verify the running/tray, different-Account, active-call, cancellation, expiry,
or revocation cases below; those remain pending.

Signed-in Settings creates a public launch UUID bound to its browser Device.
A signed-out desktop creates its own private authorization and the original
browser tab presents the matching-number approval. Only the desktop receives
its new session cookie. Existing desktop Accounts remain unchanged. A saved
address opens directly when no Installation is active; a new address or switch
has one local Open Voxly action, retaining health and call-aware checks. See
[ADR-0027](adr/0027-browser-desktop-handoff-keeps-approval.md).

Windows acceptance still required:

1. Deploy updated server/web and rebuild/reinstall desktop. From signed-in
   Settings, choose Open in desktop with Voxly fully quit. A new address asks
   Open Voxly once; a remembered address opens directly. The signed-out desktop
   shows a number automatically, without starting/copying a second sign-in link.
   Return to the same browser tab, compare the number and Account, and approve.
   The desktop enters chat and appears as a separate Device in Settings.
2. Repeat with the signed-out desktop already running and hidden to tray.
   Repeat with it already signed in, including as a different Account: existing
   Account, current room and live call must remain unchanged. Browser approval
   should not be needed for the existing desktop session.
3. Open a different Installation during a call. Confirm before switching; cancel
   and verify audio remains live. An unreachable replacement preserves the old
   window. The accepted destination may remain remembered after cancellation.
4. Cancel before desktop arrival and while approval is pending; expire requests;
   refuse via Cancel; revoke the source browser Device or delete/ban its Account
   before collection. No new desktop session is created. Reuse the launch ID,
   wrong-origin requests, duplicate IDs and collection with only a public ID
   must fail. Another signed-in browser Device must not approve the launch.
5. Try a missing desktop handler and an older server. The browser stays usable;
   Link code/manual browser approval remains available. Browser application-launch
   prompts remain controlled by the browser. Check both languages and keyboard
   operation. First-time Device approval is deliberate, never automatic.

Development verification:

- `npm run typecheck`, `npm test` (19 shared, 400 server, 849 web, 277 bot,
  50 desktop tests, all passed), `npm run build`, and desktop Vite build.
  The final session-startup gate was then checked with web workspace
  typecheck/build and all 850 web tests.
- Native tests: 37/37; Clippy with warnings denied and Rust formatting checks.
- Isolated in-memory browser/server preview: launch, desktop request arrival,
  visible matching-number approval, and separate desktop-cookie collection.
  Closing the approved browser panel before collection did not cancel it.
  English and Turkish narrow-layout inspection use a simulated desktop request,
  not an installed WebView2 profile or Windows protocol handler.
- `git diff --check`. Existing web bundle chunk-size warning remains.


## Signed shell update acceptance — pending, 2026-10-01

The bundled updater and protected release-candidate workflow are implemented.
GitHub Releases is the selected host; updater key ownership/backup details still
need configuration. On 2026-10-02 initial distribution was selected without a
paid Windows certificate: `windows_signing: none` retains mandatory Tauri updater
signatures. Authenticode credentials are required only if that mode is selected;
the Store EXE route still requires them. No updater-signed Windows installer
or Store submission has been built, published, installed or tested in this chat.
All installed results below remain **PENDING**. Follow
[release operations](desktop-releases.md) for exact setup and recovery steps.

| Case | Installed Windows result |
| --- | --- |
| Startup/hourly/manual check, including hidden tray sessions, and offline recovery without disrupting a call | Pending |
| Verified update between two signed desktop versions | Pending |
| Cancel download, discard verified update, cancel installation confirmation | Pending |
| Active/muted/receive-only voice, camera, screen/computer audio, retained capture, pending join/capture and microphone test | Pending |
| Invalid signature/key, altered artifact, wrong version/platform and interrupted download | Pending |
| Installation content denied check/download/install authority; scoped public status and local-review commands only | Pending |
| Tray Check for updates, current/available versions in dock/account menu, Settings version footer, and 380px/1280px layouts | Pending |
| Checked NSIS launch failure and successful exit/restart | Pending |
| Interrupted installation and recovery using signed installer | Pending |
| First restart keeps saved addresses, language, shortcuts and isolated signed-in sessions | Pending |
| Machine-wide install with per-user data, WebView2 bootstrapper, and the selected signing mode | Pending |
| Microsoft Store EXE certification or MSIX packaging | Pending; no submission/package created |

Local macOS verification covers cryptographic fixtures, HTTP download failure
fixtures, finite native ACLs, confirmation cancellation, staging cleanup,
TypeScript/builds and native tests. It does not prove Windows updater process
launch, WebView2 capture teardown, relaunch or Store acceptance.

## Home, settings, and Program Files acceptance — pending, 2026-10-02

The Home layout, local startup preferences, bounded settings bridge, and
machine-wide NSIS configuration are implemented. These are code results;
installed Windows acceptance below remains **PENDING**.

| Case | Installed Windows result |
| --- | --- |
| Fresh setup targets Program Files; setup/uninstall, taskbar and shortcuts show the Voxly icon | Pending |
| Existing per-user install is removed without deleting app data, then reinstalled machine-wide with one application/protocol registration | Pending |
| Separate Windows users keep separate preferences and WebView2 profiles | Pending |
| First use prioritizes the connection form; English/Turkish, keyboard, touch, 380px and short windows remain usable | Pending |
| Remembered and unremembered origins retain separate sign-ins; Rename and Forget do not clear session data | Pending |
| Completed browser approval sets the latest default and enables startup; refused/cancelled/expired/stale requests do not | Pending |
| Cold startup opens the default; a pending handoff wins; disabling/changing the default and tray Home work | Pending |
| Home access preserves a call; switching/retry keeps call-aware confirmation; health and interface-load failures provide recovery | Pending |
| Desktop Home button and microphone/Shortcuts controls; Notifications section; fresh mute/deafen defaults, custom/cleared bindings, conflicts and Mouse4/5 recording | Pending |
| Global shortcuts work with another app focused; recording does not mute a live call or navigate history | Pending |
| Signed machine-wide update requests UAC, handles cancellation/launch failure, and restarts Voxly without administrator privileges | Pending |
| Update restart preserves names, startup/display settings and signed-in profiles | Pending |

Desktop and web interface must both be updated to use the new settings and
successful-sign-in/default flow. Local browser layout inspection and macOS
native tests do not establish installed Windows behavior.

## Desktop UX follow-up — code verified, Windows pending, 2026-10-02

Implemented:

- Setup/uninstall use the dark local Voxly icon; application branding stays silver.
- Home shows a branded loading screen while the Installation window stays hidden.
  Only an active-origin/window-generation readiness report reveals it. Cancel
  invalidates pending work; timeout and offline failures keep Home recovery.
- Remembered addresses skip the extra address review. New addresses retain
  review, and browser matching-number approval remains explicit. Successful
  desktop collection completes in the background and selects the local default;
  cancelled/stale attempts cannot trigger navigation after collection.
- Settings has Home and a small clickable interface version in the sidebar
  footer. Notifications groups sound preferences and desktop notifications.
  Microphone mode sits directly beneath Microphone in Voice & audio.
- Shortcuts uses one Edit keybind / Stop recording control per binding, red
  recording feedback, Escape/blur cancellation, and row-contained Audio links.
  Recording animation respects reduced-motion preference.
- Account heading wraps in narrow windows; chat composer padding focuses the
  message field; the language selector covers its full visible control.
- Ordinary browsers offer a green Download desktop link to GitHub Releases.
  Browser approval uses a compact modal above Settings with focus restoration.
- Tray order is Show Voxly, Home, Check for updates, separator, Quit. Versions
  are absent. Checking runs a native check while idle, preserves in-flight/ready
  updates, and never installs or interrupts a call by itself.

Installed Windows follow-up remains required:

| Case | Installed Windows result |
| --- | --- |
| Dark setup/uninstall icon is visible; application/taskbar/shortcut icons remain correct | Pending |
| Cold default startup shows one visible window, no white flash, then the usable Installation | Pending |
| Slow/offline startup, timeout, cancellation, late readiness, Retry and Choose another installation | Pending |
| Settings/tray Home preserves an active call; remembered handoff switching still confirms active or unknown media | Pending |
| Browser matching-number approval, cancellation, expiry, already signed-in desktop and latest successful default | Pending |
| Shortcut recording with keyboard and Mouse4/5, Escape/blur cancellation, registration conflicts and an active call | Pending |
| Tray Quit remains last; Check for updates works for idle/current/available/error and preserves downloading/ready states | Pending |
| English/Turkish, keyboard/touch, light/dark, reduced motion and 100/125/150/200% Windows scaling | Pending |

Local verification and any remaining development-check limits are recorded below.

- Passed `npm test`: 19 shared, 400 server, 861 web, 277 bot, 60 desktop and
  3 desktop release-script tests. Loopback fixtures ran with local-listen access.
- Passed `npm run typecheck`, `npm run build`, and
  `npm run build -w @voxly/desktop`. The existing large web-chunk warning remains.
- Passed `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`
  (49 tests), native `cargo check --locked`, and formatting checks for the Rust
  files changed in this follow-up.
- Full `cargo fmt --check` still reports pre-existing formatting in untouched
  native files. `cargo clippy --locked --all-targets -- -D warnings` reports the
  existing default-field assignment in `installations.rs` and existing
  eight-argument `connect_installation` command. These are not passing checks.
- Inspected actual React components using disposable local fixtures: English
  and Turkish Settings, 380px and 1280px layouts, dark/light shortcut recording,
  saving on Stop, Escape cancellation, microphone mode placement, Notifications,
  browser-only visibility, compact approval above Settings and focus restoration.
  Verified the composer outer-padding click focuses its field and the language
  selector's edge/icon areas target the select. No real authorization, call,
  Windows installation or global-shortcut registration was exercised by fixtures.
- Passed `git diff --check`. Unrelated working-tree changes were preserved.

## UX corrections — 2026-10-02

This follow-up supersedes the earlier new-address review, row-blur recording,
setup EXE artwork, and visible dock/profile version behavior.

Implemented direct opening for validated new and saved addresses without saving
a new address on URI intake. Successful browser-approved desktop completion
still remembers/defaults it. Public preparation precedes the first browser click;
stale/unused preparations are cancelled and browser/code consent is retained.
Home offers Remove default for the current default. Menus prefer above, clamp
to the viewport, and support keyboard, dismissal and scrolling. Browser download
is directly above Settings; dock/profile version numbers are removed.

Tray checking uses Home's native check operation, publishes progress/results,
preserves downloading/ready/installing states, and queues startup requests.
Settings uses a 44px translated X, native per-row reset, recognizable Audio
buttons and continuous recording until Stop. Cancellation releases suppression.
Blank composer areas focus the textarea without consuming Send or selection;
language controls use an associated full-control label.

Rendered interaction suite: actual React components/CSS with disposable API and
settings fixtures, English/Turkish, 320px and normal width, light/dark. Verified
composer blank-row focus/Send, latest recorded draft, row-external clicks, invalid
input, starting another recorder, Escape/section/X cancellation, suppression
cleanup, reset, close focus restoration, heading geometry, selector edge hit
targets, download placement, and first/repeated single approval dialogs.
Native tests cover reset defaults/required hold rejection, default removal with
retained addresses/profiles, settings operation rejection, early tray request
consumption and updater phase preservation. Public preparation tests cover
shared work, expiry renewal, failure retry, cancellation and late responses.

| Installed Windows gate | Result |
| --- | --- |
| Silver setup package in light/dark Explorer; unchanged dark wizard, uninstall and installed app icons | Pending |
| First/repeated browser protocol opening; unfamiliar address stays unsaved until successful approval | Pending |
| Offline/slow startup, retry, cancellation, active-call switching, session isolation | Pending |
| Tray check during startup/hidden Home, Checking/result publication, unavailable/offline, repeated clicks, downloading/ready preservation | Pending |
| Reset registration/conflicts, required hold rejection, continuous keyboard/Mouse4/5 recording and native suppression cleanup | Pending |
| Actual Windows Settings/device headings, composer/language hit targets, keyboard/touch/reduced motion, 100/125/150/200% scaling | Pending |

macOS compilation and rendered browser fixtures cannot complete these gates.
Ship updated web and desktop builds together. Existing unrelated work is retained.

Rendered actual Home markup also passed Remove default with retained entries,
above-button placement, viewport clamping at 380px, ArrowUp/Escape/outside
dismissal, Make default, and focus retention.

Verification commands completed successfully:

- `npm test` (19 shared, 400 server, 864 web, 277 bot, 61 desktop and 3 release tests).
- `npm run typecheck` and `npm run build`.
- Final affected suites: `npm run test -w @voxly/web` and
  `npm run test -w @voxly/desktop`; final repository typecheck/build repeated
  after recovery/copy changes.
- `cargo test --locked` from `apps/desktop/src-tauri` (52 passing tests).
- `npm run tauri -w @voxly/desktop -- build --no-bundle` (desktop frontend
  and native macOS release executable).
- `git diff --check`.

Loopback integration tests required local-listen permission in this sandbox;
rerunning with that permission passed. Vite retains its existing large-chunk
warning. No Windows NSIS compiler/runtime is present, so package/wizard artwork,
protocol prompts, actual tray behavior and global registration remain pending.

## Dock, original microphone permissions and close preference

Quiet desktop chat retains its original bottom alignment. The empty middle dock
is hidden and cannot intercept composer clicks; occupied connection/account
cards and active voice controls keep their interactions. The fixture renders the
real chat panel and voice dock and checks alignment as well as pointer focus.

The custom microphone consent handler, reset command/bridge and Audio reset
action have been removed after reports of repeated prompts. Joins and microphone
tests use the original WebView2 permission flow in each Installation's isolated
profile. Screen capture retains its original chooser and runtime sharing bar.
The host sets the configured AppUserModelID before creating windows; grouping of
Home and Installation windows requires installed Windows validation. The runtime
sharing bar may still have its own icon/taskbar entry.

General's device-wide close preference remains default-off, including older
preference files; older shells show an update-required disabled switch.

| Installed Windows/WebView2 gate | Result |
| --- | --- |
| Original microphone consent flow, repeated joins/actions and saved decisions across relaunch | Pending |
| Windows privacy denial, separate camera permission and Installation profile isolation | Pending |
| Home and Installation windows group with the installed Voxly shortcut, including hide/restore | Pending |
| Existing screen chooser, stop sharing and runtime sharing bar | Pending |
| Missing close preference defaults off; saved preference survives relaunch | Pending |
| Home and Installation X/Alt+F4 hide with preference off and request Quit with it on | Pending |
| Active-call cancellation preserves call; repeated close requests show one confirmation; explicit Home/tray Quit works with either value | Pending |
| Quiet composer bottom alignment, edge/padding focus and Send across voice transitions, replies and multiline drafts at Windows display scaling | Pending |

Rebuild the Windows shell and deploy the web client together before performing
these gates. Local browser fixtures cannot certify Windows permission dialogs,
sharing UI or taskbar behavior.

Local verification after restoring the original behavior:

- `npm test`: 19 shared, 404 server, 882 web, 277 bot, 61 desktop and
  3 release tests passed.
- `npm run typecheck`, `npm run build`,
  `npm run typecheck -w @voxly/web`, `npm run build -w @voxly/web`,
  `npm run typecheck -w @voxly/desktop`, and
  `npm run build -w @voxly/desktop` passed.
- `cargo test --locked`: 53 passed with local-listen access for integration
  tests. Native commands used the installed Command Line Tools via
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools`; the Xcode application
  currently requires license acceptance, which was not performed.
- CUA hit/focus/Send checks passed at 1280×720, 1024×480, 901×700, 900×700
  and 390×700 in English/dark browser and Turkish/light desktop layouts,
  before joining voice, while joined and after leaving. Reply/multiline drafts
  passed at 1024×480 and 390×700. The quiet panel bottom returned from 618px
  to its original 710px in a 720px window; the hidden dock center now hits
  the composer. Account settings and sign-out cancellation stayed reachable.
- Changed native files passed `rustfmt --check` with `skip_children=true`,
  and `git diff --check` passed. Full `cargo fmt --all -- --check` still
  reports existing formatting drift in unchanged `shell/trust.rs`,
  `shell/update_commands.rs`, `shell/voice.rs` and `update_installer.rs`.
- `cargo clippy --locked --all-targets -- -D warnings` still reports existing
  `too_many_arguments` in `connect_installation` and
  `field_reassign_with_default` in a shortcut test. It passes with only those
  two lints allowed on the command line.
- A Windows-target harness compiled the exact taskbar helper against the pinned
  `windows-sys` API using a minimal AppHandle stub. This checks API types,
  without validating installed Windows UI. Full Windows packaging and
  permission/taskbar acceptance remain pending in this macOS workspace.

The web and desktop frontend artifacts were rebuilt locally. No publishing,
staging, commit or push was performed. Vite retains its existing large-chunk
warning.

### Explicit media permission recovery

Pending installed Windows/WebView2 verification after the reset-only actions were
added: deny microphone and camera separately; use each Audio recovery action;
confirm the next matching media action offers the ordinary permission prompt,
while the other permission, login and other Installation profiles remain intact.
Verify allowing persists without repeated prompts, reset failure is visible,
older shells disable recovery, and Windows-level denial remains effective.
Screen sharing and notification recovery keep their existing flows.

Automated recovery checks: `npm test`, `npm run typecheck`,
`npm run build -w @voxly/web`, `npm run build -w @voxly/desktop`,
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`,
and `git diff --check`. The reset bridge tests cover top-level/origin guards,
parameterless microphone/camera commands and native errors; web tests cover
English/Turkish recovery controls and old-shell disabled states. Native Clippy
passes with the two existing repository lint exceptions (`too_many_arguments`
and `field_reassign_with_default`); formatting checks pass on changed Rust files.
The WebView2 reset API compiles in a temporary Windows-target harness.
Installed Windows recovery remains unverified on this macOS host.
