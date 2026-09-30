# Voxly desktop: revised Windows-first implementation plan

## Decision and current state

Keep Tauri 2 as the candidate and Windows 11 as the primary acceptance target.
Keep one installation-delivered React interface, SQLite, existing authorization,
and peer-to-peer media. The first milestone is a feasibility experiment, not a
production release. [Platform review](2026-09-29-desktop-platform-review.md)
records primary-source evidence; [ADR-0019](../adr/0019-desktop-keeps-native-authority-local.md)
records the trust boundary.

Implemented for that experiment:

- An `apps/desktop` npm workspace and Tauri native shell.
- A local English/Turkish installation chooser and media probes.
- Canonical HTTPS installation origins; loopback HTTP for development.
- Windows browser data directories isolated per origin, including scheme/port.
- One remote installation window, local recovery controls, native tray, and
  explicit disconnect/retry/switch/quit confirmation.
- Default-browser opening for external HTTP(S) links requested in a new window.
- Existing browser-session authentication and the existing Link code fallback.
- Deployment update deferral during active voice/capture/media checks.
- A Windows CI test-installer build and a process-tree measurement script.

Initial contributor smoke tests report working bidirectional voice, screen and
computer audio, tray call audio, and permission-denial errors. The complete
Windows acceptance matrix and resource measurements remain pending. The
[game-capture review](2026-09-29-desktop-game-capture-review.md) separates the
reported picker friction from game compatibility and motion quality.
The local global mute/deafen preferences and one-way intent bridge are now implemented;
the installation must deploy the updated web client. Browser approval sign-in
now runs within the installation-delivered interface and collects the session
through the desktop webview, without adding remote-to-native IPC. Native
notifications, routing deep links, and signed shell updating
remain subsequent milestones. No Windows
or other-platform media parity is claimed by a successful compile.

## Corrections to the original plan

| Original assumption | Revised implementation requirement |
| --- | --- |
| WebView2 implies complete Chromium media parity | Verify actual returned tracks and audible playback at a browser peer; computer audio is a blocking gate. |
| Hidden windows preserve every voice feature | Tauri's portable background-throttling option is unavailable on Windows. Measure hidden, silent, muted, deafened, and reconnecting calls. |
| Remote capability configuration alone protects custom commands | Generate custom-command ACLs in `build.rs`, check calling window/origin in Rust, and keep remote content without a capability in the experiment. |
| Browser profiles are portable across platforms | Use Windows data directories behind an adapter. Implement and validate each other platform's storage and media behavior before enabling it. |
| Browser approval plus native HTTP collection signs in the webview | Collection must set the cookie inside the selected installation's own webview store; a Rust HTTP client's cookie jar does not accomplish this. |
| Updates install now and restart later | On Windows, Tauri updater installation exits the application. Confirm and end media before installation, not only before a later restart. |
| Desktop saves resources by definition | Compare the complete shell/WebView2 process tree with an equivalent dedicated browser run; set budgets from measurements. |

## Milestone 1: Windows feasibility

Use the current experiment and [acceptance procedure](../desktop-windows-acceptance.md).
Install the NSIS test build on Windows 11 with Evergreen WebView2. Record the
shell version, OS build, actual WebView2 runtime version, audio hardware, network
conditions, and process-tree resource measurements.

Test the local probes and then the actual installation interface with at least
one browser peer. Cover microphone, camera, monitor/window capture, computer
audio, output devices and boost, notification cues, Voxly noise suppression,
owner mute/deafen, browser interoperability, reconnect, tray, lock/unlock, and
sleep/resume. Test permission denial and source/device loss as recovery paths.

Computer audio and tray call continuity are blockers. A native capture adapter
may be proposed if WebView2 falls short, but it needs a separate bounded design
for consent, sender tracks, cleanup, packaging, and resource overhead. Report
measured failures before choosing a framework replacement. Electron is the
fallback candidate when a maintained Chromium desktop capture path materially
reduces that burden; do not migrate speculatively.

The contributor's initial smoke report supports continuing the experiment but
does not complete all media/source/background variants. The development host
still cannot exercise Windows hardware. CI runs Windows Server and can validate
compilation/installer creation; it cannot certify Windows 11 interactive media
or microphone hardware.

The desktop's defining requirements are now an easier game/window picker,
capture that avoids repeating the call in screen audio, and configurable mute
shortcuts that work with a game or another application focused. Global shortcuts
fit either shell; native source selection and audio scope drive the capture
comparison. Game-only audio and full-system audio excluding Voxly are distinct
choices and need distinct labels and tests. A desktop viewer cannot remove its
own voice reliably from an already mixed stream sent by a browser friend;
own-audio exclusion belongs at that friend's capture endpoint too.

For a game/window chooser owned by Voxly, compare Electron's documented desktop
source enumeration/request handler before investing in native Windows capture
and WebView2 media handoff. This comparison is an option, not a framework
migration. A game picker, fullscreen capture compatibility, and delivered frame
rate have separate acceptance criteria. Keep the working Tauri capture path
while evaluating the concrete UX requirement.

## Milestone 2: shell and browser authorization

For any future remote-to-native feature, add a versioned, finite native bridge. Grant a
runtime capability to the exact chosen origin and a unique remote window label.
Tauri capabilities accumulate: never reuse that label for another origin after
granting remote authority. Require exact origin and top frame in bootstrap
scripts, and validate the caller/current installation on every invocation.

Remote code may request approved notification, voice-action, and media-state
operations only. Installation selection, native permissions, shortcut
registration, browser-opening scope, and updater control stay local. Unsupported
bridge versions disable integration and explain why; normal web use remains.
Never accept arbitrary script, path, command, updater URL, or signing key.

