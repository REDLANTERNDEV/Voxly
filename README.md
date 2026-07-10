# Voxly

Voxly is a small, self-hosted voice and text chat app for private friend
groups. It is deliberately not a public Discord replacement: the project is
optimised for one modest VPS, invite-only access, and a straightforward
operational model.

## Features

- Invite-only accounts with persistent browser sessions
- Owner CLI for initial access, recovery claims, and moderation
- Text rooms backed by SQLite
- Live presence and voice-room state over Socket.IO
- WebRTC microphone audio, camera, and screen sharing
- Optional system audio with screen sharing when the browser supports it
- Per-listener member volume controls and per-share temporary volume controls
- English and Turkish interface
- Self-hosted TURN fallback for difficult network paths

## Architecture

```text
Browser
   |
Cloudflare (optional: DNS, TLS edge, WAF, Turnstile)
   |
Reverse proxy (Caddy or Nginx)
   |
127.0.0.1:3000
   |
Voxly Node app
  - Fastify API and Socket.IO
  - React static files
  - SQLite volume
```

WebRTC uses public STUN for peer discovery and tries browser-to-browser media
first. When direct connectivity is not available, a self-hosted Coturn instance
can relay media. TURN uses its own DNS-only hostname and is never placed behind
Cloudflare's normal proxy.

## Repository layout

```text
apps/server       Fastify, Socket.IO, SQLite, and owner CLI
apps/web          React/Vite client
packages/shared   Shared event and DTO types
infra             Optional Caddy, Cloudflare, and Coturn examples
compose.yaml      Docker Compose deployment
Dockerfile        Production image
```

## Local development

Requirements: Node.js 22 or later.

```sh
npm install
npm run build -w @voxly/server
npm run start -w @voxly/server
```

In another terminal, start the Vite client:

```sh
npm run dev -w @voxly/web
```

The development client proxies API and Socket.IO requests to
`http://127.0.0.1:3000`.

Create the first owner in a separate terminal:

```sh
DATABASE_PATH=./voxly.sqlite VOXLY_PUBLIC_URL=http://127.0.0.1:3000 \
  npm run owner:create -w @voxly/server -- --nickname "Red"
```

Open the one-use URL printed by the command to receive the owner session.

## Docker deployment

Copy and update the environment file before deployment:

```sh
cp .env.example .env
```

Build and start the application:

```sh
docker compose up -d --build app
```

Create the first owner from the app container:

```sh
docker compose exec app npm run owner:create -w @voxly/server -- --nickname "Red"
```

The app container listens only on `127.0.0.1`; place a reverse proxy in front
of it. Start the optional TURN relay only when it is needed:

```sh
docker compose --profile turn up -d coturn
```

## Configuration

Docker Compose reads `.env` from the repository root. Keep that file private.
The most important settings are:

| Variable | Purpose |
| --- | --- |
| `VOXLY_PUBLIC_URL` | Public application URL; also determines secure-cookie defaults. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional Cloudflare Turnstile protection for invite acceptance. |
| `TURN_REALM` | TURN hostname when the optional Coturn service is enabled. |
| `TURN_STATIC_AUTH_SECRET` | Long random secret shared by Voxly and Coturn. |
| `TURN_EXTERNAL_IP` | Public IP address used by Coturn on the VPS. |

See [`.env.example`](.env.example) for the complete set of supported values.

## Infrastructure examples

The tracked `infra/` files are examples, not required runtime files:

- [`Caddyfile.example`](infra/Caddyfile.example) configures a TLS reverse proxy
  for the app.
- [`cloudflare.md`](infra/cloudflare.md) explains the Cloudflare and DNS setup.
- [`coturn.example.conf`](infra/coturn.example.conf) configures the optional
  WebRTC relay. Replace all placeholder values before using it.

Use a proxied DNS record for the web app. Create the TURN hostname only when
Coturn is enabled, and keep that hostname DNS-only so UDP and TCP relay traffic
can reach the server directly.

## Security model

- Invite, session, and owner-claim tokens are stored only as hashes.
- Owner recovery happens through a short-lived shell-generated claim.
- Backend authorization remains the boundary for API and Socket.IO actions.
- WebRTC signaling and media are not written to SQLite.
- Voxly uses no analytics, hosted TURN service, external authentication
  provider, or external CDN.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm audit --omit=dev
docker compose config
```
