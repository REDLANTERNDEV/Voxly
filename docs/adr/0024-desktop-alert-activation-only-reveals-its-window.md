# ADR-0024 — Desktop alert activation only reveals its own window

Standard WebView2 notifications stay generic and silent, but clicking one must
restore Voxly from the tray. Extend ADR-0019/0022 with a separate parameterless
`activate_installation` command: the current unique webview label, exact origin
and generation receive permission to show, unminimize and focus that same
window. Serialize validation with Installation replacement. This is a finite
native action, distinct from call-state reporting; an Installation may request
its own foreground window, but cannot choose a host, navigate native content,
read files, configure shortcuts, terminate capture or control updates.

The web document owns the alert's channel target in memory and uses ordinary
application navigation after successful focus. Account changes, disposal and
replaced alerts invalidate old handlers; routes must resolve through known
channels and current Server memberships. Voice routes remain viewing only.
Targets never enter OS notification content or native persistence. Cold-start
activation and external `voxly://` links are a separate pending integration.
The [primary-source research](../designs/2026-09-30-desktop-activation-research.md)
supports this small bridge over custom host-managed notification UI; actual
Windows toast click delivery and foreground behavior still require installed
acceptance.
