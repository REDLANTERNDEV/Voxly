# Desktop activation research

Reviewed 2026-09-30 against the checked-in Tauri 2.11.6 lockfile. This is an
implementation recommendation; installed Windows activation has not been
measured here.

The running-notification recommendation below is now implemented as
`activate_installation` in ADR-0024. The deep-link portion remains a proposal.

## Existing boundary

`platform.rs` creates one active installation webview with its own profile,
unique generation label, exact-origin navigation policy, and a narrowly scoped
call-state capability. `main.rs` already shows/focuses the current window from
the tray and the single-instance callback. That callback currently discards
arguments. `desktopNotifications.ts` creates silent standard `Notification`
objects but retains no activation handler. The config has no deep-link scheme.
Cargo currently locks single-instance 2.4.5, WebView2 COM 0.38.2, and Windows
0.61.3; only single-instance is a direct dependency among those integrations.

## Standard notification activation

Keep WebView2's default delivery and browser permission. A page-created
notification has a standard `click` event. The Notifications Standard only
recommends bringing its browsing context into focus and encouraging `focus()`
inside that listener; it does not guarantee revealing a hidden native host
window. Attach a click handler and route through the existing web router in the
current document, preserving sockets and media. Avoid notification navigation
URLs, full-document navigation, or custom-protocol round trips for this path.
[Notifications Standard](https://notifications.spec.whatwg.org/#activating-a-notification).

The minimum additional native authority is one parameterless
`activate_current_installation` command: validate the actual caller's unique
active webview label and exact current origin, then show, unminimize, and request
focus for that window only. Grant its custom permission to that generation and
origin, register it in the app command manifest, and expose only a versioned
activation method from the top-frame initialization script. Supply no URL,
window label, installation identifier, executable, or script argument. Tauri
provides these window methods and remote capabilities; capabilities do not
replace checks inside Rust.
[Tauri 2.11.6 window API](https://docs.rs/tauri/2.11.6/tauri/webview/struct.WebviewWindow.html),
[Tauri capabilities](https://v2.tauri.app/security/capabilities/).

This is deliberately a small remote-to-native permission. A compromised active
installation can invoke it without a genuine toast click; a JavaScript wrapper
cannot prove OS activation. Its entire consequence must remain revealing its
own window. Browser routing remains ordinary untrusted web behavior. Origin
checks and narrow operations follow Microsoft's host guidance.
[WebView2 security](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).

This extends the current authority boundary in [ADR-0019](../adr/0019-desktop-keeps-native-authority-local.md)
and [ADR-0022](../adr/0022-desktop-call-reports-grant-no-actions.md), which currently
grant only reporting to remote content. Record the finite activation exception
explicitly; never repurpose `report_call_state` to trigger it.

`NotificationReceived` is not a native click listener for WebView2's default
toast. Setting `Handled=true` suppresses default delivery and makes the host
responsible for showing and reporting the notification lifecycle. `ReportClicked`
reports a host-handled click back to JavaScript; it requires handled delivery
and prior `ReportShown`. Taking that route means implementing native notification
UI/lifecycle, not adding a harmless observer.
[NotificationReceived arguments](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2notificationreceivedeventargs),
[ICoreWebView2Notification](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2notification#reportclicked).

The proposed standard-click path needs no notification plugin, direct COM crate,
or new Windows dependency. If installed tests show default activation cannot
reach the live page, investigate host-handled Windows toasts separately. Tauri's
`with_webview` exposes the native controller, but using COM interfaces requires
compatible direct dependencies and care across Tauri minor updates.
[Tauri native webview access](https://docs.rs/tauri/2.11.6/tauri/webview/struct.WebviewWindow.html#method.with_webview).

## Routing-only deep links

Add `tauri-plugin-deep-link`, enable single-instance's `deep-link` feature, retain
single-instance as the first registered plugin, and statically configure
`plugins.deep-link.desktop.schemes = ["voxly"]`. Windows delivers a link as a
new process's argument; the feature forwards it to the existing process.
Register Rust `on_open_url` and read `get_current` during startup. Keep plugin
permissions out of remote installation capabilities. Static scheme registration
normally accompanies installation; `register_all` is useful for development,
where registering it changes the current user's protocol association.
[Tauri deep linking](https://v2.tauri.app/plugin/deep-linking/).

Treat every URI as untrusted, including direct command-line arguments. Proposed
contract: one bounded `voxly://open` URI carrying only an installation origin
and optional validated Server/room route identifiers. Reject credentials,
ports/hosts outside the accepted origin rules, fragments, duplicate/unknown
fields, malformed encoding, noncanonical routes, auth/invite/access/claim tokens,
and all action parameters. Parsing a link must never authenticate, join voice,
start capture, create an installation, or switch a live installation.

For the matching active installation, activate and send a validated route to
the web router. Otherwise show the local chooser with a bounded pending request;
require ordinary explicit installation selection before delivering it. Keep the
pending request until the new web client subscribes, consume it once, and
invalidate it on cancellation, installation changes, or origin mismatch. Read
startup URLs and running events through the same validator; deduplicate initial
delivery. The plugin's source stores startup arguments and emits subsequent
URLs, so reading its startup value alone is insufficient for live routing.
[Official deep-link implementation](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/deep-link/src/lib.rs).

## Windows acceptance limits

Windows can deny foreground focus even when a process satisfies its documented
conditions. Showing a window and requesting focus is not proof that it became
foreground. Do not use always-on-top or repeated focus stealing as a fallback.
[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).

Verify an installed NSIS build: banner and notification-center clicks while
hidden/minimized; foreground focus with another app active; lock/unlock;
permission denial; stale notification after document/installation replacement;
running and cold deep links; mismatched origins; malformed/token-bearing links;
router readiness; and an active call remaining intact. Page-created notification
handlers require their live document: do not promise activation after quitting
the application. Test cold launch through the registered route separately.
