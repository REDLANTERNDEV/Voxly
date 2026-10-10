# Windows desktop game capture: picker, capture, and motion

## Question and current evidence

The member reports successful two-way voice, screen sharing with audible
computer audio, voice continuing after closing to the tray, and permission-denial
errors in the Windows desktop experiment. They want game sharing
to feel easier and smoother than the current Edge-like flow. These are member
reports, not a completed hardware or installed-build matrix. The exact game,
fullscreen mode, WebView2 version, source-selection friction, and receiver
frame rate remain unknown.

There are three different requirements to establish:

- **Selection:** find the running game in a Voxly-owned chooser and start sharing
  with an explicit audio choice.
- **Compatibility:** capture the game when it is foreground, borderless,
  exclusive fullscreen, minimized, or on another GPU/display.
- **Motion:** deliver consistent frames to viewers at the agreed quality.

Changing the chooser solves the first requirement. It does not establish the
other two. Native capture and framework alternatives below are proposals. A
bounded motion-preference correction was applied during this review, as recorded
below.

## What WebView2 can do through its documented host API

`ICoreWebView2ScreenCaptureStartingEventArgs` exposes `Cancel`, `Handled`, the
requesting frame, and a deferral. Cancellation suppresses the capture UI and
rejects the script request. A deferral delays the decision. `Handled` prevents
another WebView2 event handler from being invoked; it is not an instruction to
use a host-selected window. The documented event contains no selected-source,
window-handle, stream, or replacement-picker property. **Inference:** this event
is useful for policy and frame validation, but does not provide the Electron
source-selection mechanism described below. Do not interpret `Handled` as
custom capture support. [Microsoft ScreenCaptureStarting event arguments](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs?view=webview2-1.0.4129.50).

