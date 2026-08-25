# Contributing to Voxly

Thank you for helping improve Voxly. This guide covers the shared contribution
workflow; subsystem-specific decisions live in the repository's `AGENTS.md`
files and apply to human and agent-assisted changes alike.

## Before You Start

- Use Node.js 22 or later and npm.
- Read the root [`AGENTS.md`](AGENTS.md).
- Read the nearest scoped guide for the area you will change:
  - [`apps/web/AGENTS.md`](apps/web/AGENTS.md) for React and UI work.
  - [`apps/web/src/lib/AGENTS.md`](apps/web/src/lib/AGENTS.md) for browser media
    and client helpers.
  - [`apps/server/AGENTS.md`](apps/server/AGENTS.md) for HTTP, SQLite, auth, and
    Socket.IO.
  - [`packages/shared/AGENTS.md`](packages/shared/AGENTS.md) for public DTO and
    event contracts.
- Keep a pull request focused on one behavior or closely related set of
  behaviors. Open a separate change for unrelated refactors.

## Set Up the Repository

```sh
npm install
npm run build -w @voxly/server
DATABASE_PATH=./voxly.sqlite VOXLY_PUBLIC_URL=http://127.0.0.1:3000 \
  npm run start -w @voxly/server
```

In another terminal:

```sh
npm run dev -w @voxly/web
```

The Vite development server proxies API and Socket.IO requests to the local
server. Follow `README.md` to create the first owner when testing a fresh local
database.

Never commit `.env` files, SQLite databases, raw tokens, TURN secrets, private
keys, or generated build directories.

## Make a Change

1. Reproduce or describe the current behavior before editing it.
2. Locate the server, web, and shared boundaries affected by the change.
3. Add or update focused regression tests for observable behavior.
4. Keep English and Turkish copy, accessibility, and permission checks aligned.
5. Run the narrowest relevant tests while iterating.
6. Run the required workspace or root verification before opening a pull
   request.

Follow the existing strict TypeScript and ESM style. The repository does not
currently enforce a formatter or linter, so match surrounding code and use
`git diff --check` to catch whitespace errors.

Avoid adding dependencies for behavior that can be expressed clearly with the
platform or a small local helper. If a dependency is necessary, explain why its
correctness or maintenance benefit outweighs its long-term cost and commit the
updated lockfile.

## Verification

From the repository root:

```sh
npm run typecheck
npm test
npm run build
git diff --check
```

For focused iteration:

```sh
npm run test -w @voxly/shared
npm run test -w @voxly/server
npm run test -w @voxly/web
npm run typecheck -w @voxly/shared
npm run typecheck -w @voxly/server
npm run typecheck -w @voxly/web
```

Use the full root suite for shared contracts, cross-package behavior, or changes
that affect release output. Documentation-only changes need link and command
review plus `git diff --check`; they do not require rebuilding unchanged
application code.

For deployment changes, also validate the applicable configuration:

```sh
docker compose config --quiet
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
```

The Music bot service is behind the `music` profile, and Compose renders a
profiled service only when its profile is enabled. A change that touches it has
to ask for it:

```sh
docker compose --profile music config --quiet
```

The realtime server tests open a loopback listener. A restricted sandbox may
need permission to bind `127.0.0.1`.

## User Experience Expectations

- Keep English and Turkish interactions behaviorally equivalent.
- Preserve keyboard, touch, screen-reader, focus, and reduced-motion support.
- Do not expose owner-only operations to members.
- For media work, test safe fallback and cleanup behavior in addition to the
  successful path.
- For UI layout or interaction work, perform a focused browser check at desktop
  and narrow widths when possible.
- Update public operator documentation when configuration, deployment, backup,
  recovery, or TURN behavior changes.

## Commits and Pull Requests

Use small, reviewable commits with concise imperative subjects, for example:

```text
Preserve muted state during reconnect
Document TURN certificate rotation
```

A pull request should explain:

- What changed and why.
- Which behavior or invariant is affected.
- Tests and manual checks performed.
- Any migration, configuration, compatibility, security, or rollout impact.

Keep generated files, credentials, personal data, logs containing tokens, and
unrelated working-tree changes out of the pull request. Before submission,
inspect `git status --short` and the complete diff.
