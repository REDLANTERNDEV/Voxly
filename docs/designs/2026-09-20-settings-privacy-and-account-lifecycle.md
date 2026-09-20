# Settings, External Preview Privacy, and Account Lifecycle

**Status:** implemented

## Goal

Add a device-aware clock preference, give members provider-level control over
External previews, and introduce a recoverable review workflow around an
irreversible Account deletion transition. Keep the settings understandable to
ordinary members, preserve the current default chat experience, and make the
Installation owner's global authority explicit rather than hiding it in a
Server-scoped member action.

This design also records two deliberate non-features: Voxly does not add new
microphone sensitivity or processing profiles, and it does not load Meta
content in any form.

## Evidence from the current implementation

- Settings has `Account & devices`, `Voice & audio`, and `Appearance` sections.
  Theme and language are Device-local; audio preferences are Device-local and
  keyed by Account. There is no server-synchronised preference model.
- Message, edited-message, Invite, and access-link clocks use locale-derived
  `Intl.DateTimeFormat` options with no explicit hour-cycle preference.
- Voice already has input gain, fixed native echo cancellation/automatic gain/
  noise suppression, and an optional additional Voxly noise filter. Voice
  activity is adaptive; another sensitivity control would not be a rename of
  the existing behavior.
- External previews are derived in the browser only for YouTube, X/Twitter,
  Vimeo, and Spotify. Their sandboxed frames load lazily, which delays but does
  not prevent provider contact. The server does not fetch preview metadata.
- The Owner panel's current account list is scoped to the default Server, while
  its session list is installation-wide. No API currently returns an Account's
  Memberships and effective nicknames across every Server.
- Account references are explicit across sessions, Device links, Recovery
  codes, Memberships, Invites, access claims, messages, Server creation, and
  audit rows. Existing reads join through `users` and `server_members`, so a
  hard row deletion would erase history from presentation.

## 1. Clock preference

Add a clock choice under `Appearance`:

- `Auto` — the default; use the Device/browser hour cycle independently of the
  selected Voxly interface language;
- `12-hour`; and
- `24-hour`.

The preference is Device-local and applies to every wall-clock presentation,
including message timestamps, edited-message detail, Invite expiry, and access
link expiry. Relative descriptions such as “three days ago” do not change.
Formatting lives behind one explicit preference-aware helper so a new clock
cannot silently return to locale-only behavior.

## 2. Voice settings remain as they are

Do not add input sensitivity or `Isolation`, `Studio`, or `Custom` profiles.
Input level remains microphone gain. Browser-native processing stays fixed for
capture reliability, and Voxly's additional noise suppression remains the
existing opt-in filter. A new profile requires a concrete, independently
testable audio behavior rather than a label over the current controls.

## 3. Provider-level External preview privacy

Add a `Privacy` settings section with one switch for each supported Provider:

- YouTube;
- X;
- Vimeo; and
- Spotify.

All four start enabled to preserve the behavior members expect. Preferences are
stored on this Device and keyed by Account. `Enable all` and `Disable all`
actions are convenience controls over the four explicit values.

When a Provider is disabled, Voxly creates no Provider iframe, SDK, image,
thumbnail, metadata request, or other external fetch in that member's browser.
The server starts no fetch on that member's behalf. The ordinary link remains
clickable. A compact neutral row says that the named Provider's preview is off
and offers:

- `Show once`, which loads only that preview for the lifetime of the current
  room/page view; and
- a settings affordance that opens the `Privacy` section.

Changing room or reloading forgets one-time grants. Persistent changes happen
only in settings. Message-wide suppression by the author or Server owner still
wins before the viewer preference: a suppressed preview is not offered back to
individual viewers.

Meta content is excluded by ADR-0018. Instagram, Facebook, and Threads URLs are
ordinary links and must not add Meta origins to CSP.

## 4. Account deletion language and authority

An Account is installation-wide; a Membership is Server-scoped. Accordingly:

- only the Installation owner may approve, reject, or directly initiate
  Account deletion;
- a Server owner may kick or ban a Membership but cannot delete the Account;
- global ban remains the identity-preserving moderation tool for immediately
  stopping access; and
- deletion is permanent cleanup and anonymisation, not a punishment shortcut.

The UI explains this difference at the destructive action. Bot Accounts,
Deleted accounts, the Installation owner, and any Account that owns a Server
cannot be deleted. Blocking is enforced by the server inside the write, not
only by UI visibility.

## 5. Member-requested deletion

The bottom of `Account & devices` contains a danger card. A member sees the
irreversible effects, is told that the Installation owner will see all of their
Server names, effective Server nicknames, roles, and Membership states, and
types their current global nickname to submit.

Only one request may be pending per Account. While pending:

- the Account remains usable;
- the member may cancel;
- the Installation owner may approve or reject; and
- a cancellation or rejection starts a server-enforced 24-hour wait before a
  new request.

A new request produces one red alert for the Installation owner and keeps a
red pending-count badge until it is decided or cancelled. Dismissing the alert
does not dismiss the request. Repeated page loads do not create repeated alerts.
The member's card shows pending, cancelled/cooldown, or rejected state and the
remaining wait where applicable.

