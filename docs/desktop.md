# Voxly desktop development

The Windows-first Tauri client is a **feasibility build**. It is not a completed
desktop release. Windows 11 is the primary test target. The shell can be built
on macOS for development, but installation windows are currently enabled only
on Windows. Core self-hosting requires no Rust, desktop runtime, or new server
configuration.

Read the [revised plan](designs/2026-09-29-windows-desktop.md),
[platform review](designs/2026-09-29-desktop-platform-review.md), and
[Windows acceptance record](desktop-windows-acceptance.md).

## Run locally

Install Node.js 22+, npm, the pinned Rust toolchain, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows builds
need Microsoft C++ Build Tools with the desktop C++ workload and Windows SDK,
plus WebView2. The NSIS installer uses the Evergreen runtime bootstrapper;
therefore a machine without WebView2 needs internet access for installation.
The default installation is per-user and does not require running Voxly as an
administrator.

```sh
npm install
npm run desktop:dev
```

For a browser-only chooser layout/localization preview:

```sh
npm run dev:shell -w @voxly/desktop
```

Open `http://127.0.0.1:1420`. Native buttons are disabled in this preview. Its
media checks use the browser, so they do not establish Tauri compatibility.

## Connect and sign in

Add an installation origin, for example `https://chat.example.com`. Paths,
credentials, query strings, and fragments are refused. Loopback HTTP development
origins are allowed: `http://127.0.0.1:3000`, `http://localhost:3000`, or
`http://[::1]:3000`. Plain HTTP LAN/public addresses are refused. HTTPS certificate
validation is never disabled.

The shell checks the existing unauthenticated `/api/health` endpoint before
opening an installation, using an eight-second timeout, no redirects, and a
bounded response. This does not prove the interface/media are working; it only
rejects an unreachable or invalid health response. A failed replacement health
check leaves the existing installation window intact. If its interface later
fails, use the tray's Installations action and Retry loading or another address.

The installation interface provides Invite and Link code paths. On an updated
installation, **Sign in with browser** appears on the desktop Link a device
screen. Start it, open the verification address in your default browser, compare
the number shown in both windows, and approve. The desktop window collects its
session through its own webview; the approving browser remains signed in. The
request expires after 90 seconds; leaving the desktop screen sends cancellation.
The existing Link code path remains available: open Account & devices on a
signed-in browser, generate a code, enter it in the desktop interface, and
approve the matching confirmation number.

For local development, start the server on port 3000 and Vite on port 5173.
Set `VOXLY_PUBLIC_URL=http://127.0.0.1:5173` when starting the server **and**
when creating the first owner, so the one-use owner link opens the web UI. The
desktop installation address is also `http://127.0.0.1:5173`.
If an owner was already created with a link to port 3000 and that link has
expired, do not run `owner:create` again. With the same `DATABASE_PATH`, run
`npm run owner:claim -w @voxly/server -- --base-url http://127.0.0.1:5173`
and open its new one-use link.

Close hides a window to the tray. Tray Show Voxly restores the installation;
Installations restores the chooser. Retry, disconnect, switching addresses, and
Quit request fresh media state from the updated installation. They ask for
confirmation when you are in voice (including muted or receive-only calls),
have retained capture, are testing a microphone, or have a pending join or
media request. The English/Turkish prompt describes the active work. Chooser
media checks and pending capture requests also require confirmation. A fresh
idle report skips the prompt; an older client, unavailable report, navigation
or a reply later than 750 ms requires conservative confirmation. Native code
rechecks after replacement health checks, so a join started during the check
cannot rely on an earlier idle report. Cancelling keeps capture; confirming
ends chooser checks before native work. Failed replacement health checks keep
the old installation and call. Quit destroys the webview before exit; hiding
keeps it alive and is subject to Windows acceptance testing.

Rebuild the Windows shell and deploy the updated web client for this flow.
The separate [state bridge](adr/0022-desktop-call-reports-grant-no-actions.md)
grants only finite reporting to the current exact origin and unique window
generation. It carries no identities or native actions and persists no report.
Shortcut and installation management and updater trust remain local.

### Desktop notifications

In the installation's **Settings → Audio**, enable **Desktop notifications**
to request notification permission through WebView2. This is off by default
and saved separately for each Account in the installation profile. Ordinary
browser settings do not show this desktop control.

Background alerts cover new messages, peer arrivals/departures, screen-share
changes in the connected voice room, and connection interruption/recovery.
They follow the existing notification master/category switches and self/owner
deafen. Focused Voxly shows no system alert; the listener's own messages never
notify. Alerts contain generic English/Turkish text, never message content,
names, or room details. They request silent delivery so the existing Voxly
cue player remains the only sound source. Repeated alerts of the same kind
are coalesced. The Windows host grants WebView2 notification permission only
for an explicitly initiated request from the active Installation's exact
origin. WebView2 does not show the ordinary browser permission prompt by itself,
so a fresh desktop shell is required for this host integration. Windows may not
list Voxly under notification settings until it has posted its first toast.
Unsupported runtimes and denied Windows delivery remain recoverable without
affecting calls or messages.

Clicking an alert in a running desktop application now requests restoration of
the current Installation window and opens its channel through ordinary Voxly
navigation. This does not join or switch voice. Old Account/Installation alerts
cannot activate a replacement session. Channel targets stay out of OS alert
content and native storage. Installed Windows tray/minimize/focus behavior is
still pending acceptance; activation after Quit and external desktop links are
not implemented. See [ADR-0024](adr/0024-desktop-alert-activation-only-reveals-its-window.md).

