# ADR-0021 — Desktop browser sign-in stays in the webview

The installation-delivered web interface starts the desktop authorization
request and holds its private collection secret in its own webview memory.
It opens only a public request identifier in the signed-in browser, where a
member compares a number and explicitly approves. The webview collects the
new session through same-origin HTTP, so its HttpOnly cookie lands in the
correct installation profile. This avoids native HTTP cookie transfer and a
remote-to-native IPC grant for authentication. The request is short-lived,
origin-bound, revocation-aware, and one-use; Link code remains the fallback.
