# ADR-0030 — Desktop diagnostics saving requires user selection

The desktop blocks general webview downloads under
[ADR-0019](0019-desktop-keeps-native-authority-local.md). This also prevents the
browser's voice diagnostics download from working. Add one bounded exception:
`save_voice_diagnostics` opens a native Save As dialog for an anonymous,
versioned voice report. The native dialog owns the destination; the remote
Installation supplies no path, filename, filesystem operation or dialog options.
The default filename is `voxly-voice-diagnostics.json`.

Scope the dedicated bootstrap and runtime capability to the current top-frame
Installation's exact origin and window generation. Validate the caller before
showing the dialog, then recheck active Installation, window generation and URL
after the user chooses a destination and immediately before writing. Keep one
save dialog in flight. Cancellation returns quietly; an invalid report, lost
authority or write failure remains recoverable in the web interface.

Reports contain only the existing numeric measurements, anonymous peer numbers,
finite diagnostic states and call timestamps. Enforce the version, field and
string allowlists, three calls, 500 samples per call, bounded nesting and an
8 MiB payload limit in native code. Reject identifiers, tokens, addresses,
conversation content and arbitrary strings. Saving never uploads a report and
general webview downloads remain blocked.

Use the official Tauri dialog plugin internally without granting remote pages
its generic dialog or filesystem permissions. This extends the remote command
boundary separately from [ADR-0022](0022-desktop-call-reports-grant-no-actions.md):
call-state reports remain advisory and cannot trigger saving or other native
actions. A caller-supplied path or general filesystem grant would let an
Installation choose a destination without the user's native selection, so the
command deliberately exposes only the report payload and saved/cancelled result.

Installed Windows testing must verify Save As, cancellation, overwrite behavior
and filesystem failure in WebView2; macOS native compilation and boundary tests
do not establish that platform behavior.