The web `getDisplayMedia` specification requires a fresh user choice and does
not let media constraints narrow the list to one chosen game. `displaySurface`
may influence presentation, but is not a target-window identifier. Audio is
optional even when requested. **Inference:** Voxly can improve its surrounding
instructions, capture status, and recovery, but ordinary web code cannot replace
the chooser with a preselected arbitrary game. [W3C Screen Capture, section 5.1](https://www.w3.org/TR/screen-capture/#dom-mediadevices-getdisplaymedia).

The current Tauri remote installation window uses WebView2 without a native
media bridge. A Tauri-to-Windows binding alone would not turn a native capture
item into the `MediaStreamTrack` consumed by the existing browser peers. The
current trusted local shell boundary must be preserved; any added capture
authority needs an explicit interface and local consent design.

## What Electron adds, and what it does not

Electron's main-process `desktopCapturer.getSources` enumerates screen/window
sources and can retrieve window icons and thumbnails. Its documentation allows
zero-size thumbnails to avoid their processing cost. This gives an application
the source inventory needed for its own picker. It enumerates windows, not a
ready-made list of detected games. [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer/).

`session.setDisplayMediaRequestHandler` receives the requesting frame, origin,
and gesture information, then grants a selected desktop source when renderer
code calls `getDisplayMedia`. This supports a consent dialog owned by Voxly
while returning an ordinary browser media stream. The documented Windows
`audio: 'loopback'` option captures **system audio**; it does not promise audio
isolated to an arbitrary selected game process. `WebFrameMain` audio captures
an Electron webContents, not an external game's process. [Electron session display-media handler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).

Discord describes its own capture and encoding code integrated with operating
systems and video drivers. Its Go Live explanation describes multiple capture
methods, fallback, and OS-specific process-tree audio. These 2024 descriptions
explain why adopting Electron alone cannot promise Discord's game capture or
motion quality. Their published pipeline also uses backend media routing,
which Voxly's peer-to-peer architecture does not adopt. [Discord capture and encoding](https://discord.com/blog/from-blocky-to-brilliant-improving-video-quality-on-discord-go-live-on-amd-gpus),
[Discord Go Live pipeline](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology).

Discord's Windows capture guidance describes Windows Graphics Capture plus
other techniques, including a signed injected DLL. It identifies exclusive
fullscreen as a limitation of its Windows Graphics Capture path and recommends
borderless mode. This guidance dates to 2022 and should not be treated as a
complete description of every current capture decision. It nevertheless shows
that even a mature desktop product needs mode-specific fallback. [Discord Windows application capture guidance](https://support.discord.com/hc/en-us/articles/9410427556375--Windows-Capturing-Application-Window-for-Screen-Share-and-Go-Live).

## A native Windows adapter is possible, with a larger scope

Windows Graphics Capture supplies display/window frames through a capture
session and Direct3D frame pool; its guide includes resize and device-loss
handling. This is a native frame API, not an automatic WebView2 web media
source. [Microsoft screen capture guide](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture).

`IGraphicsCaptureItemInterop::CreateForWindow` creates a capture item from an
HWND on Windows 10 version 1903 and later. A desktop application can therefore
associate its own source chooser with a native window capture item.
[Microsoft CreateForWindow](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow).

Microsoft's application-loopback sample captures or excludes a process and
its children, independently of an audio endpoint. It requires build 20348 or
later, so it is a candidate for Windows 11 game-only audio. The selected PID
and its process tree must actually own the game's audio; no rendering streams
produce silence. [Microsoft application-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

**Engineering assessment:** keeping Tauri while adding this adapter means
designing source enumeration/consent, GPU frame ownership, native audio,
conversion or transport into the existing browser media pipeline, bounded
queues, A/V timing, teardown, source exit, resize, device loss, packaging, and
runtime fallback. Avoid transferring raw 30/60-FPS frames through JSON IPC.
It is a separate media subsystem, not a small picker adjustment. Injection
into games and anti-cheat-sensitive hooks are outside the proposed first step.

## Recommendation and decision gate

Keep the currently working Tauri experiment while identifying which of the
three requirements is the actual problem. Ask for one game name, fullscreen
mode, the inconvenient picker steps, and whether the receiver sees stutter or
black frames. Do not replace a working capture path based only on visual
similarity to Edge.

If an in-app game/window chooser is a firm product requirement, run a bounded
**Electron capture comparison** before committing more Tauri integration.
Reuse the same React interface, authorization, signaling, and browser peers;
prototype source enumeration, explicit source/audio consent, and cleanup only.
The documented Electron route avoids implementing the native-to-web media
handoff ourselves. Keep system audio clearly labeled and assess game-only audio
as a separate requirement. A framework change still needs an ADR, the existing
local trust boundary, origin/frame/gesture checks, and installer/resource
measurement. This is an option to evaluate, not an approved migration.

If the problem is frame rate instead, first measure the existing sender and
receiver. The library guide prescribes capture at **720p/30 FPS**, with each
viewer starting around **480p/20 FPS** and adapting up or down. These are design
requirements, not proof that all sender adaptation is already implemented.
The tested desktop commit `60073f7d` used `contentHint = 'detail'` and
`maintain-resolution` in `voiceMedia.ts`; those settings favor detail rather
than motion under constraint. This review corrected that narrow mismatch as
described below. The guide's complete adaptive controller remains separate
implementation work. [Sender helper](../../apps/web/src/lib/voiceMedia.ts).
A chooser cannot remove quality limits. The guide requires a new
design for thumbnails, a manual
quality selector, or 1080p/60-FPS mode; such changes must account for per-viewer
peer-to-peer encoding/uplink cost. [Screen Sharing rules](../../apps/web/src/lib/AGENTS.md#screen-sharing).

## Applied motion-preference correction

Screen video now requests `contentHint = 'motion'` and the matching sender
requests `degradationPreference = 'maintain-framerate'`. Camera, microphone,
and screen audio keep their existing paths. Both unavailable sender parameters
and a rejected preference fall back without interrupting sharing. These are
browser optimization requests, not guarantees of achieved receiver frame rate;
720p/30 FPS remains the capture ceiling. The content-hint specification explains
that motion-oriented video prioritizes frame rate over fine spatial detail.
[W3C MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/).

Because installations deliver the React interface, deploy the updated web build
to the test installation to exercise this change. Rebuilding only the local
Tauri chooser does not update that remote media helper. The contributor's smoke
report predates this correction; improved game smoothness needs a new comparison.

Verification run from the repository root:

- `npm run typecheck -w @voxly/web` passed.
- `npm run build:tests -w @voxly/web` passed.
- `node --test apps/web/dist-test/test/voice-controls.test.js` passed 15/15.
- `npm run build -w @voxly/web` passed with the existing chunk-size warning.
- `npm run test -w @voxly/web` passed 801/802; the existing Turkish
  browser-offline copy assertion still fails, as documented in the
  [acceptance record](../desktop-windows-acceptance.md#development-verification--macos-2026-09-29).
- `git diff --check` passed. Windows receiver smoothness has not been measured
  for the corrected preference.

## Bounded acceptance comparison

Use the same Windows 11 PC, runtime/build versions, game scene, browser peer,
network, audio devices, and 720p/30-FPS target for both candidates. Record GPU,
game settings, viewer count, and whether a direct or TURN connection was used.

| Scenario             | Evidence needed                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Select game/window   | Steps, time to first visible frame, keyboard/focus behavior, cancel behavior; no automatic capture.                                 |
| Borderless game      | Ten-minute share with foreground/alt-tab transitions; receiver frames and audio continuity.                                         |
| Exclusive fullscreen | Explicit pass/fail, black/frozen-frame behavior, and safe borderless/monitor fallback.                                              |
| Motion               | Sender/receiver WebRTC frame statistics and freeze duration; separate capture failure from bandwidth adaptation.                    |
| Audio scope          | Play game audio and unrelated audio together; record exactly which the viewer hears, including possible call-audio echo.            |
| Lifecycle            | Close game, resize, stop share, leave room, switch installation, hide to tray, and reconnect; no stale tracks or automatic restart. |
| Resources            | Complete native/browser process-tree CPU and memory, plus game performance under the same workload.                                 |
| Trust boundary       | Unselected origins/subframes cannot enumerate titles/thumbnails, select sources, or trigger silent capture.                         |

Choose a replacement only if it materially improves the named requirement
without regressing voice, audio scope, consent, cleanup, or measured resources.
If there is a native capture failure, record a reproducible game/mode case
before deciding whether a Windows adapter is justified.

## Clarified desktop priorities: call audio exclusion and shortcuts

The member clarified that desktop must make game sharing easier, avoid hearing
their own voice again while watching a friend's share, and provide configurable
mute/unmute shortcuts while another application or game has focus. The friend
may be sharing from Voxly in a normal browser. These requirements strengthen
the case for an application-owned desktop chooser; they also require improving
the browser sender's audio selection.

### Exclude call audio at the sender

If the friend's computer captures every sound it plays, it can capture the
member's incoming voice and send it back inside the screen audio. **Signal-path
assessment:** once voice and game sound are mixed into one incoming track, the
desktop viewer has no separate self-voice track to discard. Muting the entire
screen audio stops the echo but loses game sound. The durable fix is to keep
call playback out of capture at the sharing computer. Acoustic microphone echo
is a different path; do not claim microphone noise suppression solves desktop
loopback capture.

`restrictOwnAudio` asks a capturing document to exclude its own playback.
The specification requires an attempt at removal and exposes supported
constraints and applied track settings. It is not an unconditional echo-free
guarantee. `suppressLocalAudioPlayback` instead suppresses playback of a captured
browser source while retaining that sound in capture; it is not call-audio
exclusion. [W3C audio capture properties](https://www.w3.org/TR/screen-capture/#constrainable-properties).

Microsoft documents `restrictOwnAudio` as an Edge 141 feature, including its
purpose of preventing screen-recording echo. **Recommendation:** request it
from Voxly's web capture helper when supported, so browser friends benefit too.
Feature-detect the actual runtime, inspect the returned audio track's settings,
and test audible call exclusion. A browser release note does not prove that
every deployed WebView2 version and selected capture source behaves identically.
[Microsoft Edge 141 release notes](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/141#restrictownaudio-media-track-constraint).

Chromium's Windows implementation has historically required capture across
all audio output devices to apply this restriction rather than just the default
device. Therefore test multiple outputs and device switching; the member's
chosen speaker alone is not enough evidence about captured audio scope.
[Chromium implementation change](https://chromium.googlesource.com/chromium/src.git/+/9868f40a413632932a3642a389e5bb634a3f851e).

Electron's current main-branch implementation specially handles
`request.restrict_own_audio` with `audio: 'loopback'` on Windows, selecting its
loopback-without-Chrome device. That is source evidence for a candidate path,
not certification of a pinned shipped release. Its `loopbackWithMute` option
must not be interpreted as selective Voxly-call exclusion: the documented
session interface names system loopback, and the own-audio remapping condition
is specific to ordinary loopback. Test the selected release explicitly.
[Electron implementation](https://github.com/electron/electron/blob/main/shell/browser/electron_browser_context.cc),
[Electron capture contract](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).

For guaranteed audio scope at the native routing layer, Windows application
loopback can include the chosen game process tree, or exclude the dedicated
Voxly process tree while capturing other audio. Including only the game is the
clearer privacy scope. Excluding Voxly still includes other applications; for a
browser sender, excluding the entire browser tree may also remove desired audio
from other tabs. Native audio must be integrated at the sender; a desktop viewer
cannot apply this API to a friend's computer. [Microsoft application-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

### Global mute/unmute is supported by both frameworks

Tauri's official global-shortcut plugin supports Windows, registration in Rust,
and pressed/released events. Keep registration and shortcut preferences in the
local shell; expose a finite voice action to the selected installation rather
than general plugin authority. The plugin grants no registration permissions
by default. [Tauri global shortcut](https://v2.tauri.app/plugin/global-shortcut/).

Electron's `globalShortcut` works while its application lacks keyboard focus.
Registration returns success/failure and can fail when another application
owns the key combination; unregister on replacement and exit. Therefore global
shortcuts alone do not require switching from Tauri. [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut/).

**Implementation requirements:** let the member choose a modifier-plus-key
combination, show registration conflicts, and persist preferences locally.
Dispatch existing mute/unmute semantics so owner-enforced mute still wins.
Handle one toggle per press, reconnect/no-room states, tray operation, and
changing installations. Test ordinary and elevated games rather than promising
that every reserved key or exclusive-fullscreen title accepts the shortcut.

### Framework recommendation for these priorities

Electron is the stronger candidate if a Voxly-owned game/window chooser is a
core requirement: its documented source and display-media APIs connect that
chooser directly to the existing web media track path, and it also supplies
global shortcuts. Run the bounded comparison above before approving a migration.
Tauri remains suitable for tray voice and global shortcuts, but its documented
WebView2 capture event does not supply equivalent picker control; satisfying
that requirement through a native adapter takes more media integration work.
Neither option automatically delivers game-only audio, every game's fullscreen
capture, or Discord's custom encoding and fallback pipeline.

Regardless of framework, prioritize browser-side `restrictOwnAudio` with clear
fallback and validation now. For stronger desktop audio isolation, define
game-only process capture separately. Preserve the peer-to-peer media and
trusted local shell decisions in [ADR-0019](../adr/0019-desktop-keeps-native-authority-local.md).

Extend the acceptance comparison with these explicit cases:

- A browser friend shares game/system sound while receiving the viewer's voice:
  game remains audible and the viewer does not hear their voice returned.
- Repeat with desktop sender, different output devices, and runtime versions;
  record whether `restrictOwnAudio` is recognized/applied and whether audio ends
  or becomes silent after a source/device change.
- A game-only audio mode excludes a separate music player and the call; an
  all-other-audio mode clearly reports its broader scope.
- Custom mute/unmute works with the game focused and Voxly in the tray, gives
  one transition per press, reports shortcut conflicts, and obeys owner locks.

## Implemented follow-up

Voxly now requests optional `restrictOwnAudio: true` in web screen capture and
chooser probes. Diagnostics preserve advertised support and a returned track
setting without claiming either is audible proof. The browser may ignore the
request; a receiver cannot unmix voice already included by an unsupported sender.

The Tauri client now has local, persistent mute-toggle settings with conflict
feedback and a one-way version-1 intent bridge. It reuses microphone controls
only in a connected call with a live microphone capture and preserves owner,
room, and deafen locks. See [ADR-0020](../adr/0020-desktop-mute-intent-grants-no-native-authority.md)
and the [Windows test steps](../desktop-windows-acceptance.md#next-windows-test-mute-shortcut-and-call-audio-exclusion).
An application-owned game picker and Electron comparison prototype remain
unimplemented; the current test client still uses WebView2's picker.
