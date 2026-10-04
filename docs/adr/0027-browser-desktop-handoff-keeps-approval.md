# ADR-0027 — Browser desktop handoff retains Device approval

## Decision

Extend [ADR-0021](0021-desktop-browser-sign-in-stays-in-the-webview.md) with a
browser-initiated public launch correlation. The launch URI may include a
validated UUID beside the canonical Installation origin, but never a credential
or arbitrary path. A browser launch is not an authorization.

The signed-in browser creates a three-minute launch row bound to its Account,
Device session, and origin. A desktop webview claims it once when creating the
existing 90-second authorization. Only that webview holds the private collection
secret; the server stores its hash. The source browser polls for the public
request ID, shows the Account, Device description, origin, and matching number,
and explicitly approves. Approval is restricted to the source Device. Collection
still atomically revalidates that session and Account, consumes the request, and
sets a new HttpOnly cookie inside the Installation profile. Cancelling an
unapproved launch also cancels its desktop authorization. Closing the browser
panel after successful approval must not cancel collection.

A matching active window is restored. A finite native-to-webview event carrying
only the public UUID lets a signed-out existing window start the same flow; an
authenticated window ignores it. The event grants no native command authority.
A cold/new webview uses the fixed `/link-device?desktopLaunch=<UUID>` route.
Neither the browser nor launch URI controls arbitrary web paths. An existing
desktop Account is preserved rather than silently replaced by the browser's.

Once a signed-out desktop window has created its authorization and confirmation
number, a browser-correlated launch minimizes that window so the browser's
approval remains accessible. Manual desktop sign-in yields when the member
chooses Open browser. Approval, refusal and expiry restore a successfully
minimized window; stale attempts cannot change focus. The optional,
parameterless `minimize_installation` action uses the same exact-origin,
window-label and generation checks as `activate_installation` (ADR-0024).
It changes only that window's presentation and carries no authentication data.
Older desktop builds retain their existing sign-in flow.

A saved Installation can open directly when no Installation is active. New
addresses and cross-Installation switches retain a local Open action. That
action combines reviewing, remembering, and opening through health checking and
call-aware confirmation. Accepting the address may remember it even if the
subsequent call-switch confirmation is cancelled; the old call remains intact.

## Why

The former use-address, remember, open, start-sign-in, copy-approval-address flow
was unnecessarily long. Browser correlation removes copying and repeated clicks
while preserving [ADR-0014](0014-members-link-their-own-devices.md)'s explicit
Device approval. A custom scheme can be intercepted by another local app;
silently approving whichever request first arrives could authorize the wrong
Device. Comparing the displayed number and approving remains necessary for
first sign-in. This is Voxly's own polling authorization protocol, not OAuth or
an assertion that other apps use the same private protocol. See the
[primary-source research](../designs/2026-10-01-desktop-sign-in-handoff-research.md).

## Verification

Regression coverage must pin source-Device binding, origin validation, private
secret collection, single claim/use, cancellation/expiry, and revoked source
sessions. Installed Windows acceptance must additionally verify cold, running,
tray, missing-handler, existing/different Account, and call-continuity behavior.
Browser/OS application-launch confirmation remains outside Voxly's control.
