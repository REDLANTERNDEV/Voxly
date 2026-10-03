# ADR-0022 — Desktop call reports grant no native actions

Disconnect, switch, retry and Quit need to distinguish idle windows from calls,
retained capture and pending media work. Extend [ADR-0019](0019-desktop-keeps-native-authority-local.md)
and [ADR-0020](0020-desktop-mute-intent-grants-no-native-authority.md) with one
remote-to-native command, `report_call_state`. Each remote window gets a unique,
never-reused generation label and a runtime ACL granting only that command to
its selected exact origin. Installation management, permissions, browser
opening, shortcut registration and update trust remain local.

The separate version-1 bootstrap checks exact origin and top frame and exposes
only a synchronous state-provider lease. It answers a native request with nine
booleans: voice membership, effective microphone/camera/screen/computer audio,
retained capture, pending join, pending capture work and microphone testing.
The native command validates the active window label, current origin, generation,
request number and complete finite payload. Replies are accepted once for an
outstanding local request, never persisted, and never trigger a native action.
No Account, Server, room, track, device identifier or arbitrary string crosses
this boundary. Tauri's [runtime capability builder](https://docs.rs/tauri/2.11.6/tauri/ipc/struct.CapabilityBuilder.html)
provides the remote URL, webview-label and single-permission scoping.

Request fresh state for each local transition; there is no heartbeat or cached
idle claim. Missing providers, old web clients, malformed reports, navigation,
late/replayed replies or the 750 ms deadline require conservative confirmation.
Recheck immediately before destroying the window, after any replacement health
check. A failed health check preserves the old call. Cancellation retains
capture; consent ends chooser probes before native work, and webview destruction
ends installation capture. Hiding still preserves the call. Report transport
failure must not prevent ordinary web use or alter microphone mode/navigation.

This report is advisory information supplied by the installation, not proof
against a malicious operator: that operator already controls its media code and
can misreport its own state. The grant cannot select an installation, terminate
a call, execute scripts, read files, register shortcuts or configure updates.
Fresh request/reply sampling was chosen over periodic reporting because a
hidden renderer can throttle timers and leave an old idle report behind.
Installed Windows/WebView2 tests are still required to verify transport, call
continuity, capture teardown and ACL denial with real windows.

[ADR-0024](0024-desktop-alert-activation-only-reveals-its-window.md) adds a
separate permission to reveal the current window. Call reports still grant no
actions and never serve as notification activation requests.
