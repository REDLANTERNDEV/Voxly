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

### The Music bot account

Every server carries a Music bot account, created with the server and added to
existing servers the next time the application starts. It appears in the member
list marked as a Bot, and it is offline until a Music bot process is running.

The bot process cannot log in the way a person does, so it authenticates with a
credential you generate and give to both processes:

```sh
openssl rand -base64 36
```

```dotenv
VOXLY_BOT_TOKEN=<the generated value>
```

Leave `VOXLY_BOT_TOKEN` blank to run without the bot. The accounts still appear
in the member list, offline, and the application registers no credential
endpoint at all.

Treat this value like the TURN secret: whoever holds it can act as every Music
bot on the deployment. It grants no owner powers and no access to any server the
bot is not already a member of. Rotate it by changing it in both places and
restarting them; sessions the bot already holds expire within the hour.

### Running the Music bot

The bot plays audio from YouTube. It fetches with **yt-dlp** and encodes with
**ffmpeg**, and both must be installed wherever the bot runs — they are ordinary
programs rather than npm packages, so `npm install` does not bring them. The
ffmpeg build needs `libopus`; one without it cannot encode anything. No API key
is required or used, by the bot or by you.

The Music bot process is not yet part of the Compose deployment. To run it
alongside the application today, give it the same token and the address of the
application:

```sh
VOXLY_SERVER_URL=https://chat.example.com \
VOXLY_BOT_TOKEN=<the same value> \
  npm run start -w @voxly/bot
```

Three further values are optional:

| Variable | Default | What it is for |
| --- | --- | --- |
| `VOXLY_YTDLP_PATH` | `yt-dlp` | Where yt-dlp is, if it is not on `PATH` |
| `VOXLY_FFMPEG_PATH` | `ffmpeg` | Where ffmpeg is, if it is not on `PATH` |
| `VOXLY_YTDLP_CLIENT` | yt-dlp's own choice | Which upstream client yt-dlp presents itself as |

Once it is running, anyone in a voice channel gets a Music panel there. Paste a
YouTube link and the bot joins that channel and plays it for everyone in it; its
row lights while it plays, the same as anyone speaking. Only someone already in
the channel can ask for music, and the bot will not play in the AFK channel. A
link it cannot play — a playlist, a live stream, a video that is private,
deleted or blocked where your server is — says so rather than doing nothing.

**Expect this to break occasionally.** YouTube changes how it serves video
several times a year, and yt-dlp stops working until it catches up. Fixes
usually arrive in its nightly releases within days, so the repair is to update
yt-dlp and restart the bot. `VOXLY_YTDLP_CLIENT` sometimes works around it
sooner — yt-dlp's own documentation lists the client names it accepts. Nothing
else in Voxly is affected while music is broken: chat, voice and screen sharing
carry on.

There is no account to ban, because the bot never signs in anywhere. The
realistic failure is your server's address being rate-limited, which is
temporary and clears on its own.

The bot connects to each Listener directly, exactly as members connect to each
other, so it needs whatever the rest of your voice does — reachable peers, or
Coturn when they are behind NAT. It reads its TURN credentials from the same
endpoint the browser does. Its bandwidth grows with the number of people
listening, so a channel it plays into costs roughly what one more talkative
member would.

### Optional landing-page analytics

Analytics are off unless you turn them on: a default deployment loads no
third-party script and contacts no analytics host. When configured, the
provider script is loaded only on the public landing page (`/`). Authenticated
routes — which contain server and room IDs — are never reported, and automatic
SPA route tracking is disabled on purpose.

For a self-hosted Umami (or another instance using the same script tag):

```dotenv
ANALYTICS_PROVIDER=umami
ANALYTICS_SCRIPT_URL=https://analytics.example.com/script.js
ANALYTICS_WEBSITE_ID=451f26ee-726c-46f0-9643-2b302bef4a5f
```

For Umami Cloud, use the script URL from its tracking-code panel:

```dotenv
ANALYTICS_PROVIDER=umami
ANALYTICS_SCRIPT_URL=https://cloud.umami.is/script.js
ANALYTICS_WEBSITE_ID=451f26ee-726c-46f0-9643-2b302bef4a5f
```

For Google Analytics 4, only the measurement ID is needed:

```dotenv
ANALYTICS_PROVIDER=google
ANALYTICS_WEBSITE_ID=G-XXXXXXXXXX
```

The application adds the provider's origins to its own Content-Security-Policy,
so no proxy-side header change is required. An incomplete configuration fails at
startup rather than silently disabling tracking.

### Sending events somewhere other than the provider's endpoint

Whichever provider you pick, it fetches a script from one host and posts events
to a second one. The two are the same host only for an ordinary self-hosted
Umami; the defaults for everything above are already known, so most deployments
need nothing here.

