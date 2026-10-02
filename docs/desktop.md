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
The NSIS package installs machine-wide under Program Files. Setup and desktop
updates require administrator approval; Voxly itself runs without elevation.
Setup and uninstall use the dark Voxly icon for visibility on the light installer
background; the application retains its silver icon.
Preferences and WebView2 profiles remain in each Windows user’s application
data directory, separate from application binaries and updater staging.

```sh
npm install
npm run desktop:dev
```

For a browser-only Home layout/localization preview:

```sh
npm run dev:shell -w @voxly/desktop
```

Open `http://127.0.0.1:1420`. Native buttons are disabled in this preview. Developer media checks are hidden
from production Home. In a development preview, open `/?diagnostics` and expand
Developer diagnostics; browser probes do not establish Tauri compatibility.

## Home and desktop settings

Home prioritizes **Connect** for a new member and **Launch** for a remembered
default. Add an optional local name and a Voxly address; **Remember installation**
is enabled initially. Turning it off opens the address without adding a saved
entry. Sessions still use the same isolated origin-specific WebView2 profile.
Saved entries offer Launch, Rename, Make default (or Remove default) and Forget.
Remove default disables automatic opening and preserves the saved address and profile. Forget removes the
address, not cookies or sign-in data; disconnect an active installation first.

After browser-approved sign-in successfully completes in the desktop window,
that locally selected Installation becomes the default and opens on future
launches. Failed or cancelled approval and ordinary session restoration do not
change the default. Disable **Always open this installation** in Home or use a
saved Installation's menu to change the default. Home is available from the tray
and the bottom of the Settings sidebar;
opening it preserves the current installation and call. Switching addresses
continues to require confirmation when media is active or its state is unknown.
A branded loading screen stays visible until the installation interface is
ready; the new installation window is initially hidden to avoid a blank window
and overlapping startup windows. Choose another installation cancels pending
loading. A startup failure offers Retry and Choose another installation. A web interface
that does not report readiness within 20 seconds reveals Home for recovery;
the replacement window is retained until the member chooses to retry or switch.

Home contains display preferences and the native updater. Settings → Audio
contains microphone mode and push-to-talk release delay; Settings → Shortcuts
contains all four bindings. These controls require both the updated desktop
build and the updated web deployment, and are hidden in ordinary browsers.
Use **Edit keybind**, press the combination, then **Stop recording** to save it.
Escape, leaving the row, or losing window focus cancels recording. Notification
sounds and desktop notifications are grouped in Settings → Notifications.
New desktop profiles start with Ctrl+Shift+M for mute and Ctrl+Shift+D for deafen.
Existing custom or cleared shortcuts are preserved; push-to-talk and push-to-mute
remain unassigned until configured. Preferences are local to this computer.

## Move an existing per-user install to Program Files

This installation-mode change needs a one-time reinstall. Do not rely on an
old per-user updater to remove its existing Windows registration.

1. Quit Voxly from its tray menu.
2. Back up `%LOCALAPPDATA%\app.voxly.desktop` (preferences and `profiles`).
   Keep this backup private; profiles contain authenticated session data.
3. Uninstall the old Voxly entry through Windows Installed apps. Leave the
   option to delete application data **unchecked**.
4. Run the new setup, approve elevation, and use its Program Files destination.
5. Start Voxly normally under the original Windows account. Confirm saved
   addresses, shortcuts and sign-ins, and verify there is only one Voxly entry
   in Installed apps and that `voxly:` links open the new executable.

Application data is not moved into Program Files. Signed update installers use
an app-cache staging directory and request elevation to replace application
binaries. If UAC is cancelled or the installer cannot start, Home remains
available for reopening an Installation and retrying. Explicit update consent
ends calls before launching the installer. Installed migration, UAC and restart
results remain pending in the Windows acceptance record.

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
fails, use the tray's Home action and Retry loading or another address.

