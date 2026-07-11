# Voxly

Voxly is a small, self-hosted text and WebRTC voice chat application for
private groups. It provides invite-only accounts, server-scoped rooms,
presence, moderation, camera and screen sharing without depending on a hosted
chat or TURN provider.

## Features

- Invite-only accounts and persistent browser sessions
- Text and voice rooms with live Socket.IO presence
- Microphone, camera, screen sharing, and optional screen audio
- Owner CLI for initial access and recovery
- SQLite storage with a single Node.js application container
- Optional self-hosted Coturn fallback for restrictive networks
- English and Turkish interface

## Requirements

For local development:

- Node.js 22 or later
- npm

For self-hosting:

- A Linux server with Docker Engine and Docker Compose
- A domain name and an HTTPS reverse proxy such as Nginx or Caddy
- Optional: a second DNS hostname for Coturn

## Local development

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

Create the first owner and open the one-use URL printed by the command:

```sh
DATABASE_PATH=./voxly.sqlite VOXLY_PUBLIC_URL=http://127.0.0.1:3000 \
  npm run owner:create -w @voxly/server -- --nickname "Owner"
```

## Docker quick start

```sh
cp .env.example .env
docker compose up -d --build app
docker compose exec app npm run owner:create -w @voxly/server -- --nickname "Owner"
```

The application binds to `127.0.0.1:3000` by default. Put Nginx, Caddy, or an
equivalent HTTPS reverse proxy in front of it before exposing it publicly.

For a complete production walkthrough, including DNS, TLS, Nginx/Caddy,
backups, updates, and troubleshooting, see
[Self-hosting Voxly](docs/self-hosting.md).

For reliable WebRTC connections across mobile, corporate, and carrier-grade
NAT networks, deploy the optional TURN overlay described in
[Self-hosting Coturn](docs/turn.md).

## Repository layout

```text
apps/server       Fastify, Socket.IO, SQLite, and owner CLI
apps/web          React and Vite client
packages/shared   Shared event and DTO types
docs              Operator and deployment documentation
infra             Runnable reverse-proxy and Coturn examples
compose.yaml      Core application deployment
compose.turn.yaml Optional Coturn overlay
Dockerfile        Production application image
```

## Configuration

Docker Compose reads `.env` from the repository root. Start from
[`.env.example`](.env.example) and never commit the resulting `.env` file.

| Variable | Purpose |
| --- | --- |
| `VOXLY_PUBLIC_URL` | Public HTTPS URL used for links and secure-cookie defaults |
| `VOXLY_HTTP_PORT` | Host loopback port used by the reverse proxy |
| `DATABASE_PATH` | SQLite path when running without Docker |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional Cloudflare Turnstile protection |
| `TURN_REALM` / `TURN_STATIC_AUTH_SECRET` | Enable authenticated self-hosted TURN |

The complete TURN variable reference is in [docs/turn.md](docs/turn.md).

## Security model

- Invite, session, access, and owner-claim tokens are stored as hashes.
- TURN credentials are short-lived and available only from an authenticated
  endpoint; the shared TURN secret is never returned to browsers.
- The application port is loopback-only in Docker Compose.
- WebRTC media is sent peer-to-peer when possible and is not stored by Voxly.
- Coturn is optional, separately deployed, quota-limited, and has no public
  administration interface.

## Documentation

- [Self-hosting guide](docs/self-hosting.md)
- [Coturn/TURN guide](docs/turn.md)
- [Optional Cloudflare notes](docs/cloudflare.md)
- [Nginx example](infra/nginx.example.conf)
- [Caddy example](infra/Caddyfile.example)
- [Standalone Coturn example](infra/coturn.example.conf)

## Verification

```sh
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

When TURN is enabled:

```sh
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
```
