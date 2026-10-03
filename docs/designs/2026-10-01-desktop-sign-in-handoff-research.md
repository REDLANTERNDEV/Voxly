# Browser approval for desktop sign-in

Research date: 2026-10-01. This document separates documented app behavior
from a proposed Voxly implementation. It does not infer private protocols from
the appearance of another app's sign-in screen.

## What popular apps document

| App | Documented behavior | Relevant lesson |
| --- | --- | --- |
| GitHub Desktop | Opens the default browser for authentication. An Account already signed in there can follow the return prompts without entering credentials again. | Reuse the trusted browser session through an explicit authorization flow. |
| Slack | Supports app and browser sign-in, workspace selection, and signing into mobile from a signed-in desktop using a QR code. | Keep the destination and workspace clear; multiple Installations require deliberate selection. |
| Discord | A signed-in mobile app scans a desktop/browser QR code, then asks for approval. The request expires after two minutes. Discord warns against approving a request the member did not initiate. | Avoid repeated credentials while retaining a visible approval on the trusted Device. |

Sources: [GitHub Desktop authentication](https://docs.github.com/en/desktop/installing-and-authenticating-to-github-desktop/authenticating-to-github-in-github-desktop?platform=windows),
[Slack sign-in](https://slack.com/help/articles/212681477-Sign-in-to-Slack-Sign-in-to-Slack),
[Discord QR Code Login FAQ](https://support.discord.com/hc/en-us/articles/360039213771-QR-Code-Login-FAQ).
These guides explain the interface, not the exact credential exchange used
internally. In particular, they do not establish that an ordinary deep link
copies a browser session cookie into the desktop app.

## Standards and storage constraints

RFC 8252 recommends an external browser for native authorization. A custom
scheme can be claimed by another local app, so a code in a callback URI must
not independently grant access. Native OAuth clients use PKCE to bind
redemption to a secret held by the initiating app.
[RFC 8252, sections 6 and 8.1](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.1).

PKCE's S256 challenge is the base64url SHA-256 hash of a per-request verifier;
the verifier is presented only during code exchange. The specification
recommends at least 256 bits of verifier entropy.
[RFC 7636, sections 4.1–4.6](https://www.rfc-editor.org/rfc/rfc7636.html#section-4.1).

OAuth authorization endpoints need CSRF protection and careful redirect
validation. These protections are also useful design principles for Voxly's
own Device authorization, even though Voxly does not currently implement an
OAuth authorization server.
[RFC 9700, sections 2.1 and 4.7](https://www.rfc-editor.org/rfc/rfc9700.html).

WebView2 stores cookies and other browser state in a host-app user data
folder. Voxly already uses a distinct directory for each Installation in
`apps/desktop/src-tauri/src/platform.rs`. Browser sign-in therefore cannot be
assumed to sign in Voxly's WebView2 profile automatically. Copying another
browser's cookie database would break this isolation and is unnecessary.
[Microsoft WebView2 user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder).

Voxly's existing Device Link design requires approval on a signed-in Device:
a secret caught in a shared screen must not alone authorize a new Device.
The same property should hold for desktop sign-in.
[ADR-0014](../adr/0014-members-link-their-own-devices.md)
and `apps/server/src/deviceLinks.ts`.

## Recommended Voxly behavior

This is a proposal derived from the constraints above, not a description of
another app's private protocol:

1. **Open in desktop** passes only the canonical Installation origin through
   `voxly://`, optionally with a public correlation UUID. No session, Link code,
   Recovery code, or redeemable credential
   belongs in the URI or process command line.
2. A remembered, reachable Installation opens directly. For a new address,
   one clear **Open** action can replace the separate use-address, remember,
   and open steps. Retain confirmation before leaving an active call.
3. If the desktop Device already has a valid session, restore it without
   replacing its Account with the browser Account.
4. If it needs sign-in, the desktop Device initiates a short-lived request at
   that Installation. It alone receives a full-entropy private claim secret.
   Store only its hash server-side, and keep the secret in desktop memory.
5. The original browser tab retrieves the public request ID through its
   authenticated launch correlation; standalone desktop sign-in can still open
   a browser approval page with that public request ID.
   The browser uses its existing session. Show the Account, Installation,
   destination Device description, and a number also visible in desktop.
   One **Approve** action completes authorization; no code typing is needed.
6. The desktop Device collects the result with its private secret using a
   same-origin POST. The server atomically consumes approval and creates a
   new Device session through the ordinary session subsystem. Its response
   sets the HttpOnly session cookie in the Installation's WebView2 profile.

This polling design keeps every redeemable secret out of the browser return
URI. If a future design returns an authorization code through a custom scheme
instead, use a native-generated S256 PKCE verifier and validate outstanding
state, Installation origin, and exact callback shape before exchange.

## Required boundaries and acceptance

- Creating, approving, and collecting requests must enforce short expiry,
  rate limits, exact origin binding, and generic invalid-request errors.
- Approval requires an authenticated same-origin POST. Opening the approval
  page or clicking an origin-only desktop link never grants authorization.
- Recheck the approving Account and source session when collecting. A revoked
  source session, deleted/banned Account, refused/cancelled request, expired
  request, or already consumed approval must not create a session.
- A public request ID or confirmation number alone cannot collect a session.
  Concurrent collectors create at most one new Device.
- Explicit approval is still needed for a previously unsigned-in Device.
  Removing it would let an attacker send their own request to a signed-in
  member and attempt to bind the attacker-controlled Device to that Account.
- Cancelling, expiry, missing desktop installation, unreachable Installation,
  and an outdated server keep normal Link code sign-in available.
- Installed Windows acceptance must cover cold/running/tray launch, an
  existing desktop session, a different browser Account, call interruption,
  cancel/refuse/expiry, and successful sign-in visible under Devices. Automated
  coverage does not establish those OS/browser interactions passed.

The smooth goal is one click to open an already authorized desktop Device,
and a single clear browser approval when authorizing a new Device. Browser
application-launch permission prompts remain controlled by the browser.
