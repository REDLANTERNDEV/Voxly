# ADR-0013 — Route modules register their own routes

- **Status:** accepted
- **Date:** 2026-08-26
- **Context:** ticket 16, and the three extractions behind it

## Context

`apps/server/src/app.ts` had grown to 1,897 lines, most of it one function:
`registerRoutes`, holding forty-four HTTP handlers for servers, rooms, invites,
access claims, messages, membership moderation and the owner panel, followed by
the private helpers each of them reached for. Tickets 16 through 19 break that
apart along the obvious seams — servers and rooms, invites and access claims,
messages, the owner panel — and ticket 16 is the first of them.

Two extractions already happened and settled the easy half of the question.
`members.ts` and `voice.ts` took their domains out of `app.ts`, and `voice.ts`
went further: it registers its own `voice:*` and `rtc:signal` socket handlers
rather than exporting them for the composition root to wire up. `auth/sessions.ts`
(ticket 15) moved a whole subsystem's rules out but left every route behind,
because sessions are decided in one place and asked about from everywhere.

Ticket 16 is the first one that says "alongside their request handlers", and no
module in this server registers an HTTP route today. Whatever shape it takes,
three more modules follow it within the same cleanup, and by the fourth the cost
of changing it is four rewrites rather than one.

The obstacle is not the routes. It is the two things every route group reaches
for that live in the composition root:

- **`audit()`** — 22 call sites, spread across all four of the tickets. A server
  created, a member banned, an invite revoked, a session closed: every one of
  them writes a line.
- **`RealtimeModeration`** — the interface describing what a route may do to live
  state. `registerRealtime` builds it out of `voice.ts` and the connection
  registry, and both of those stay in `app.ts`, because the connection registry
  is the composition.

A module that imported either from `app.ts` would close a cycle, since `app.ts`
has to import the module to register it.

## Decision

### 1. A route group lives with the rules it enforces, and registers itself

`app.ts` hands a module the Fastify instance; the module calls `server.get` and
`server.post` on it. That is what `voice.ts` already does for its socket events,
and the reason is the same: the handler and the rule it enforces are the same
knowledge, and a boundary that keeps them apart makes the rule the second thing
you find.

The alternative — a module exporting a bag of handlers for `app.ts` to mount —
was rejected because it puts the route table back in the composition root in a
less readable form. Every path would appear twice, once where it is registered
and once where it is written, and the two can disagree.

So `servers.ts` owns `POST /api/servers` and its own last-owner-server refusal;
`invites.ts` will own `POST /api/servers/:serverId/invites` and its own capacity
rules; and `app.ts` keeps `/api/health`, `/api/config`, the static web fallback,
the error handler, the Socket.IO server and the connection registry — the things
that are genuinely composition.

### 2. The handshake is a `RouteContext`, and it is narrow on purpose

`http.ts` declares what a route module is handed — the HTTP counterpart of the
plumbing `socket.ts` already holds for socket handlers:

```ts
interface RouteContext {
  fastify: FastifyInstance;
  database: VoxlyDatabase;
  io: VoxlyIoServer;
  realtime: RealtimeModeration;
  secureCookies: boolean;
}
```

Not `CreateVoxlyAppOptions`. The composition root legitimately knows about
`webDistPath`, `logger`, `trustProxy` and `databasePath`; a route group has no
business reading any of them, and handing over the whole bag is how it ends up
doing so. `secureCookies` is there because the session guards need it, and each
later field will earn its place the same way — visibly, in a diff.

The instance is called `fastify` rather than `server`. In this codebase a
server is a Voxly server — the thing routes address by `serverId` — and
`server.post("/api/servers")` inside a module about servers makes the reader
resolve the word twice. `CONTEXT.md` asks for one word per thing; this is that
rule applied to the framework object.

`http.ts` also holds the three rate-limit tiers, which were already shared
across every group that is about to move, and `RealtimeModeration` itself. That
is what breaks the cycle: the interface lives in a leaf both sides may import,
`app.ts` implements it, and route modules consume it. The implementation stays
where the live state is.

### 3. `audit()` becomes a module, not a database helper

The nearest existing home was `db/database.ts`, which already owns the
`audit_events` DDL and its `server_id` backfill. It was rejected: that file is
described as initialization and compatibility migrations, and the audit log is a
product guarantee rather than a storage detail. `apps/server/AGENTS.md` says
audit-relevant rows must not be dropped or reinterpreted as an incidental
cleanup — a rule that wants a file to be written in.

`audit.ts` also records the thing that is easy to lose in a move: the write joins
whatever transaction the caller is already in and never saves on its own.
`DELETE /api/servers/:serverId` writes its audit line inside the same
`begin immediate` that deletes the messages, invite uses, invites, access claims,
memberships, rooms and the server row. A helper that committed independently
would be able to record a deletion that rolled back.

### 4. Servers and rooms are one module

A room only exists inside a server, and the two lifecycles are one lifecycle:
creating a server creates its first three rooms and its Music bot; deleting one
deletes every room in it inside a single transaction; the last-room floor and
the last-owner-server refusal are the same rule one level apart. Two modules
would have to share `createServerRoom` through a third, and would separate the
halves of each of those pairs.

`rooms.ts` stays exactly as it is: a leaf owning the row shape and the lookup
that `voice.ts` and `music.ts` also authorize against. The room *routes* could
not go there — they need `io` and the realtime handles, which would buy a cycle
back through `voice.ts` — and the lookup could not come here, for the same
reason in reverse. The split is between what everyone may read and what only the
composition may reach.

## Consequences

- Tickets 17, 18 and 19 have a shape to follow rather than a decision to retake:
  a module under `src/`, a `registerXRoutes(context: RouteContext)`, a sibling
  test file, and `apps/server/AGENTS.md` file descriptions updated.
- `RouteContext` will grow — `invites.ts` needs the Turnstile config, and the
  owner panel needs the bootstrap settings. Each addition is a line in this
  contract that says out loud which route group reads which option.
- `auth/ownerClaims.ts` keeps a private `audit()` of its own, with a different
  signature and no `server_id`. It is now visibly a duplicate rather than an
  unremarkable local helper. Unifying it changes what those rows contain, so it
  is a behaviour change and belongs to its own ticket, not to a move.
- `app.ts` shrinks toward being only composition. It is not there yet: after
  ticket 16 it still holds invites, messages, membership moderation and the owner
  panel, which is what the remaining three tickets are.
- The route table is no longer readable in one file. `test/servers.test.ts`
  asserts the exact set of paths its module registers, so a route drifting into
  the wrong group during the next three extractions fails a test instead of
  going unnoticed.

## What is not settled here

**Whether `registerRealtime` and the connection registry should also leave
`app.ts`** is a bigger question than this cleanup. The presence registry is
genuinely shared between the socket lifecycle and four route groups, and moving
it would mean deciding who owns online state — not merely where a function
lives. None of tickets 16 through 19 requires it.

**Whether `RouteContext` should become a Fastify plugin encapsulation** — one
`server.register` per group, with its own scope and hooks — was not evaluated.
It would buy per-group hooks and cost a layer of indirection that nothing here
needs yet. A group that later wants its own `preHandler` is the signal to look
at it again.
