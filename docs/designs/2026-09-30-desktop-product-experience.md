# Desktop production experience — 2026-09-30

User requirements accepted during desktop continuation. These are production
acceptance requirements, not a claim that the feasibility chooser implements
them. In this document an Installation is the deployment/domain, such as
`https://voxly.example.com`; a Server is a group inside that Installation.

## Welcome and startup

- Make welcome a polished, accessible connection surface: Installation address,
  remembered Installations and startup preference. Move developer media probes
  out of the ordinary first-use path before production release.
- After successful web-to-desktop authentication, remember the locally selected
  Installation as preferred and enable opening it on startup through a visible
  selected-by-default choice. Keep the browser approval and Link code flows.
  Do not authenticate from URI parameters or collect tokens in the shell.
- A returning member with startup opening enabled enters the preferred
  Installation directly. First setup, an explicit welcome action, disabling
  startup opening, or removing the preferred Installation returns to welcome.
  Keep a discoverable way to change the preference in welcome and Settings.
- A connection failure names the attempted Installation in ordinary language
  and provides Retry and Choose another installation. Preserve saved choices
  and sessions. Avoid an empty window, technical-only errors or a retry loop.
  Loading and errors must remain usable with keyboard, touch and screen readers.
- Startup never automatically joins voice. Switching an already active
  Installation continues to use the call-aware confirmation policy.

## Settings ownership and placement

| Section | Controls |
| --- | --- |
| Audio | Devices, microphone mode (including Push to talk/Push to mute), release delay and microphone behavior |
| Shortcuts | Independent bindings for mute, deafen, Push to talk and Push to mute; record/change/clear and conflict feedback |
| Notifications | Sound master/categories/volume and desktop alert opt-in/permission status |
| Desktop / Installation | Preferred Installation, open-on-startup choice and return to welcome |

Use one Shortcuts section for keybinds; do not duplicate the same bindings in
another Keybinds chapter. Microphone mode and its assigned binding must explain
their relationship and link to the other section. Preserve current PTT/PTM,
200 ms automatic release-delay default, owner locks and route-only Mouse4/5.
Ordinary web users see only controls their runtime supports. Native authority
remains local even when a control is reached from Voxly Settings (ADR-0023).
All copy, permissions, error recovery and accessible labels have English and
Turkish equivalents.

## Window appearance

Synchronize native borders/titlebar with Voxly's selected light/dark theme,
including changes while the application is open; following the OS preference
alone is insufficient. A Discord-like custom titlebar is an option if it can
retain drag regions, resize, maximize/restore, minimize, keyboard/system menus,
display scaling and accessible controls. Closing continues to hide to tray;
Quit follows call-aware confirmation. Prefer native controls when custom ones
would compromise those behaviors. Validate Windows high contrast and multiple
monitors. Theme reporting may carry only a finite appearance choice from the
current Installation, not arbitrary styles or window commands.

## Update freshness and critical fixes

Treat deployment updates and signed native application updates separately.
The current server sends a revalidated application entry page and the web
client compares its loaded asset version with installation configuration at
startup, on visibility/online recovery and every five minutes. Idle clients
reload; updates detected during media work remain explicit after the call.

Production must load the current deployed web client on a real application
relaunch and make a pending update easy to apply. Hiding/showing a tray window
is not a relaunch. Preserve active calls, screen/camera capture, microphone
tests and pending joins/acquisitions when a new version appears. Critical
voice/signaling fixes need an operator-defined compatibility policy before
release: an incompatible client must update before starting another call, with
clear reason and recovery, rather than silently remaining incompatible.
Do not infer criticality from an asset hash or abruptly reload a live call.
The exact compatibility version/configuration contract is a later design and
must include server/web tests and safe failure/rollback behavior.

Signed native updates check at startup and through local Settings. Installation
requires the media gate because Windows updater installation exits the process.
Do not ship a fake signing key, placeholder endpoint or remote-controlled
update trust. Real distributor ownership/signing remains a release prerequisite.

## Sequence and acceptance

Continue the current notification activation and routing-only deep-link slice.
Then implement these startup/settings/appearance requirements before production
distribution. Record installed Windows results for fresh and returning users,
successful/failed handoff, offline startup and retry, changed/removed preferred
Installation, disabled startup opening, live-call navigation, theme changes,
permission denial and update/relaunch behavior. A build alone does not satisfy
these scenarios; feasibility probes remain developer tooling until relocated.

## Implemented recovery and frame appearance

ADR-0025 implements Windows 11 caption/text/border colors following the Voxly
theme, with native window buttons and high-contrast precedence. The welcome
window uses its own dark palette. A denied Notification permission now has a
finite reset control in Settings → Audio; it does not reload calls or clear
login/media permissions. Both changes need an updated desktop build; the reset
control also needs an updated web deployment. Installed Windows acceptance
remains pending in `docs/desktop-windows-acceptance.md`. The broader settings
organization and welcome/default-Installation redesign remain planned.