Use an RFC 8628-style Device authorization flow without adding OAuth/OIDC to
Voxly. Extend existing Device linking:

1. The selected installation creates a 90-second request and returns a random
   high-entropy private collection secret plus a public request identifier and
   matching confirmation number. Store request secrets only as hashes.
2. The desktop webview keeps the collection secret in memory, opens the
   installation's verification route in the default browser, and displays the matching number.
   The route contains only the public identifier; it is not an authorization
   credential. Provide a copy-address fallback.
3. A signed-in browser shows the Account nickname, installation, coarse
   requesting Device label, and matching number. Approval or refusal is explicit
   and tied to that existing authenticated Device.
4. The desktop webview polls with bounded backoff and cancellation. Atomic
   collection mints an ordinary session and sets its HttpOnly cookie in that
   webview. Approval alone does not create a bearer token in a URL or pass it
   through a bridge. Expired/replayed/wrong-secret responses remain generic.
5. Preserve the approving browser's session. Device revocation and Account
   deletion revoke the new session through existing paths. Do not join voice
   automatically.

Keep request approval, collection, denial, revocation, and expiry coherent with
session rotation/delivery confirmation in ADR-0015/0016. Test concurrent polls,
response loss, replay, Account deletion between approval and collection, cookie
isolation, unavailable browser sessions, and request cancellation.

Add routing-only `Open in desktop` links and register single-instance deep-link
forwarding. Validate and bound the entire URI before navigation; never join
voice, replace an active installation, or authenticate from it without the
normal explicit interaction. Reject unrelated requests/origins and custom
protocols inside installation content. Keep the existing Link code fallback.

## Milestone 3: native integration

Implemented after the reported voice smoke tests: an opt-in, persistent global
microphone mute toggle configured in the local chooser. The version-1 bridge
is native to web only, grants no remote ACL, and requires the updated web client
on the installation. It refuses inactive/disconnected/receive-only sessions and
owner, room, or deafen locks. See [ADR-0020](../adr/0020-desktop-mute-intent-grants-no-native-authority.md).
Windows registration, game focus, and tray behavior still need physical tests.
Global deafen now uses the same one-way boundary, with independent local
registration and the existing deafen/restoration controls. Receive-only calls
are supported; owner deafen and microphone monitoring block the shortcut.
Installed Windows deafen acceptance remains pending. Notifications and
bidirectional media-state reporting remain future work.

Push to talk and Push to mute now have independent saved shortcuts and a local
Microphone mode selector. Their fixed press/release intents gate existing
microphone publication without capture or native authority. Windows acceptance
must verify idle silence, hold/release, tray/game focus, and device/reconnect
races on a rebuilt shell connected to the updated web client.

The reviewed lifecycle bugs are also repaired: pending joins hold the deployment
reload guard synchronously through capture and acknowledgement, with generation
checks on completion/cancellation. Confirmed connect/switch/retry/disconnect
release local chooser probes and tones before awaiting native work; cancelling
confirmation keeps them. This does not alter native health-check preservation
of the old remote call when a replacement is unreachable.

Register configurable global mute/deafen shortcuts locally. Provide local
Settings to record, change, clear, and persist a key combination, with explicit
registration-conflict feedback. Handle one press per activation and dispatch
the existing voice action only to the current installation's validated bridge.
An inactive/disconnected voice session does not join or open a microphone from
a shortcut. Shortcuts obey owner locks and effective media state; the remote
installation cannot register or replace OS key combinations. Verify the action
with another application focused, while hidden to tray, and with representative
borderless/fullscreen games; document any registration or OS/game limitation.
Track effective media plus in-progress joins for switch/update confirmations;
a missing or stale handshake requires conservative confirmation. Tray Quit
ends tracks before exit. Keep native menus and first-use behavior bilingual.

Add native notifications with existing preference and mute/deafen rules. Test
an **installed** Windows build; development identity is not sufficient. Avoid
duplicating native and in-page sounds or leaking message content on the lock
screen by default. Ask for permission through the normal OS surface.

Retain deployment update polling, coalesce latest versions, and leave a pending
update explicit once a call ends. Test calls, screen/camera capture, active
microphone checks, reconnects, joins, and update failures.

## Milestone 4: signed release and shell updates

Use per-user NSIS installers and Evergreen WebView2. Pin the Rust toolchain and
commit npm/Cargo lockfiles. Record build provenance and artifact checksums;
locked dependency versions aid repeatability but do not promise byte-identical
signed installers.

The distributor supplies a fixed HTTPS manifest endpoint and public updater
key at build time. The connected installation can change neither. Keep the
updater plugin and all its commands inaccessible to remote content. Check at
startup and through local Settings; failures leave the current client usable.
Confirm and end media before calling install, because Windows install exits the
application. Test invalid signatures, wrong platform/version, endpoint loss,
download cancellation, interrupted installs, and first restart.

Keep updater signing and Windows Authenticode signing separate. Private keys
belong in release secrets and never in the repository; do not ship placeholder
keys or a manifest endpoint that is not operated. The current CI artifact is
unsigned, has no updater, and is for feasibility testing only. Prepare signed
release CI once distribution ownership and the media gate are resolved.

Do not change the application container's Node-only requirements. Root
`npm run build` still builds server, web, and bot; `npm run desktop:build` is the
separate native packaging command. The container install stage copies the
desktop workspace manifest to keep its workspace set aligned with the lockfile.

## Completion criteria

Run affected workspace tests, root type checking/tests/build for cross-package
changes, Rust formatting/checks/tests/clippy, Windows installer smoke tests, and
`git diff --check`. Preserve unrelated working-tree changes. Full Windows 11
feature parity is the first **production release** gate, not something the
feasibility scaffold claims. Validate macOS/Linux storage, capture, and background
behavior separately before advertising support.