Delivery uses WebView2's standard notification UI and browser permission,
without a native plugin or remote native capability. See Microsoft's
[notification handling contract](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2notificationreceivedeventargs?view=webview2-1.0.3912.50).
Installed Windows acceptance must establish permission, toast delivery,
tray/lock behavior and foreground behavior; local builds do not establish
installed OS integration.

Windows stores chooser preferences under the application local-data directory
for `app.voxly.desktop` (`%LOCALAPPDATA%\app.voxly.desktop` in a standard profile).
Each canonical origin has a separate `profiles/<sha256-of-origin>` browser data
directory. Preferences contain addresses, language, and first-use acknowledgement,
not session tokens. Browser cookies remain in their own profiles. Forget address
only removes the chooser entry; revoke the Device in Account & devices to sign
it out. Do not share or commit browser data directories.

## Verify and package

### Global voice shortcuts

In the local chooser's **Global shortcuts** section, record and save separate
mute and deafen combinations. Both accept keyboard shortcuts or Mouse 3/4/5
with optional modifiers. Changing or clearing one keeps the other registered;
the same combination cannot serve both actions. Preferences survive restart,
and registration conflicts retain the previous working binding.

Shortcuts act only in an existing connected voice room. Deafen silences the
microphone and participant voices; subscribed screen audio keeps its own volume.
Undeafen uses the existing microphone preference and live track, never creates a
microphone capture for a receive-only listener, and preserves owner/room locks.
Microphone monitoring also blocks the deafen shortcut until its isolation ends.
Recording in the chooser performs no voice action.

Mouse side buttons retain Back/Forward navigation in the installation window,
including when bound to a voice shortcut. Moving through Voxly's route history
uses document-local page history: Back/Forward changes the viewed page without
joining, switching, or leaving voice. At either end, further clicks do nothing;
the initial authenticated page replaces the startup landing entry. A bound press also performs its voice
action. The chooser consumes clicks only while recording a shortcut.

For **Push to talk** or **Push to mute**, first record and save that action's
shortcut, then select it under **Microphone mode**. Push to talk transmits only
while held; selecting this mode enables a 200 ms release delay when no delay is configured. Push to mute suppresses
publication while held and restores it on release if the microphone was enabled.
The microphone button still enables/disables your microphone independently:
self mute, deafen, owner mute, and an AFK room take precedence. The monitor
branch is independent, and holding a shortcut never requests microphone access.
Both modes use existing live capture, including after a device replacement.

In the chooser, selecting Push to talk automatically enables release delay at
200 ms when the saved delay is off; an existing nonzero delay is preserved.
You can turn it off again while using Push to talk. Adjust
the **Release delay** slider from 0–2000 ms; its readout shows milliseconds and
the value survives restart. Off or 0 ms cuts transmission on release. An enabled
delay keeps an already transmitting microphone open briefly after release.
Re-pressing cancels the pending cutoff. The timer runs in the native desktop
process; self mute/deafen, owner mute, room locks, leaving/disconnecting, mode
changes, and shortcut rebinding still end the grant immediately. Push to mute
release remains immediate. Both the rebuilt shell and updated web client are
required; an older client without release-tail support cuts on release.

Open mic is the default for existing preferences. The selected mode and both
hold shortcuts survive restart. They require **both a rebuilt Windows app and
the updated installation web client**. An older web client ignores the new
mode and continues its existing microphone behavior; verify idle silence with
a browser peer before relying on Push to talk. If a Push to talk binding cannot
register after restart, its updated web client stays silent until you fix the
binding or select Open mic. See the Windows acceptance cases below.

Rebuild the Windows desktop app **and deploy the updated installation web
client** for deafen. An older shell/web client can keep mute working without
supporting the new optional deafen methods. Installed Windows validation is
still required; see the acceptance record below.

### Build commands

```sh
npm run typecheck
npm test
npm run build
npm run build -w @voxly/desktop
cd apps/desktop/src-tauri
cargo fmt --check
cargo check --locked
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

From the repository root on Windows:

```sh
npm run desktop:build
```

The NSIS test installer is written under
`apps/desktop/src-tauri/target/release/bundle/nsis/`. The
`Windows desktop feasibility` GitHub workflow can produce this unsigned artifact
on demand or on desktop pull requests. It does not publish a release and does
not test Windows 11 hardware or interactive media.

The Rust toolchain is pinned in `src-tauri/rust-toolchain.toml`; npm and Cargo
lockfiles are checked in. Keep the Tauri 2.11 family of crate, runtime, macros,
and build tools together when updating the lockfile: an unconstrained transitive
upgrade to a newer Tauri minor can introduce incompatible internal APIs.
`cargo --locked` is required in checks. Update the lockfile deliberately and
rerun the installer checks after any dependency/toolchain change.

## Distribution and updating

This experiment has no native updater, no update endpoint, and no signing key.
Installation-delivered interface updates use Voxly's existing version checker;
while media is active an update waits behind an explicit reload notice. End
media before reloading. Shell releases will be separately signed and distributed
after feasibility passes.

Before a production shell release, the distributor must establish a fixed HTTPS
manifest endpoint, protect the updater private key in release secrets, embed the
matching public key, and separately configure Windows Authenticode signing.
Tauri updater signatures do not replace Authenticode. Installing a Windows
update exits the app, so confirmation/track cleanup precede installation. Never
take the updater URL or public key from a connected installation. The
[revised plan](designs/2026-09-29-windows-desktop.md#milestone-4-signed-release-and-shell-updates)
lists the required failure tests.
