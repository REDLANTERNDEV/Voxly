# Self-hosting Voxly

This guide deploys Voxly on a Linux server using Docker Compose and an existing
Nginx or Caddy reverse proxy. Commands assume the repository is installed at
`/opt/voxly`; use a different absolute path if preferred.

## 1. Prerequisites

- A Linux server with a public IPv4 address
- Docker Engine with the Compose plugin
- Git
- A DNS hostname such as `chat.example.com`
- Nginx, Caddy, or another HTTPS reverse proxy
- Inbound TCP ports 80 and 443 open for the web application

The server should have at least 1 GB of memory. The defaults in `.env.example`
are conservative enough for a small private deployment.

Coturn has separate `VOXLY_TURN_MEMORY_LIMIT` and
`VOXLY_TURN_MEMORY_RESERVATION` controls. The TURN guide explains sizing and
the safe certificate export required when ACME keys are root-only.

## 2. DNS

Create an `A` record for the application hostname:

```text
chat.example.com → 203.0.113.10
```

Create an `AAAA` record only when IPv6 is configured on the server and in its
firewall. Wait for DNS to resolve before requesting a TLS certificate.

## 3. Install and configure Voxly

```sh
sudo git clone https://github.com/REDLANTERNDEV/Voxly.git /opt/voxly
sudo chown -R "$USER":"$USER" /opt/voxly
cd /opt/voxly
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
VOXLY_PUBLIC_URL=https://chat.example.com
VOXLY_HTTP_PORT=3000
ENABLE_HTTP_OWNER_BOOTSTRAP=false
```

Keep `.env` readable only by trusted operators. Do not configure
`OWNER_BOOTSTRAP_TOKEN` in production; create owner access from the CLI.

## 4. Start the application

```sh
docker compose config --quiet
docker compose up -d --build app
docker compose ps
docker compose logs --tail=100 app
```

The host listener is `127.0.0.1:3000` by default. It is intentionally not
reachable directly from the internet.

## 5. Configure a reverse proxy

### Nginx

Copy [`infra/nginx.example.conf`](../infra/nginx.example.conf), replace
`chat.example.com`, enable the site, and request a certificate:

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d chat.example.com
```

The example forwards normal HTTP requests and WebSocket upgrades used by
Socket.IO. If Nginx already hosts other applications, add Voxly as a separate
`server` block rather than replacing the global configuration.

### Caddy

Copy [`infra/Caddyfile.example`](../infra/Caddyfile.example), replace the
hostname, and reload Caddy. Caddy obtains and renews the web certificate
automatically when DNS and ports 80/443 are reachable.

## 6. Create the first owner

```sh
cd /opt/voxly
docker compose exec app npm run owner:create -w @voxly/server -- --nickname "Owner"
```

Open the one-use HTTPS link printed by the command. Voxly stores only the token
hash, and the link cannot be displayed again. Generate another claim from the
CLI if it expires or is lost.

## 7. Add reliable TURN connectivity

Voice can connect peer-to-peer without Coturn, but some mobile, corporate, and
carrier networks block direct WebRTC paths. Production operators should follow
[the TURN guide](turn.md) and deploy `compose.turn.yaml`.

Nginx or Caddy does not HTTP-proxy TURN traffic. Browsers connect directly to
Coturn on its dedicated hostname and ports.

## Updates

Read release notes before updating, then back up SQLite and rebuild:

```sh
cd /opt/voxly
docker compose exec app sh -c 'cp /data/voxly.sqlite /data/voxly.sqlite.pre-update'
git pull --ff-only
docker compose up -d --build app
docker compose ps
docker compose logs --tail=100 app
```

When Coturn is enabled, use both Compose files for update and status commands:

```sh
docker compose -f compose.yaml -f compose.turn.yaml up -d --build
```

## Backups and restore

The `voxly_data` Docker volume contains the SQLite database. Create a consistent
backup with SQLite's online backup command when available:

```sh
mkdir -p backups
docker compose exec -T app node -e \
  "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/data/voxly.sqlite'); db.exec(\"vacuum into '/data/voxly-backup.sqlite'\"); db.close()"
docker compose cp app:/data/voxly-backup.sqlite ./backups/voxly-$(date +%F).sqlite
```

Store backups outside the VPS. To restore, stop the application, replace
`/data/voxly.sqlite` inside the volume with a verified backup, and start the
application again. Keep the original database until the restored deployment
has been tested.

## Firewall checklist

For the core application, expose only the reverse proxy and SSH:

- TCP 22, or the server's configured SSH port
- TCP 80 for ACME HTTP validation and redirects
- TCP 443 for HTTPS and secure WebSocket traffic

Do not expose TCP 3000. TURN requires additional ports listed in
[docs/turn.md](turn.md). If the hosting provider has a network firewall, its
rules must match the host firewall.

## Troubleshooting

### The application returns 502

```sh
docker compose ps
docker compose logs --tail=200 app
curl -i http://127.0.0.1:3000/api/me
sudo nginx -t
```

An unauthenticated `/api/me` response may be `401`; that still confirms the app
is reachable. A connection refusal means the container or configured host port
is unavailable.

### Presence or voice state does not update

Confirm the reverse proxy forwards WebSocket upgrade headers and that no CDN
rule disables WebSockets for `/socket.io/`.

### Cookies do not persist

Set `VOXLY_PUBLIC_URL` to the exact public HTTPS origin and do not mix HTTP and
HTTPS URLs. Check the reverse proxy's forwarded protocol headers.

### Voice works only on the same network

Deploy Coturn and perform the relay checks in [docs/turn.md](turn.md). This is
normally a NAT/firewall issue rather than an Nginx issue.
