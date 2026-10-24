# ADR-0031 — Stale Session rejection preserves successors

- **Status:** accepted
- **Date:** 2026-10-10
- **Context:** refines [ADR-0016](0016-session-reuse-requires-confirmed-delivery.md)
- **Refined by:** [ADR-0033](0033-replacement-confirmation-waits-for-persistence.md):
  confirmation waits until the replacement could have been persisted

## Context

Confirmed replacement delivery proves the browser received a credential. It
does not prove a later request carrying its predecessor came from another
party. A request can be delayed beyond grace; a delayed fixed-name cookie
response can also overwrite a newer credential. Both reproduced locally and
caused valid Sessions to be revoked under the earlier policy. These reproductions
do not establish the cause of any particular production incident.

## Decision

Each browser credential uses an immutable cookie name containing its SHA-256
hash: `__Host-voxly_session_<hash>` over HTTPS, `voxly_session_<hash>` over HTTP.
The value remains HttpOnly; Secure, SameSite=Lax, Path=/ and expiry rules remain.
Only hashes are persisted. Token-specific names prevent delayed responses from
overwriting newer credentials.

HTTP, Socket.IO and authentication without renewal share selection. Protected
names take precedence, generated names must match their values, and SQLite's
current token wins within the latest represented Session. SQLite insertion
order selects between Sessions, independent of timestamp ties and cookie order.
An invalid latest Session cannot fall back to an older Account.

Cleanup removes obsolete names actually presented by the request, never an
unseen successor. Superseded credentials are not reissued during renewal. The
unconfirmed-delivery recovery path from ADR-0016 can still issue a replacement;
inside grace, keep the old cookie when its replacement might not have arrived.

A confirmed retired credential after grace receives `401 session_reused` for
compatibility. Record `session.stale_rejected` once per retired credential,
including its Account, Session and time. Do not clear cookies or revoke the
valid successor. The old credential remains blocked. Explicit logout, Device
and owner revocation, Account bans/deletion and expiry still deny access.

Successful account-entry flows clear previous browser cookies. Logout revokes
accepted Sessions represented by the presented credentials and clears their
names; rejected stale credentials cannot authorize revocation of successors.
Other Devices remain unaffected.

Both fixed legacy cookie names remain readable and successful HTTP use upgrades
them. The Music bot retains its advertised fixed cookie name and short-lived
Session. Deploy reader and writer together; rollback must retain the new reader.
Previously revoked Sessions are not reactivated by migration.

Reconnect checks use the authentication request gate. Confirm a current 401 with
one fresh lookup, and clear authentication only on a second current 401. A
successful sign-in, newer check or unmount invalidates older outcomes. Network
and server failures preserve authentication.

## Consequences

An isolated copied old credential is rejected after confirmed delivery and
grace, while the current credential continues to work. Automatic revocation of
the valid successor is deliberately removed: delayed traffic is insufficient
evidence to deny the member access. Explicit Device controls remain available.

Nullable additive audit Session ids and retired-token rejection times make
future failures diagnosable. Structured logs use reason codes and request ids;
the read-only diagnostic command reports dates and correlated events without
credentials or their hashes. It does not migrate the evidence database.

Normal server tests cover response reordering, lost delivery, recovery, cookie
selection, cleanup and revocation. Browser checks use real cookie storage,
multiple tabs, a reopened persistent profile and realtime reconnects.
