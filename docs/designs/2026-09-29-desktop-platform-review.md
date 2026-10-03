# Windows-first desktop platform review

Reviewed 2026-09-29 against the proposed Tauri 2 desktop plan. This document
separates documented platform support from behavior that must be measured on
Windows. It records recommendations, not a claim that release acceptance has
passed.

## Recommendation

Keep Tauri for the first feasibility milestone. Reusing the installation's
existing interface and peer-to-peer media is consistent with Voxly's boundaries.
There is no evidence here that warrants an immediate framework replacement.
However, Windows computer-audio capture and hidden-window call continuity must
be blocking release gates. They cannot be inferred from Chromium ancestry or
from a successful browser test.

The plan's authentication and separate shell-update trust are sound. Make the
remote-content boundary concrete before exposing native integrations. Loading
an arbitrary self-hosted installation means its HTML and scripts must be treated
as untrusted native clients, including after redirects or an installation
compromise. Microsoft explicitly recommends origin checks, narrow messages,
parameter validation, and standard-user execution for WebView2 hosts.
[WebView2 security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).

## Corrections required before implementation

### Background voice is a Windows feasibility gate

Tauri's `background_throttling` configuration is documented as unsupported on
Windows, Linux, and Android. Therefore setting it to disabled is not evidence
that timers, reconnect logic, or AudioWorklets remain healthy when hidden.
[Tauri WebviewBuilder reference](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html#method.background_throttling).

Microsoft has an experimental timer-wake API, but it is a preference constrained
by runtime and platform limitations, and does not disable other background
policies. It is unsuitable as the first production guarantee.
[WebView2 experimental timer settings](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2experimentalsettings9?view=webview2-1.0.4015-prerelease).

**Acceptance:** start a real browser-peer call, hide to tray for at least 30
minutes, then verify bidirectional audio, notification cues, mute/deafen,
moderation, reconnect, and noise suppression. Repeat with microphone muted,
deafened, and no incoming audio; active media exemptions must not hide a failure
in silent conditions. Test minimize, lock/unlock, device unplug, network loss,
and sleep/resume separately. Sleep need not preserve a live connection, but
resume must recover through existing Voxly rules. A local loopback audio test
alone does not exercise Socket.IO or peer recovery.

### Screen video support does not establish computer-audio support

Current WebView2 exposes a `ScreenCaptureStarting` event for `getDisplayMedia()`;
the host can cancel capture and inspect the requesting frame. This establishes
an integration surface, not support for every audio source or every runtime
version. [WebView2 ScreenCaptureStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.screencapturestarting?view=webview2-dotnet-1.0.3856.49).

The W3C screen-capture draft allows a video-only result even when audio is
requested. Audio and video sources may differ. Source selection remains a user
choice; persisted permission and `audio: true` do not guarantee computer audio.
Capture requires document focus and transient activation, so a native shortcut
cannot safely be assumed to start it without a foreground web action.
[Screen Capture specification](https://www.w3.org/TR/screen-capture/#dom-mediadevices-getdisplaymedia).

**Acceptance:** independently test monitor and application-window sharing, with
and without computer audio. Record selected surface, returned live audio-track
count, and audible reception at a browser peer. Test local playback echo,
headphones, output switching, source close/minimize, and stop/restart. A present
`getDisplayMedia` function, a checked audio option, or a nonempty video stream
is insufficient. If a native Windows capture path becomes necessary, treat it
as a separate design with explicit consent, track insertion, cleanup, and
measured overhead; do not quietly introduce server media processing.

### Capture permissions and audio outputs remain browser contracts

WebView2 distinguishes microphone and camera permissions; its permission event
includes the requesting URI, whether the request was user initiated, and a
default/allow/deny state. Do not replace the ordinary consent prompt with
unconditional grants for installation content.
[WebView2 permission event](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2permissionrequestedeventargs?view=webview2-1.0.4129.50).

Windows privacy controls can independently deny desktop-app camera and
microphone access. Validate first permission, persistent denial, denial reset,
OS denial, device contention, and unplug/replug with useful recovery copy.
[Windows camera and microphone privacy](https://support.microsoft.com/en-us/windows/privacy/windows-camera-microphone-and-privacy).

Output selection requires feature detection and real playback through both
Voxly's media elements and boosted Web Audio path. The audio-output draft
defines permission errors and missing-device errors; an unplugged selected sink
does not automatically fall back. Test receiver voice, shared audio, notification
cues, restored preferences, and default-device fallback together.
[Audio Output Devices API](https://www.w3.org/TR/audio-output/).

### Native bridge permissions require explicit application-command ACLs

Tauri capabilities grant authority to windows/webviews, and overlapping
capabilities merge. Remote API access is opt-in through remote URL patterns.
Application commands registered with `invoke_handler` are broadly available by
default unless the build's `AppManifest::commands` declares the commands for
permission generation. Merely keeping an updater permission out of a remote
JSON file is not enough if an unrestricted custom wrapper invokes it.
[Tauri capabilities and application command configuration](https://v2.tauri.app/security/capabilities/).

**Recommendation:** enumerate every custom command in the build manifest.
Give the local chooser its own exact label and capabilities. Create an
installation window with a unique label, an exact selected-origin capability,
and only versioned bridge commands. Do not use `https://*`, shared wildcard
window labels, or general plugin `default` bundles for installation content.
Validate bridge method, payload size, active installation, and lifecycle state
in Rust. A handshake enables compatibility; it does not authenticate an
installation or authorize native access.

Runtime capabilities can be added with `Manager::add_capability`. Because
authority is additive, a new origin should receive a new window label and the
old window must be destroyed before switching. This is an architectural
recommendation inferred from the additive API and merged capability model;
verify it with negative origin and stale-window tests.
[Tauri runtime capability API](https://docs.rs/tauri/latest/tauri/struct.App.html#method.add_capability).

### Navigation and frame handling belong in the shell

Use stable `WebviewWindowBuilder` for separate local and installation windows.
Its navigation hook can cancel navigation, its new-window hook can reject
popups, and Windows window creation must run through an async command or
separate thread to avoid a documented deadlock.
[Tauri WebviewWindowBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html).

Tauri's initialization script is injected into subframes on Windows. Guard the
bridge bootstrap with both exact origin and `window.top === window`, and never
inject credentials into a page script. The child-webview builder is marked
unstable, so do not add that dependency merely to place the chooser and remote
interface in the same native window.
[Tauri initialization script and builder notes](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html#method.initialization_script).

Allow installation navigation only within the selected origin. Require the
local chooser for origin changes, including redirects. Handle external
HTTP(S) links through a bounded native opener; reject arbitrary native schemes,
file URLs, and automatic popup launches. An unavailable installation should
leave a reachable local retry/change-address surface. These are application
policy decisions following the WebView2 security guidance, not automatic Tauri
defaults.

## Session and preference isolation

WebView2 user-data folders contain browser state, and different folders can
isolate controls. Shared folders with named profiles can also separate cookies,
permissions, and caches. Deleting a folder requires associated browser processes
to have exited; installation removal cannot immediately assume the directory
is unlocked. [Manage WebView2 user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder).

Named profiles under one environment are Microsoft's lower-resource isolation
option: separate user-data folders require separate runtime instances. Start
with Tauri's supported per-installation data directory and keep only one remote
window alive; use a profile adapter later only if measurement justifies it.
Do not confuse ordinary origin-separated localStorage with complete
installation isolation: cookies and browser permissions also need an explicit
boundary. [WebView2 multiple profiles](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support).

Use a shell-generated stable installation identifier for directory names;
validate and normalize the installation address independently. Reject embedded
credentials and non-HTTPS production addresses. Treat a changed origin as a
new installation identity. Preserve HTTP only for explicit loopback development.
macOS data-store support differs, so Windows implementation does not establish
cross-platform session isolation.

## Browser sign-in and deep links

The proposed short-lived request with a private collection secret follows the
useful separation in RFC 8628: high-entropy device credential, visible user code,
browser confirmation, expiry, and bounded polling. Show the code in desktop and
browser even when opening the browser automatically. Include clear wording
that the member must be initiating this request; code comparison reduces remote
phishing but cannot eliminate a live social-engineering attempt. Keep polling
intervals and `slow_down` behavior explicit. Voxly can reuse these properties
without becoming an OAuth/OIDC provider.
[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628).

Preserve [ADR-0014](../adr/0014-members-link-their-own-devices.md) and
[ADR-0016](../adr/0016-session-reuse-requires-confirmed-delivery.md): issue a
separate Device, preserve existing Devices, and confirm delivery before normal
authenticated use. As an implementation requirement, session collection must
set the cookie in the selected installation's WebView2 profile. A cookie
received by a Rust HTTP client does not automatically belong to that browser
store; prefer a same-origin webview HTTP collection flow or explicitly managed
native cookie insertion, with neither credential exposed in a URL.

Custom URI schemes are not exclusive ownership proofs; another installed app
can claim the same scheme. Keep app-opening links free of bearer credentials,
and bind routing to the selected installation and pending request. External
browser authorization is the established native-app pattern, although Voxly's
flow is Device linking rather than OAuth authorization-code login.
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252).

On Windows and Linux, Tauri deep links launch a new process unless the
single-instance plugin forwards them. Enable its deep-link integration and
validate startup arguments as untrusted input. Include cold-start and
already-running tests, plus the manual Link code and browser-address fallback.
[Tauri deep linking](https://v2.tauri.app/plugin/deep-linking/).

## Runtime, updates, and distribution

Use Evergreen WebView2 for the ordinary Windows distribution. Microsoft
recommends it for security and feature updates; feature-detect APIs because
administrators may delay runtime upgrades. Fixed Version provides deterministic
runtime rollout but adds over 250 MB and makes Voxly responsible for distributing
browser security fixes. A shell update and WebView2 runtime update are separate
lifecycles. Record runtime version in feasibility evidence and keep a minimum
supported runtime policy.
[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

Tauri updater signatures are mandatory and separate from Windows executable
signing. A static manifest is supported. Pin its HTTPS endpoint and public key
in the shell; do not derive either from installation content. Protect the
private signing key and plan backup before release. The Windows install action
exits the running app after launching the installer, so prevent installation
before ending media and obtaining the member's restart decision.
[Tauri updater](https://v2.tauri.app/plugin/updater/),
[Updater install behavior](https://v2.tauri.app/reference/javascript/updater/).

Windows code signing improves publisher identity but does not guarantee the
absence of SmartScreen warnings; reputation still matters. Documentation
should distinguish signed update verification, Authenticode signing, and
distribution reputation.
[Tauri Windows code signing](https://v2.tauri.app/distribute/sign/windows/).

Native notification validation must include an installed build: Tauri documents
that Windows development notifications use PowerShell's name and icon.
[Tauri notifications](https://v2.tauri.app/plugin/notification/).

## Evidence required to close the feasibility milestone

Record Windows build, CPU/RAM/GPU, audio devices, Tauri version, WebView2
version, Voxly web version, duration, selected media settings, peer browser,
and pass/fail for each scenario. Report memory for the native process and its
WebView2 child processes together, not just the small Rust host. Compare an
ordinary browser baseline using the same room, peers, devices, and media
settings. WebView2 performance is similar to Edge for the same content and
process count grows with additional controls; small installer size is not
evidence of low active-call memory.
[WebView2 performance practices](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance).

Release remains unverified until actual Windows media and installed-build
results exist. TypeScript tests, Rust checks on macOS, and CI packaging establish
useful implementation evidence but cannot substitute for those measurements.