The installation interface provides Invite and Link code paths. On an updated
installation, **Sign in with browser** appears on the desktop Link a device
screen. Start it, open the verification address in your default browser, compare
the number shown in both windows, and approve. The desktop window collects its
session through its own webview; the approving browser remains signed in. The
request expires after 90 seconds; leaving the desktop screen sends cancellation.
The existing Link code path remains available: open Account & devices on a
signed-in browser, generate a code, enter it in the desktop interface, and
approve the matching confirmation number.

On the updated web interface, **Open in desktop** is available on the landing
page and in Settings → Account. It requires the installed Windows shell. The
browser may ask permission to launch Voxly; if no handler is installed, stay in
the browser and use the existing sign-in/Link code paths.

The installer registers the `voxly` scheme. Signed-out links contain only the
canonical Installation origin, for example
`voxly://open?origin=https%3A%2F%2Fchat.example.com`. Signed-in Settings adds a
public, short-lived `launch` UUID to coordinate sign-in with this exact browser
Device. Neither form includes a session token, Link code, Invite, Recovery code,
private collection secret, channel route, or arbitrary navigation path. The
browser-normalized `voxly://open/?origin=…` form is also accepted. HTTP is limited
to loopback development origins; credentials, shell origins, fragments, extra
parameters, non-root paths, and malformed IDs are rejected.

**Open in desktop** restores the currently open Installation without reloading,
changing Accounts, or interrupting media. Remembered and unfamiliar addresses
open directly after validation and health checking; switching keeps the existing
call-aware confirmation. A protocol link alone never saves an unfamiliar address.
Successful browser-approved desktop sign-in remembers it, selects it as default,
and enables automatic opening. Cancelling a transition leaves the current call
and Installation intact. Offline failures return to Home with recovery controls.

When opened from signed-in Settings, a signed-out desktop webview starts its
own authorization automatically and displays a confirmation number. Return to
the original browser tab, compare the number in the compact approval dialog,
and choose **Approve**. The desktop completes sign-in in the background without
another confirmation. The server
uses that browser's existing Account to authorize a separate desktop Device.
No code typing or approval-address copying is required. The desktop keeps its
private collection secret in webview memory and receives its HttpOnly session
cookie through same-origin HTTP; the native shell never handles credentials.
The public launch ID alone cannot approve or collect sign-in. Launches expire
after three minutes, and desktop authorization after 90 seconds. Cancellation,
expiry, reuse, and revoked/deleted/banned approving Accounts cannot mint a new
Device session. An already signed-in desktop keeps its existing Account even
when the browser uses another one. Signed-out landing links still open the
Installation; browser sign-in and Link code remain available there.

Deploy the updated server **and** web interface, then rebuild/reinstall the
updated desktop shell. The database change only adds a short-lived correlation
table. Copying a standalone executable does not establish protocol registration.
Browser application-launch prompts cannot be bypassed, and first sign-in still
requires explicit browser approval. Without the installed app, use the browser
normally or Link code; an older server leaves those sign-in methods available.
No broad plugin permission is granted to remote content. See
[the design](adr/0027-browser-desktop-handoff-keeps-approval.md) and
[primary-source research](designs/2026-10-01-desktop-sign-in-handoff-research.md).
Installed Windows cold/running/tray, first sign-in, and call-continuity tests
remain required; macOS and Linux Installation adapters remain unsupported.

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

### Window appearance

On Windows 11, the Installation title bar, text and border follow Voxly's
light/dark/automatic theme instead of the Windows accent color. The welcome
window matches its own dark surface. Standard minimize/maximize/close buttons
remain native, and Windows high-contrast colors take precedence. Closing still
hides Voxly and keeps active calls alive; Quit follows the existing confirmation.
Windows 10 does not support these explicit DWM caption colors.

### Desktop notifications

In the installation's **Settings → Audio**, enable **Desktop notifications**
to request notification permission through WebView2. This is off by default
and saved separately for each Account in the installation profile. Ordinary
browser settings do not show this desktop control.

