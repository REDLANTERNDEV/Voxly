# Voxly Contributor Guide for Coding Agents

This file defines repository-wide instructions. Read it before making changes,
then read the nearest nested `AGENTS.md` for the files in scope. A nested file
adds subsystem guidance and takes precedence if its instructions are more
specific.

## Project Overview

Voxly is a small, self-hosted text and WebRTC voice application for private
groups. It uses an npm workspace monorepo and ships as one Node.js application
container with an optional self-hosted Coturn overlay.

The product is intentionally narrow:

- Accounts are invite-only and sessions are browser-based.
- Text, presence, and signaling use Fastify and Socket.IO.
- Voice, camera, and screen media remain peer-to-peer whenever possible.
- SQLite is the only application database.
- English and Turkish are the supported interface languages.
- Deployment must not depend on a hosted chat, media, or TURN provider.

## Instruction Hierarchy

Use the following files together:

| Scope | Instructions |
| --- | --- |
| Entire repository | `AGENTS.md` |
| React client and UI | `apps/web/AGENTS.md` |
| Browser media and client helpers | `apps/web/src/lib/AGENTS.md` |
| Fastify, SQLite, and realtime server | `apps/server/AGENTS.md` |
| Music bot process | `apps/bot/AGENTS.md` |
| Shared contracts and cross-peer rules | `packages/shared/AGENTS.md` |

Do not add feature-session notes under `docs/superpowers/`. That directory is
intentionally ignored. Durable decisions belong in the applicable `AGENTS.md`,
public operator documentation, tests, or a purpose-built design document.

`AGENTS.md` owns how to change the code. `docs/adr/` owns why a hard-to-reverse
design is what it is; where the two overlap, `AGENTS.md` wins on the how and the
ADR wins on the why. Add an ADR when a decision would otherwise be re-litigated
from scratch, and surface a conflict with an existing one rather than quietly
overriding it.

`CONTEXT.md` owns the words. Where it names a term, use that term in code,
comments, copy and commit messages, and avoid the alternatives it lists — the
point is that one thing has one name everywhere, not that the chosen name is the
only defensible one. Propose a change there rather than introducing a synonym.

Decision ownership is intentionally scoped rather than repeated everywhere:

