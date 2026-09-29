# ADR-0020 — Desktop mute intent grants no native authority

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