Updated desktop builds default to **Windows notifications**, sent through
Windows' toast API under the installed `app.voxly.desktop` identity. In this
section, **Delivery → Compatibility (WebView2)** keeps the previous WebView2
notification UI. The choice is saved separately per Account. Native send/API
failures fall back to WebView2, while Windows-disabled notifications remain
suppressed. Do Not Disturb remains Windows-controlled. Use an installed NSIS
build with its Start-menu shortcut; development builds do not establish the
installed notification identity.

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
so a fresh desktop shell is required for this host integration.

Updated Windows shells also check the actual foreground window before native
delivery, including a dialog owned by the Installation window. This suppresses
alerts even when WebView2 reports that the document is unfocused. A native
failure after returning to Voxly closes the alert instead of requesting a
Compatibility popup. Where the WebView2 runtime exposes `NotificationReceived`
(`ICoreWebView2_24`), the host also suppresses focused Compatibility alerts;
background Compatibility alerts retain WebView2's default UI and click handling.
Older runtimes retain the existing document gate for Compatibility delivery.
The contributor reports native delivery and foreground suppression working on
Windows. The full release matrix remains in the acceptance document. Rebuild
the desktop shell for changes;
no web deployment change is required. In-app audio cue preferences remain
independent of desktop banners.

If permission was previously denied, use **Reset notification permission**
in this section, then enable notifications again. The reset clears only the
current Installation's saved Notification permission; login, microphone and
camera permissions remain intact. If WebView2 still reports blocked, finish
your call, Quit Voxly and reopen it before enabling again. Recovery does not
require finding Voxly in Windows' notification app list. The updated desktop
shell and updated web client are both required.
Unsupported runtimes and denied Windows delivery remain recoverable without
affecting calls or messages.

Clicking an alert in a running desktop application now requests restoration of
the current Installation window and opens its channel through ordinary Voxly
navigation. This does not join or switch voice. Old Account/Installation alerts
cannot activate a replacement session. Channel targets stay out of OS alert
content and native storage. Installed Windows tray/minimize/focus behavior is
still pending acceptance; notification activation after Quit is not implemented. See [ADR-0024](adr/0024-desktop-alert-activation-only-reveals-its-window.md).

Delivery prefers native Windows toasts without a notification plugin; only a
finite category, language and temporary handle ID enter native state. Native
code owns the generic copy and silent XML. Routes and Account identity stay
web-local. WebView2 permission remains the explicit enabling gate and supports
compatibility delivery. Separate finite commands reset Notification permission
and close the current window's own toast handles. See
[ADR-0026](adr/0026-desktop-native-alerts-keep-webview-fallback.md). See Microsoft's
[notification handling contract](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2notificationreceivedeventargs?view=webview2-1.0.3912.50).
Installed Windows acceptance must establish permission, toast delivery,
tray/lock behavior and foreground behavior; local builds do not establish
installed OS integration.

Updated desktop shells also save the most recent native API or asynchronous
delivery failure to
`%LOCALAPPDATA%\app.voxly.desktop\native-notification-diagnostic.json`.
This is one overwritten local snapshot containing only a finite API stage and
numeric HRESULT; no Account, channel, message, origin or toast handle is written.
After reproducing fallback with the rebuilt shell, read it in PowerShell:

```powershell
Get-Content "$env:LOCALAPPDATA\app.voxly.desktop\native-notification-diagnostic.json"
```

The file's modification time identifies when the captured failure occurred;
a successful send does not clear a previous failure. No file means no native
failure has been captured, rather than proof of successful delivery. In that
case also check that the running shell is the rebuilt version and that the
native IPC bridge is reached. A diagnostic write failure never disables the
fallback or affects a call.

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

