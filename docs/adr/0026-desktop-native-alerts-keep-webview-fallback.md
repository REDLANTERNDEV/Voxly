# ADR-0026 — Native desktop alerts retain WebView2 compatibility

Installed testing established that WebView2's default notification UI is not
the desired Windows desktop experience. Supersede ADR-0024's default delivery
choice with Windows toasts under the bundled application identity. Use the
existing Windows dependency directly: the general notification plugin does not
provide the desktop lifecycle/error contract this fallback requires.

Grant the current exact origin, unique window label and generation two finite
commands: show a known category in English/Turkish with a temporary random ID,
and close one of that window's IDs. Reject unknown fields and invalid IDs.
Native code owns generic copy, silent XML and the application ID; no message
content, credentials, Account IDs, routes, external images or launch arguments
enter native notification state. Bound retained handles and category repeats.
The installed NSIS Start-menu shortcut supplies the application's AUMID.

Clicks return only a handle ID to the same live document. Existing Account
checks, window activation and channel navigation remain web-owned; no toast
joins voice. Banner timeout retains its handle for history activation. Logout,
replacement, navigation, cancellation and Quit retire owned native alerts.
Cold-start channel activation is not added by this decision.

Keep WebView2 permission as the explicit enabling gate. Prefer Windows delivery,
fall back once on native API/send failure, and let each Account choose
Compatibility (WebView2) if installed behavior causes trouble. Respect reported
Windows-disabled delivery rather than bypassing it with fallback. This does
not promise to detect every Windows suppression or history/activation failure.

Microsoft's [desktop toast quickstart](https://learn.microsoft.com/en-us/windows/win32/shell/quickstart-sending-desktop-toast)
describes the AUMID and lifecycle requirements. Portable bridge/fallback tests
and a Windows API compile probe do not establish installed Windows behavior;
[acceptance](../desktop-windows-acceptance.md) must verify banner and history
clicks separately before shipping this as validated native integration.
