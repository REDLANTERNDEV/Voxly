# Voxly

Voxly is a small self-hosted voice and text chat app for a private friend group.
It is intentionally not a public Discord clone: the target is a single VPS,
low memory use, invite-only access, and a simple operational model.

## Scope

Current MVP:

- Invite-only sessions with persistent cookies
- CLI-based first-owner setup and owner-only moderation APIs
- 180-day sessions with rolling renewal before expiry
- Text and voice room lists
- Text chat stored in SQLite
- Socket.IO presence and voice-room membership state
- React/Vite frontend served by the Node app in production
- English and Turkish UI with browser-language detection and a manual switch

Planned after the MVP:

- WebRTC audio signaling
- Camera and screen share
- Self-hosted Coturn fallback
- Connection quality indicators
- More moderation actions

## Architecture

```txt
Cloudflare DNS/WAF
        |
 Existing reverse proxy
  (Nginx or Caddy)
        |
127.0.0.1:VOXLY_HTTP_PORT
        |
Voxly Node app
  - Fastify API
  - Socket.IO
  - React static files
  - SQLite volume
```

When Coturn is enabled, TURN traffic is separate from normal web traffic:

```txt
Browser WebRTC P2P first
        |
fallback only when needed
        |
turn.example.com -> VPS Coturn
```

Use Cloudflare proxy for the web app domain. Create the TURN domain only when
Coturn is enabled, then keep it DNS-only so UDP/TCP traffic reaches Coturn
directly.

## Repository Layout

```txt
apps/server       Fastify, Socket.IO, SQLite persistence
apps/web          React, Vite, TypeScript frontend
packages/shared   Shared event and DTO types
infra             Caddy, Cloudflare, and Coturn examples
docs              Production and security notes
compose.yaml      Docker Compose deployment
Dockerfile        Production app image
```

## Local Development

Install dependencies:

```sh
npm install
```

Run the server:

```sh
npm run build -w @voxly/server
npm run start -w @voxly/server
```

Run the web dev server in another terminal:

```sh
npm run dev -w @voxly/web
```

The Vite dev server proxies API and Socket.IO requests to
`http://127.0.0.1:3000`.

For local first-owner setup, prefer the CLI claim flow:

```sh
DATABASE_PATH=./voxly.sqlite VOXLY_PUBLIC_URL=http://127.0.0.1:3000 npm run owner:create -w @voxly/server -- --nickname "Red"
```

## Docker Deployment

The Compose setup is built for a small VPS:

- The app container runs as a non-root user.
- The app publishes only to `127.0.0.1`.
- SQLite is stored in the `voxly_data` volume.
- The app service uses a Docker bridge network.
- Coturn is optional and uses host networking through the `turn` profile.

Build and start the app:

```sh
docker compose up -d --build app
```

Create the first owner from the server shell:

```sh
docker compose exec app npm run owner:create -w @voxly/server -- --nickname "Red"
```

Open the printed one-use claim URL to receive the owner session cookie.
After that, normal owner access uses the persistent browser session. If the
session is lost, the cookie is cleared, or a new owner device needs access, use:

```sh
docker compose exec app npm run owner:claim -w @voxly/server
```

Start optional Coturn fallback:

```sh
docker compose --profile turn up -d coturn
```

Check status:

```sh
docker compose ps
docker compose logs -f app
```

Recommended reverse-proxy target:

```txt
reverse_proxy 127.0.0.1:3000
```

## Environment

Copy the example environment file and edit it locally:

```sh
cp .env.example .env
```

Docker Compose reads `.env` from the repository root. Keep `.env` private and
do not commit it.

```env
ENABLE_HTTP_OWNER_BOOTSTRAP=false
VOXLY_PUBLIC_URL=https://voxly.example.com
# COOKIE_SECURE=true
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
VOXLY_HTTP_PORT=3000
VOXLY_APP_MEMORY_LIMIT=384m
VOXLY_APP_MEMORY_RESERVATION=160m

TURN_REALM=
TURN_STATIC_AUTH_SECRET=
TURN_EXTERNAL_IP=
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
VOXLY_TURN_MEMORY_LIMIT=128m
VOXLY_TURN_MEMORY_RESERVATION=32m
```

The Node process also supports these runtime values, which Compose already
sets for production:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DATABASE_PATH=/data/voxly.sqlite
WEB_DIST_PATH=/app/apps/web/dist
```

`OWNER_BOOTSTRAP_TOKEN` is only for explicitly enabled local/dev HTTP
bootstrap. Production owner setup should use the CLI claim flow.

`COOKIE_SECURE` is optional. Leave it unset for automatic behavior based on
`VOXLY_PUBLIC_URL`; set it only when a proxy or local test setup needs an
explicit override.

## Cloudflare Notes

Recommended DNS:

- `voxly.example.com`: proxied, points to the existing reverse proxy on the VPS
- Create `turn.example.com` as DNS-only only when Coturn is actually enabled

Cloudflare can be used for DNS, TLS edge, WAF rules, coarse rate limiting, and
Turnstile. It is not application authorization; backend session checks remain
the security boundary.

## Security Boundaries

- Invite and session tokens are hashed before storage.
- Shell-created owner claims are visible to the running app without an app
  restart because SQLite is opened directly by both processes.
- WebRTC signaling and media are not stored in SQLite.
- Text chat is stored locally in SQLite.
- Frontend controls are convenience only; backend checks own authorization.
- Production Vite is not used. The built frontend is served as static files.
- No analytics, external CDN, hosted TURN, or external auth provider is used.

More detail:

- [Owner setup security](docs/owner-setup-security.md)
- [Existing VPS + Cloudflare deployment](docs/vps-cloudflare-production.md)

## Verification

```sh
npm run typecheck
npm test
npm run build
npm audit --omit=dev
docker compose config
```