Set `ANALYTICS_HOST_URL` when your deployment moved that second host:

```dotenv
# Self-hosted Umami whose COLLECT_API_HOST points elsewhere
ANALYTICS_HOST_URL=https://analytics.example.com

# GA4 through a server-side tagging container (gtag transport_url)
ANALYTICS_HOST_URL=https://gtm.example.com
```

Getting this one wrong is quiet rather than loud: the script loads normally and
the browser refuses each event it tries to send. If a configured provider
records nothing, open the landing page and look for a `Content-Security-Policy`
violation in the browser console naming a host that is not in `connect-src` —
that host is the value to put here.

Note what is deliberately *not* counted. Only the public landing page (`/`) is
reported, and only for visitors who are not signed in. Authenticated routes
carry server and room IDs, so they are never sent, and no `/invite` or in-app
navigation appears in your dashboard. A working setup still shows far fewer
page views than total traffic.

## 4. Start the application

```sh
docker compose config --quiet
docker compose up -d --build app
docker compose ps
docker compose logs --tail=100 app
```

The host listener is `127.0.0.1:3000` by default. It is intentionally not
reachable directly from the internet.

Confirm the container is serving before putting a proxy in front of it:

```sh
curl -fsS http://127.0.0.1:3000/api/health
```

`GET /api/health` is unauthenticated and verifies that the process can still
reach SQLite. It is what the container healthcheck probes, and it is the right
target for an external uptime monitor or a load balancer.

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

Keep the `X-Forwarded-For` header in place. Voxly rate limits by client IP, and
without that header every request appears to come from the proxy, so one
abusive client would consume the limit for everyone. If you ever expose the
application port directly to the internet instead, set `TRUST_PROXY=false` so a
forged header cannot be used to evade those limits.

Do not add security headers in the proxy. Voxly sets its own CSP, HSTS,
`X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy` so that every
hosting method has an identical policy; proxy-level overrides silently diverge
from the tested one.

### Caddy

Copy [`infra/Caddyfile.example`](../infra/Caddyfile.example), replace the
hostname, and reload Caddy. Caddy obtains and renews the web certificate
automatically when DNS and ports 80/443 are reachable.

### Container-managed proxy

The Nginx and Caddy instructions above assume the proxy is installed on the host
itself, which is why `compose.yaml` publishes the application on
`127.0.0.1:3000`.

Some deployments instead run the HTTPS proxy as a container managed outside this
project — a PaaS such as Dokploy, Coolify, or CapRover, or a hand-run Traefik.
A containerized proxy cannot reach a loopback-published host port, so the
application has to join the proxy's own Docker network. Use
[`compose.external-proxy.yaml`](../compose.external-proxy.yaml) for that case.
It is identical to `compose.yaml` except that it drops the published host port
and attaches to an existing external network:

```sh
PROXY_NETWORK=dokploy-network \
VOXLY_PUBLIC_URL=https://chat.example.com \
  docker compose -f compose.external-proxy.yaml up -d --build
```

`PROXY_NETWORK` defaults to `dokploy-network`; set it to `coolify` or whatever
your platform calls its shared network. The network must already exist —
Compose will not create it.

With a PaaS, point the service at this repository, set the compose path to
`compose.external-proxy.yaml`, and let the platform assign the domain. The
platform terminates TLS and issues certificates, so no Certbot step is needed
for the web application. `VOXLY_PUBLIC_URL` is mandatory in this file — it is
what makes session cookies `Secure`, and there is no `.env` file to fall back
on.

Everything else — the security hardening, memory limits, healthcheck, and data
volume — is the same as `compose.yaml`.

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
member to one selected server. The owner independently chooses an expiry of 30
minutes, 1/6/12 hours, 1/7/30 days, or no expiry, and a capacity of
1/5/10/25/50/100 uses or no usage limit. Each account consumes a link at most
once, and capacity is claimed atomically.

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
curl -i http://127.0.0.1:3000/api/health
sudo nginx -t
```

`GET /api/health` returns `200` with `{"status":"ok"}` when the app is reachable
and can read its database. A connection refusal means the container or
configured host port is unavailable.

### Presence or voice state does not update

Confirm the reverse proxy forwards WebSocket upgrade headers and that no CDN
rule disables WebSockets for `/socket.io/`.

### Cookies do not persist

Set `VOXLY_PUBLIC_URL` to the exact public HTTPS origin and do not mix HTTP and
HTTPS URLs. Check the reverse proxy's forwarded protocol headers.

### Voice works only on the same network

Deploy Coturn and perform the relay checks in [docs/turn.md](turn.md). This is
normally a NAT/firewall issue rather than an Nginx issue.
