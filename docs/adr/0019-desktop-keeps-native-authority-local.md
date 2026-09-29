# ADR-0019 — The desktop installation has no general native authority

- **Status:** accepted for the Windows feasibility milestone
- **Date:** 2026-09-29

## Context

A desktop Device must connect to an installation the member chooses, reuse its
web interface, and preserve Voxly's peer-to-peer media and server-side
authorization. Bundling a second application interface would duplicate every
feature and require coordinating deployment and native releases. Loading an
installation's interface instead makes its operator-supplied JavaScript part of
the desktop application. That code must not inherit general native authority.

Tauri permits remote capabilities, and application-defined commands bypass
capability ACLs unless explicitly registered with `AppManifest::commands`.
Browser origin separation also does not isolate parent-domain cookies shared
between installations. Native update keys/endpoints have a different trust
owner from an installation and cannot come from it.

## Decision

Use a bundled local installation chooser and one separate installation webview
window. Only the local shell receives native command permissions. Explicitly
generate command ACLs and validate the calling window/origin in Rust. Native
installation management, tray, browser opening, and later updating are local
operations. In the feasibility milestone the remote window receives no native
capability or injected bridge.

Use canonical HTTPS origins, with loopback HTTP solely for development. Reject
credential URLs, paths, queries, fragments, and local-shell aliases. Each
Windows origin owns its own persistent WebView2 data directory. Only one remote
window is open at a time; switching or retrying destroys the old webview after
explicit confirmation. Closing the window hides it; explicit Quit destroys it
and exits. The local chooser remains available through the tray for recovery.

Allow same-origin installation navigation. Send HTTP(S) new-window link
requests to the system browser; refuse arbitrary protocols and native downloads.
The local shell never navigates to installation content.

After Windows media acceptance, a separately reviewed versioned bridge may
receive a finite runtime capability tied to the selected exact origin and a
unique remote label. Permissions must not accumulate on a reused label. Bootstrap
scripts check both exact origin and top frame. The bridge carries intent through
existing voice/moderation rules; it cannot supply executable code, native paths,
or updater configuration.

Browser authorization extends Device linking and collects an ordinary session
through the selected installation's own webview cookie store. Neither deep links
nor the native HTTP health check authorize sign-in. The native shell persists
installation addresses and preferences, never application session tokens.

## Alternatives considered

**Bundle another React interface.** This could remove installation-delivered
JavaScript from the native surface, but would duplicate interface releases and
require a separate compatibility policy. The current decision preserves one
interface and contains native authority at a narrow boundary.

**Give every HTTPS origin desktop plugin permissions.** Rejected: the member
selecting an installation does not grant every website native access, and an
installation operator is not the owner of shell updates or the member's files.

**Put the remote interface in an iframe inside a privileged shell.** Rejected:
Voxly's response policy forbids framing, and weakening that deployment-wide
policy is unnecessary when a separate stable webview window suffices.

**Promise Chromium media parity from WebView2.** Rejected: platform background
behavior and computer-audio capture require Windows measurement. Tauri remains
a candidate until the acceptance record supports it.

## Consequences

- Interface updates arrive from the installation; shell updates have separate
  distribution and signing ownership.
- Windows origin profiles cost disk/process resources. Measure the complete
  webview process tree; origin isolation takes precedence over presumed savings.
- Without a bridge, the feasibility client confirms every destructive window
  transition rather than trying to infer whether voice is active.
- Forgetting an address does not revoke a Device or erase its browser profile.
  Sign-out remains an explicit Account & devices operation.
- macOS and Linux need separate storage/media adapters and acceptance evidence.
  The initial remote-window adapter is enabled only on Windows.

See the [platform review](../designs/2026-09-29-desktop-platform-review.md) for
primary sources and the [implementation plan](../designs/2026-09-29-windows-desktop.md)
for the remaining gates.

[ADR-0020](0020-desktop-mute-intent-grants-no-native-authority.md) extends the
initial no-injection milestone with one-way microphone intent. Remote native
authority remains disabled; the future IPC requirements above still apply.