| Decision area | Authoritative guidance |
| --- | --- |
| Remote playback, boost, sinks, autoplay, and cleanup | `apps/web/src/lib/AGENTS.md` — Remote Streams and Audio Output |
| Notification cue triggers, gating, and preferences | `apps/web/src/lib/AGENTS.md` — Notification Sounds |
| Member and stream volume presentation | `apps/web/AGENTS.md` — Member and Owner Surfaces |
| Moderation, access links, and token replacement | `apps/server/AGENTS.md` — Authentication and Membership |
| Access-claim completion and authentication races | `apps/web/AGENTS.md` — Authentication and Navigation |
| Browser startup compatibility gates | `apps/web/AGENTS.md` — Browser Compatibility Gate |
| Channel history, unread state, and member presence | `apps/web/AGENTS.md` — Authentication and Member Surfaces |
| Screen capture and sender quality | `apps/web/src/lib/AGENTS.md` — Screen Sharing |
| Screen-share control appearance | `apps/web/AGENTS.md` — Controls, Icons, and Accessibility |
| LIVE discovery and one-click watch | `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation |
| Viewed-room participant scoping | `apps/web/src/lib/AGENTS.md` — Viewed-Room State |
| Atomic joins and media normalization | Web library, server, and shared Voice sections |
| Which peer offers, glare, and empty offers | `packages/shared/AGENTS.md` — Voice Contract Invariants; `apps/web/src/lib/AGENTS.md` — Peer Negotiation |
| Voice activity privacy and owner voice enforcement | Server Atomic Voice; web Deafen and Remote Streams; shared Voice sections |
| Reconnect retries and deafen restoration | `apps/web/src/lib/AGENTS.md` — Reconnect and Deafen sections |
| Connection RTT and reconnect overlay | `apps/web/AGENTS.md` — Controls, Icons, and Accessibility |
| What the dock signal measures, and voice quality grading | `apps/web/src/lib/AGENTS.md` — Voice Quality Measurement |
| Multi-use invite limits and consumption | Server Authentication; web Member and Owner Surfaces; shared Invite Contracts |
| Chat composition, scrolling, actions, and edits | Web Chat Interaction and server Messages sections |
| Message dates, safe links, rich previews, and preview suppression | Web Chat Interaction; server Messages; shared Contract Rules |
| Owner server context and lifecycle controls | Web Member and Owner Surfaces; server Membership section |
| Owner one-time link masking and reveal behavior | `apps/web/AGENTS.md` — Member and Owner Surfaces |
| Sidebar context menus and popover layering | `apps/web/AGENTS.md` — Context Menus and Layering |
| Sidebar voice status and stage layout | `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation |
| Sidebar channel and participant-count presentation | `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation |
| Breakpoints, what a phone drops, and what it may never drop | `apps/web/AGENTS.md` — Narrow Layout |
| Music bot accounts and how the bot authenticates | `apps/server/AGENTS.md` — The Music Bot; ADR-0003 |
| The bot's place in the voice mesh and what it must self-enforce | ADR-0001; `apps/bot/AGENTS.md` — Voice and Playback |
| The bot's WebRTC library and its encode-once property | ADR-0002; `apps/bot/AGENTS.md` — Voice and Playback |
| Summoning the Music bot and who may control it | `apps/server/AGENTS.md` — The Music Bot; `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation |
| How a pasted link becomes audio, and what happens when the fetch falls behind | ADR-0004; `apps/bot/AGENTS.md` — Sources and Fetching |
| Whether an input is a link or a name, and who decides | ADR-0007; `apps/bot/AGENTS.md` — Sources and Fetching |
| Where a member's search results may travel, and where they may not | ADR-0007; `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation; `packages/shared/AGENTS.md` — Music Contracts |
| The music command vocabulary and how a refusal reaches the member | `packages/shared/AGENTS.md` — Music Contracts |
| How the Queue reaches every member in the room, and who may publish it | ADR-0005; `apps/server/AGENTS.md` — The Music Bot; `packages/shared/AGENTS.md` — Music Contracts |
| What the Queue does when a Track is added, ends, or is paused | `apps/bot/AGENTS.md` — The Queue |
| Pausing, skipping and removing, and what a stale request does | ADR-0006; `apps/bot/AGENTS.md` — The Queue; `packages/shared/AGENTS.md` — Music Contracts |
| Which fact the Music panel's transport controls read | ADR-0006; `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation |
| Where the Set log travels, what writes a line, and where it may not be written down | ADR-0008; `apps/bot/AGENTS.md` — The Queue; `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation; `packages/shared/AGENTS.md` — Music Contracts |
| How long the Music bot waits in an emptied room, and where that wait is held | ADR-0009; `apps/bot/AGENTS.md` — The Queue |
| How an owner's mute reaches media the server cannot see | ADR-0009; `apps/bot/AGENTS.md` — Voice and Playback; `apps/web/AGENTS.md` — LIVE Watch and Voice Presentation |
| Which owner actions a Bot can be the subject of, and why a move is not one | ADR-0010; `apps/server/AGENTS.md` — The Music Bot; `apps/web/AGENTS.md` — Member and Owner Surfaces |
| Where the Music bot runs, where its two binaries come from, and why it is opt-in | ADR-0012; `apps/bot/AGENTS.md` — Deployment; `docs/self-hosting.md` — Running the Music bot |

## Repository Map

```text
apps/server       Fastify, Socket.IO, SQLite, static web serving, owner CLI
apps/web          React 19 and Vite browser client
apps/bot          Music bot process: joins voice rooms as a peer and plays audio
packages/shared   Shared DTOs, typed Socket.IO contracts, cross-peer rules
docs              Public self-hosting and operator documentation
docs/adr          Architecture decision records: why a design is what it is
docs/designs      Feature designs: the problem, the stories, and what was ruled out
CONTEXT.md        The domain glossary: agreed words, and what they are not called
infra             Reverse-proxy and Coturn examples and helper scripts
compose.yaml      Core application deployment, with the Music bot behind a profile
compose.turn.yaml Optional Coturn deployment overlay
```

Keep dependency direction simple: `apps/server`, `apps/web`, and `apps/bot` may
import `@voxly/shared`; `packages/shared` must not import any application, and
the three applications must not import each other. The bot is a client of the
server's public HTTP and Socket.IO surface, exactly like the browser is.

## Development Environment

- Use Node.js 22 or later and npm.
- Install dependencies from the repository root with `npm install`.
- Preserve the checked-in `package-lock.json` whenever dependencies change.
- The codebase uses strict TypeScript, ESM, NodeNext resolution, and `.js`
  import specifiers for TypeScript modules.
- There is no repository formatter or linter. Match the surrounding style and
  use TypeScript and `git diff --check` as objective hygiene checks.
- Do not introduce a runtime dependency when a small local helper is enough.
  Any new dependency must have a concrete maintenance or correctness benefit.

Common commands:

| Purpose | Command |
| --- | --- |
| Run all tests | `npm test` |
| Type-check all workspaces | `npm run typecheck` |
| Build server, web, and bot | `npm run build` |
| Start the web development server | `npm run dev -w @voxly/web` |
| Build the server | `npm run build -w @voxly/server` |
| Start the built server | `npm run start -w @voxly/server` |
| Build the Music bot | `npm run build -w @voxly/bot` |
| Start the built Music bot | `npm run start -w @voxly/bot` |

The local server requires `DATABASE_PATH` and `VOXLY_PUBLIC_URL`; use the
examples in `README.md`. Never commit a local `.env` or SQLite database.

## Architecture and Change Boundaries

- Keep HTTP persistence and authorization in `apps/server`; the browser must
  not infer permissions that the server does not enforce.
- Keep wire DTOs and event signatures in `packages/shared`, along with the few
  pure rules every peer must apply identically for the wire to work at all. A
  contract change is incomplete until both applications and their tests are
  updated.
- Prefer small pure helpers for state transitions, routing decisions, media
  calculations, and parsing. Keep React components focused on orchestration
  and rendering.
- Preserve server scoping for rooms, messages, presence, membership,
  moderation, and realtime events.
- Preserve the current peer-to-peer media architecture. Do not introduce an
  SFU, media recording, or server-side media processing as an incidental
  change. The rule protects a property rather than a topology — the operator's
  server never holds anyone's conversation — so a peer that is a process rather
  than a person is not an exception to it. The Music bot is one; see ADR-0001,
  which also records what that costs, because media the server cannot see is
  media the server cannot moderate.
- Database evolution must be additive and compatible with existing SQLite
  installations unless a separately approved migration says otherwise.
- Keep public operator documentation aligned with changes to environment
  variables, Docker, reverse proxies, TURN, backup, or recovery behavior.

## Product-Wide Invariants

- User-facing copy and accessible labels must remain behaviorally equivalent
  in English and Turkish. Add both translations in the same change.
- Preserve keyboard, touch, reduced-motion, focus-management, and screen-reader
  behavior when changing an interaction.
- Owner-only controls must not become available to ordinary members through
  either UI or API changes.
- Kicked, banned, offline, and active membership states are distinct. Do not
  collapse them for convenience.
- Media state shown to other users must reflect effective live local tracks,
  not merely UI intent or the existence of a `MediaStream` object.
- Self-managed voice state is neutral presentation; owner-enforced mute/deafen
  is persistent, red, locked, and server-authoritative.
- Speaking activity is private to the active voice room. Server membership may
  reveal who is present, but never another room's live speaking state or RTC
  signaling path.
- Invite expiry and usage capacity are independent limits; consuming capacity
  and activating membership is one atomic server operation.
- Third-party analytics are an operator choice and off by default: a deployment
  that configures none must contact no analytics host at all. Reporting stays
  limited to the public landing page, with automatic route tracking disabled,
  because authenticated paths carry server and room IDs. Adding a provider does
  not widen that scope.
- Keep failures recoverable where the current product has a safe fallback;
  avoid converting optional optimizations into hard failures.

## Security Rules

- Never commit secrets, raw invite/access/session/owner-claim tokens, local
  databases, private keys, certificates, or populated environment files.
- Persist authentication and one-time tokens only as hashes. Raw tokens may be
  returned once to the authorized caller but must not be logged or stored.
- Authorize every server-scoped HTTP and Socket.IO operation against an active
  membership. Client-side visibility checks are not authorization.
- Preserve generic token-error responses when a more specific response would
  disclose whether a sensitive token existed, expired, was consumed, or was
  revoked.
- Keep TURN secrets server-side. Browsers receive only short-lived generated
  credentials from the authenticated RTC configuration endpoint.
- The Content-Security-Policy is built in the application layer so every
  deployment path shares one posture. Widen it only for an origin the client
  actually loads, and name origins rather than URLs; a path in a source list
  silently invalidates it.
- A third-party provider is two origins, not one: where its script is fetched
  from, and where its script sends data. Resolve both, and cover both
  directives. A missing `connect-src` origin loads the script and then discards
  everything it reports, which no server-side check can observe.
- Keep the Docker application port loopback-bound by default and retain the
  existing read-only filesystem, resource limits, and no-new-privileges
  controls unless a deployment change explicitly requires otherwise.

## Testing Expectations

Run the narrowest relevant tests while iterating, then verify the affected
workspace. For cross-package or release-sensitive changes, run the root suite.

| Change | Minimum verification |
| --- | --- |
| Shared contract | `npm run typecheck && npm test` |
| Server behavior or schema | `npm run test -w @voxly/server` |
| Web behavior or styling | `npm run test -w @voxly/web` |
| Music bot behavior | `npm run test -w @voxly/bot` |
| Build/deployment path | `npm run build` and applicable Compose config check |
| Documentation only | Link/command review and `git diff --check` |

Socket.IO server tests bind a loopback port. In restricted sandboxes they may
need local-listen permission; an `EPERM` on `127.0.0.1` is an environment
failure, not a product assertion failure.

Tests are part of the behavioral contract. Update or add focused regression
coverage whenever changing authorization, persistence, navigation, media state,
recovery, accessibility, or a documented product invariant.

## Contribution Discipline

- Keep each change focused and avoid unrelated refactors.
- Preserve pre-existing working-tree changes that are outside the task.
- Do not stage, commit, push, or rewrite history unless the user explicitly
  requests it.
- Use concise imperative commit subjects when commits are requested.
- Before handoff, inspect `git status --short`, run `git diff --check`, and
  report exactly which verification commands ran and any environment limits.
- Follow `CONTRIBUTING.md` for the human contributor workflow.
