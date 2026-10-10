# Chat interactions

Members can insert local Unicode emojis, react to messages, and select person
or collective Mentions. Server owners maintain shared Pinned messages and can
remove an entire reaction group or all reactions without selecting individual
members. Links retain the browser's native context menu.

## Identity and persistence

A Membership's Mention code distinguishes duplicate nicknames without adding
another editable username. It is assigned once, unique within its Server, and
survives nickname changes and reactivation. Person Mentions reference identity;
generated labels are resolved on read, including neutral Deleted account labels.
They carry UTF-16 ranges alongside plain text, so links and authored text retain
their existing rendering and no HTML parser is introduced.

Draft edits use the actual textarea replacement range, including matching text
inserted beside an existing label. Identity events also update active composers,
editors, reply targets and pin snapshots while preserving authored text and
selection. Only an explicit deletion event creates a tombstone; a missing
directory entry may be a removed Membership instead. New drafts drop a deleted
person's target when sent, while edits retain existing deleted occurrences.
Serial outbox deliveries resolve identity facts at dispatch time, and delayed
history responses cannot restore names superseded by scoped identity events.

Collective Mention recipients are captured when the label is introduced.
Retaining an existing label during an edit retains its recipients; adding a
new label captures current recipients. `@here` therefore never changes its
historical meaning when someone connects later. Mention highlighting follows
these recipients, while notification and mute behavior stays unchanged.

Message reactions share a ceiling of eight **different emoji groups** per
message. Joining an existing group does not consume another slot. Admission is
transactional, own membership is idempotent, and removing the last member frees
the group's slot. Versioned snapshots prevent a delayed response from restoring
reactions that the owner already cleared. The catalogue is bundled locally.

## Historical context

Pinned messages are fetched independently of recent history. Opening an old
destination loads its bounded context window while keeping new arrivals in the
latest history. Context and pin responses have no read watermark; only loading
and viewing the latest history resumes the ordinary read-cursor path.

## Validation

Server and web tests cover identity, range rebasing, tombstones, frozen targets,
shared reaction capacity, moderation, old context and persistence. The reusable
browser check runs against a disposable in-memory database and real built UI:

```sh
npm run build
npm run test:chat:browser
```

Install Playwright Chromium with `npx playwright install chromium` if it is not
available. Alternatively set `CHAT_BROWSER_CHANNEL=chrome` for installed Chrome.
The check measures desktop/phone reaction geometry, checks native link events,
and exercises Mentions, owner moderation, realtime and historical read cursors.
Its phone screenshot is written to `voxly-chat-phone.png` in the OS temporary
directory, or to the path configured by `CHAT_BROWSER_OUTPUT`.
