# Personal Server message notifications

Each Account has private persistent read cursors per text channel and personal
message notification settings per Server. These are not read receipts visible
to other members and do not affect owner-enforced voice mute/deafen.

The Server logo aggregates unread messages from its text channels and displays
1–9 or 9+. Channel badges retain their full counts. Own and deleted messages do
not contribute. Opening one channel clears only that channel after history has
loaded in a visible, focused window. Messages arriving after a history response's
watermark remain unread until delivered to that view.

The additive migration assigns per-room message sequences and baselines existing
histories once. Membership activation/reactivation also starts clean. Subsequent
starts preserve cursors and notification settings. Message insertion increments
the room counter and writes its sequence in one transaction. Read updates use a
monotonic maximum and reject sequences beyond the room counter.

Members can mute message notifications for 15 minutes, 1, 3, 8, or 24 hours, or
indefinitely. A mute suppresses message sounds and desktop alerts and hides the
Server badge; unread channel counts continue accumulating. Expiry/unmute restores
the badge without playing old alerts. Server time determines timed expiration.

The authenticated notification snapshot lists only active Memberships and their
text-channel counts. Private read/settings changes invalidate only that Account's
Devices. Creation, deletion, reconnect, focus, and room/membership changes cause
clients to refresh summaries. Refreshes are coalesced and stale responses rejected.
Unavailable reads or settings remain recoverable rather than clearing local state.

No hosted notification provider, message media processing, or new operator
configuration is required. SQLite backup/restore includes the new state.