The request summary contains the global Account nickname and status, request
time, and a live projection of every active, banned, or removed Membership:
Server name, effective nickname, role, and state. These values are read from
the current Account and Membership tables, not copied into the request. Device,
session, token, Recovery code, Link code, Invite, and access-link details are
not part of the summary.

## 6. Installation-owner initiated deletion

The Owner panel gains two distinct installation-wide sections:

1. `Deletion requests`, containing the pending review queue and its badge; and
2. `Accounts`, a searchable directory for direct owner action.

The Accounts list shows global nickname, active/banned state, and Server count.
Its detail view shows the same complete Membership projection used by a deletion
request. It is not placed in a Server member menu, where a global operation
would look Server-scoped.

Direct deletion needs no member request or consent. The Installation owner
reviews the complete impact, types the Account's global nickname exactly, and
confirms the permanent action a second time. The transition then runs
immediately. If a request is pending it is decided as `approved`; otherwise the
decision source is `owner_initiated`.

## 7. The deletion transition

Both entry paths call one server-owned transition in one immediate SQLite
transaction. Before writing, it re-checks that the target exists, is an
ordinary non-Bot Account, is not already deleted, is not the Installation
owner, and owns no Server. A stale UI can never bypass those checks.

The transition:

- records deleted state without storing a translated tombstone nickname;
- removes the old global and Server-scoped personal nicknames;
- revokes every session and retired session-token lineage;
- invalidates live Device links and Recovery codes;
- revokes active Invites created by the Account and active access claims that
  it created or could consume;
- ends active Memberships while retaining Membership rows;
- preserves messages, replies, Membership history, and audit rows;
- records whether the outcome was request-approved or owner-initiated; and
- only after commit evicts every live socket and clears realtime presence and
  voice state.

The old Account cannot authenticate, link a Device, recover, accept an Invite,
or be restored. The same person may later accept a new Invite as a wholly new
Account with no inherited history.

Shared identity and message shapes carry deleted state explicitly. The web
client renders localized `Deleted member` / `Silinmiş üye` copy and a neutral
avatar; it never detects deletion by comparing nickname strings. All Deleted
accounts use the same label and retain no fragment of the former nickname.

If the target is online, realtime delivers a localized terminal reason before
the session is closed: owner-initiated deletion and approved member request are
distinct. An offline target later receives the normal signed-out experience;
authentication does not reveal through a special error that a particular
Account once existed. A rejected request remains visible to its still-active
member.

## Failure and race behavior

- Submit, cancel, approve, reject, and direct delete are idempotent around a
  request's current state and cannot produce two pending requests.
- Concurrent cancel and approve operations serialize; one commits and the
  other receives a stable stale-request result.
- A target becoming a Server owner before approval blocks deletion at the final
  write, even if the review screen was already open.
- Revocation and deleted state commit together. No response may claim deletion
  while a usable session or Recovery path remains.
- Realtime eviction happens after persistence; reconnecting cannot race back
  into an Account that the database still considers active.
- Unknown, already-decided, and unauthorized targets do not disclose sensitive
  request or Account state beyond the caller's permitted surface.

## Testing and validation

### Clock and External preview preferences

- Auto, 12-hour, and 24-hour formatting across every clock surface.
- Malformed or absent Device storage falls back to Auto/all current Providers
  enabled.
- Preferences remain isolated by Account where specified.
- A disabled Provider creates no frame or external resource before `Show once`.
- One-time grants are message-specific and disappear on room/page lifecycle
  reset.
- Message suppression still removes the preview for every viewer.
- CSP remains limited to the four supported frame origins and contains no Meta
  origin.
- English and Turkish labels and accessible control names remain equivalent.

### Account deletion

- Additive schema migration and restart compatibility.
- Server authorization for request ownership and Installation owner decisions.
- Bot, Installation owner, Server owner, and Deleted account refusal at the
  write boundary.
- Complete active/banned/removed Membership projection with effective
  nicknames, restricted to the Installation owner and the requesting member's
  own status card.
- One pending request, cancellation/rejection cooldown, alert de-duplication,
  and pending badge behavior.
- Atomic revocation of sessions, Device access, Recovery, Invites, access
  claims, and active Memberships.
- Historical messages, replies, Membership rows, and audit records remain
  readable with localized neutral presentation and no former nickname.
- Realtime eviction reaches every Device and every Server without leaking the
  event to unrelated members.
- Concurrent cancel/approve/direct-delete and newly-acquired ownership races.
- Generic signed-out behavior for offline Deleted accounts.

Run focused workspace tests during each slice. Because deletion crosses shared
contracts, server persistence, Socket.IO, and the web client, its completed
integration requires root type-check, root tests, build, `git diff --check`, and
a two-Device browser smoke test.

## Delivery boundaries

The clock preference and External preview privacy are independent web slices.
Account deletion is a cross-package feature and follows them as its own set of
blocking tickets. None of these changes adds a runtime dependency, hosted
service, Meta integration, generic OpenGraph fetch, microphone profile, or
change to the peer-to-peer media architecture.
