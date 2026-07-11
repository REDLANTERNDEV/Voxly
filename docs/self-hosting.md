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

## 7. Recover owner and member access

Voxly does not store recoverable passwords or raw session tokens. Browser
sessions last 180 days and are automatically extended when an active session
enters its final 30 days. Clearing browser storage, explicitly signing out, or
losing a device removes that device's local access; it does not delete the
global user account, server memberships, roles, or message history.

### Owner lost browser access

Do not run `owner:create` again. Create a short-lived, one-use login claim for
the existing owner:

```sh
cd /opt/voxly
docker compose exec app npm run owner:claim -w @voxly/server -- --nickname "Owner"
```

Open the printed URL on the browser that should receive the new owner session.
The claim expires after 10 minutes by default and cannot be reused. A different
lifetime can be requested when necessary:

```sh
docker compose exec app npm run owner:claim -w @voxly/server -- \
  --nickname "Owner" --expires-in-minutes 30
```

Anyone holding this URL can become the existing owner, so transfer it through a
trusted channel and do not paste it into logs, tickets, or public chat.

### Member lost browser access

The owner should open **Owner controls → Users**, find the existing member, and
select **Access link**. Send the generated URL to that member through a trusted
channel. It expires after 15 minutes, works once, and creates a new browser
session for the same global account. It does not create a duplicate user and it
preserves every existing server membership.

The 15-minute lifetime applies only to this account-recovery access link. It
does not change server invite expiry. Server invites are used to add or re-add a
member to one selected server, and the owner can choose their lifetime up to 72
hours in the invite form.

An access link is not an invitation:

- An active member who only lost their cookie should receive an access link.
- A kicked member must rejoin the intended server with a new server invite.
- A banned member cannot use an access link or invite until an owner unbans them.
- If a link expires or is consumed on the wrong browser, generate a new link;
  the old raw token cannot be recovered from the database.

Verify the person's identity before issuing a recovery link. A recovery link
restores the whole global account, including its memberships in other servers.

## 8. Add reliable TURN connectivity

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
