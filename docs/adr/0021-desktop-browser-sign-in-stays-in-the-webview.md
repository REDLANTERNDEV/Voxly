# ADR-0021 — Desktop browser sign-in stays in the webview

> **Amendment (October 2026 security audit).** A desktop authorization request
> now always claims a browser launch ([ADR-0027](0027-browser-desktop-handoff-keeps-approval.md));
> the server refuses one without. A request the desktop window started on its
> own could be a stranger's — anyone can create one — and any signed-in member
> who approved it handed that stranger their account. Number comparison cannot
> stop a member being talked into approving. The desktop window's manual path
> now sends the member to `/desktop/sign-in` in their browser, which creates
> the launch. Link code remains the fallback, including for older desktop
> builds whose manual request is now refused.

The installation-delivered web interface starts the desktop authorization
request and holds its private collection secret in its own webview memory.
It opens only a public request identifier in the signed-in browser, where a
member compares a number and explicitly approves. The webview collects the
new session through same-origin HTTP, so its HttpOnly cookie lands in the
correct installation profile. This avoids native HTTP cookie transfer and a
remote-to-native IPC grant for authentication. The request is short-lived,
origin-bound, revocation-aware, and one-use; Link code remains the fallback.
