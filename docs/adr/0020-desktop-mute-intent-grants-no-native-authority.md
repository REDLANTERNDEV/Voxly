# ADR-0020 — Desktop mute intent grants no native authority

> **Amendment (October 2026 security audit).** Shortcut editing moved into Voxly
> Settings under [ADR-0023](0023-desktop-settings-have-local-authority.md), and
> that bridge let the Installation name any binding, so a page could bind keys
> nobody pressed and watch them system-wide. The page may still start and stop
> a recording, but a binding it asks for is committed only if it is exactly the
> chord the native low-level hook saw the person press during that recording —
> real input, not injected, with a Voxly window in front (`matches_observed`,
> `authorize_remote_binding`). Otherwise the bridge answers
> `shortcut_unobserved`. Clearing and resetting a binding need no evidence. The
> local shell keeps its own typed bindings.
>
> **Second amendment (October 2026).** The page also decided _when_ a recording
> started, so it could switch one on while the member typed in chat and turn a
> captured `H` into a global shortcut. Two rules close that. First, a remote
> `shortcut` request, including a clear, no longer saves anything. Native code
> holds the request (`RemoteShortcuts`), brings the Home shell forward, and the
> Home shell asks the member to confirm the action, keys and Installation
> origin. Only the local Confirm commits, through `answer_shortcut_request`,
> which the shell alone may call, and it saves the binding native code held
> rather than one named by the answer. A newer request, window replacement or a
> new voice generation drops the pending one. The remote call answers
> `shortcut_pending`. Second, a recording the page starts ends by itself without
> saving after 15 seconds. The observed-chord check above stays as a second
> layer, so the member is only ever asked about keys they really pressed.

The Windows desktop needs global microphone mute without giving an
installation control of OS shortcut registration. Use a version-1, top-frame,
exact-origin bootstrap with a single mute subscription: Rust sends a fixed
intent to the selected installation, and the web client applies its existing
microphone action only in a connected call with a live microphone track and
no deafen, owner, or room lock. Registration and preferences stay in the local
chooser; remote content receives no native capability or callable command.

This extends [ADR-0019](0019-desktop-keeps-native-authority-local.md)'s initial
no-injection milestone after the reported Windows voice smoke tests. It does
not activate the planned remote-to-native bridge: any future notification or
media-state IPC still needs separate review, finite ACLs, and unique remote
labels. Reusing the current label remains safe while it has no native grant.
A missing subscription or incompatible web client performs no action; the
chooser explains that the installation must deploy the updated web client.

A bidirectional bridge would expose more authority and require a new caller
validation and permission lifecycle for a feature that needs only one native
to web intent. This narrower bridge leaves destructive-transition
confirmations conservative: it does not report call state to native code.

The 2026-09-30 extension adds independent deafen subscription and dispatch
methods to version 1. They remain fixed native-to-web intent with no native
authority granted to the installation. Older shells lack the optional methods
and keep mute working; older web clients ignore deafen. The receiver uses the
existing self-deafen transition, including its microphone restoration rules,
and permits receive-only calls without opening a microphone. Owner deafen and
microphone monitoring (including its pending isolation/restore) block the
shortcut. Owner mute and a room's microphone lock still prevent microphone
restoration through the existing transition. Participant voices are silenced;
screen audio retains its own volume/subscription contract.

Mute and deafen have separate local preferences, registrations, and press
latches. Reject the same combination for both actions. Changing or clearing
one action unregisters only that action; both mouse bindings share one hook
thread, which preserves the other action's held state during configuration.

Push to talk and Push to mute extend the same version-1 boundary with a finite
microphone mode and boolean hold state. The local chooser owns the mode and
four distinct shortcut registrations; the bootstrap supplies the saved mode
before the installation can open capture. Native press/release delivery is
ordered and does not wait on installation health checks or settings locks.
Releases still reach the call after the chooser gains focus; rebinding ends
that action's hold. Events from a destroyed installation generation are dropped.

The microphone mode gates publication separately from self-mute intent. This
keeps the microphone available to a held key without confusing idle Push to
talk with a receive-only call or requesting permission from a shortcut. Every
published and pending replacement track passes through the gate, and peer
media state reads enabled live tracks. A released talk key cannot be reopened
by a late acknowledgement. Room changes, deafen, owner mute, and disconnect
invalidate a held talk grant; a new press is needed. A held mute continues to
suppress publication until release, while manual mute and the pre-deafen
preference remain independent. The local monitor branch remains unchanged.

Old shells default to Open mic; old web clients ignore these optional methods.
The chooser and operator documentation require updating the installation and
verifying idle silence before relying on a hold mode. No installation receives
shortcut registration authority or a native command.

An optional 0–2000 ms Push to talk release delay extends only an existing talk
grant. The chooser owns its saved duration: entering Push to talk enables 200 ms
when the saved duration is zero, preserves an existing nonzero duration, and
allows disabling delay while the mode remains selected. A native Tokio
deadline emits a fixed release-expired intent without relying on background
web timers or the settings lock. The bridge reports physical hold separately
from the release tail; a tail cannot open capture or establish a fresh grant.
Re-pressing replaces the pending deadline. Manual mute/deafen, locks, room and
connection transitions, mode changes, and binding resets invalidate the tail;
an obsolete installation generation never receives the expiry. Old web clients
ignore the optional tail state and keep immediate-release behavior. Native
authority remains limited to the bundled chooser.

[ADR-0022](0022-desktop-call-reports-grant-no-actions.md) adds a separate finite
call-state reporting bridge. The voice intent object above remains one-way;
remote state reports cannot invoke native actions or register shortcuts.