The local shell implements signed updates, but ordinary feasibility builds have
no updater endpoint or public key and make no update requests. Production
configuration is supplied only at build time by the distributor.
Configured Windows builds check at application startup and hourly while open
or hidden to tray, and quietly download and verify available updates. The
bottom-left connection area and account menu show update actions without visible
version numbers. Home and Settings retain version details. The native tray menu is **Show Voxly**, **Home**, **Check for
updates**, a separator, then **Quit**. It contains no version row. Checking
opens Home's updater and immediately runs the same native check as Home's button;
early requests are queued until startup initializes, and repeated clicks reuse an
ongoing check. Unconfigured builds show updates unavailable; downloading or ready updates
keep their existing state. The tray never installs an update. Update actions open local review;
installing still needs explicit confirmation and may interrupt voice.
The small interface version at the bottom of Settings opens the desktop and web
interface version details. There is no General or Desktop section. On
narrow screens the dock keeps a compact status; full version details stay in
Home and Settings. Mandatory restart deadlines and automatic rejoining are
not implemented yet.
Installation-delivered interface updates use Voxly's existing version checker;
while media is active an update waits behind an explicit reload notice. End
media before reloading. Release candidates and distribution remain gated on updater-key setup and
Windows acceptance.

Before a production shell release, the distributor must establish a fixed HTTPS
manifest endpoint, protect the updater private key in release secrets, embed the
matching public key. Initial GitHub releases use updater signatures without a
Windows certificate; Authenticode remains an optional separate workflow mode.
Tauri updater signatures do not replace Authenticode. Installing a Windows
update exits the app, so confirmation/track cleanup precede installation. Never
take the updater URL or public key from a connected installation. The
[revised plan](designs/2026-09-29-windows-desktop.md#milestone-4-signed-release-and-shell-updates)
lists the required failure tests.

See [desktop releases](desktop-releases.md) for GitHub hosting, signing ownership,
the protected candidate workflow, recovery and future Microsoft Store distribution.

## UX correction verification

Browser Download desktop lives directly above Settings at the bottom of the
workspace rail. The authenticated Open in desktop button prepares its public
correlation before enabling, renews expired preparation, and invokes the URI
directly from the click. Opening and matching-code approval share one dialog;
the browser's application-opening prompt and explicit approval remain required.
Unused preparations are cancelled on close or unmount.

Settings uses a translated 44px X close button with Escape and focus restoration.
Each shortcut row has an Edit/Stop control and reset icon. Valid combinations
replace the draft without ending recording; Stop saves. Escape, section change,
closing Settings, window blur, and starting another recorder discard the draft
and release suppression. Reset uses native defaults and registration; resetting
a required hold binding requires first selecting Open mic in Audio.

Installation menus prefer above their buttons, fall back below, and stay inside
the viewport on scrolling/resizing. Arrow keys, Home/End, Escape and outside
clicks work. The setup EXE uses a dark mark on silver for Explorer; an NSIS GUI
hook preserves the dark wizard mark. Application and uninstall icons are unchanged.
[Tauri installer hooks](https://v2.tauri.app/reference/config/#nsisconfig) and
[NSIS GUI customization](https://nsis.sourceforge.io/Docs/Modern%20UI%202/Readme.html)
are the supported extension points.

For rendered component regressions, run `npm run dev:ux-check -w @voxly/web`.
This disposable fixture uses actual components and CSS, in-memory data and a
finite native-settings mock; only protocol navigation is replaced. Run the
exported `checkDesktopUx(tab, viewport)` from
`apps/web/scripts/desktop-ux/check.mjs` through the CUA browser API. It checks
composer padding/Send, recording continuity and cancellation, reset, X focus,
English/Turkish narrow headings, language edges, download positioning, and
first/repeated approval dialogs. It does not establish native Windows behavior.
Deploy the web interface and rebuild the desktop shell together. Installed
Windows artwork, protocol handling, tray and shortcut checks remain release gates.

For actual Home markup/menu checks with disposable saved addresses, run
`npm run dev:shell -w @voxly/desktop -- --config scripts/home-ux/vite.config.mjs`.
Then run `checkHomeMenus(tab, viewport)` from
`apps/desktop/scripts/home-ux/check.mjs` through CUA at port 1423. This fixture
aliases the native API only in its test configuration; production uses real IPC.
