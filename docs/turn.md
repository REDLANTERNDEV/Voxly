# Self-hosting Coturn for Voxly

Coturn is optional for local evaluation but recommended for production. Voxly
tries peer-to-peer WebRTC first and uses TURN only when a direct path cannot be
established.

This guide assumes Voxly is installed at `/opt/voxly`, the web application is
available at `chat.example.com`, and Coturn will use `turn.example.com`.

## Architecture

The web application remains behind Nginx or Caddy:

```text
Browser → HTTPS reverse proxy → 127.0.0.1:3000 → Voxly
```

TURN traffic bypasses the HTTP reverse proxy:

```text
Browser → turn.example.com:3478/5349 → Coturn
Browser ↔ turn.example.com:49160-49200/udp ↔ remote peer
```

Voxly issues temporary credentials from authenticated `GET /api/rtc/config`.
The shared secret remains on the server and is never returned by public
`GET /api/config`.

## 1. DNS

Create a direct `A` record:

```text
turn.example.com → 203.0.113.10
```

Add `AAAA` only when IPv6 is fully configured. When a DNS/CDN provider offers
an HTTP proxy, disable it for the TURN hostname. For Cloudflare this means
**DNS only**.

## 2. Ports and firewalls

| Protocol | Port | Purpose |
| --- | --- | --- |
| UDP | 3478 | STUN and preferred TURN transport |
| TCP | 3478 | TURN fallback when UDP is blocked |
| TCP | 5349 | TURN over TLS |
| UDP | 49160-49200 | Allocated relay media ports |

3478 and 5349 are the standard Coturn listener defaults. The UDP relay range
is a deliberately small Voxly deployment default, not a protocol requirement.
If it is changed, update `.env` and every firewall together.

Example UFW rules:

```sh
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp
sudo ufw status numbered
```

Apply the same rules in the hosting provider's network firewall or security
group. Do not enable a new host firewall over SSH until the SSH port is allowed.

## 3. Obtain a TLS certificate

The included overlay requires a readable certificate for `turn.example.com`.
This enables `turns:` fallback on networks that block normal TURN transports.

### Existing Nginx and Certbot

Create an HTTP-only validation site. It is used for ACME validation, not as a
TURN proxy:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name turn.example.com;

    location / {
        return 404;
    }
}
```

Enable the site using the distribution's normal Nginx layout, then run:

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --nginx -d turn.example.com
sudo certbot renew --dry-run
```

TCP port 80 must be reachable while the HTTP challenge is validated.

### Root-only Certbot files (recommended for Docker)

Certbot normally protects `/etc/letsencrypt` with root-only directory and key
permissions. Docker bind mounts preserve those host permissions, while the
Coturn image runs as an unprivileged user. Mounting `/etc/letsencrypt` directly
can therefore produce this expected failure:

```text
Voxly TURN configuration error: TLS certificate is not readable at /run/turn-certs/live/turn.example.com/fullchain.pem
```

Do not make `privkey.pem` world-readable and do not run Coturn as root. Export
only the two required files into a private directory whose group matches the
Coturn image:

```sh
cd /opt/voxly
sudo ./infra/export-turn-cert.sh turn.example.com /etc/letsencrypt /opt/voxly/secrets/turn
```

The helper discovers the container's numeric group, creates directories with
mode `0750`, and installs both PEM files with mode `0640`. Set:

```dotenv
TURN_CERT_DIR=/opt/voxly/secrets/turn
```

`TURN_CERT_GROUP=<numeric-gid>` can be supplied when Docker is unavailable to
the export script. Obtain the group on another Docker-capable shell with:

```sh
docker run --rm --entrypoint id coturn/coturn:4.14.0-r0 -g
```

### Caddy or another ACME client

The certificate may be obtained by any ACME client. The overlay expects a
certificate root with this structure:

```text
certificate-root/
  live/turn.example.com/fullchain.pem
  live/turn.example.com/privkey.pem
```

Set `TURN_CERT_DIR` to the absolute `certificate-root` path. Private-key files
must not be committed to the repository.

## 4. Configure `.env`

Generate a shared secret:

```sh
openssl rand -base64 48
```

Add the production values to `/opt/voxly/.env`:

```dotenv
TURN_REALM=turn.example.com
TURN_EXTERNAL_IP=203.0.113.10
TURN_STATIC_AUTH_SECRET=replace-with-the-generated-secret
TURN_CERT_DIR=/opt/voxly/secrets/turn
TURN_CREDENTIAL_TTL_SECONDS=86400
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_USER_QUOTA=12
TURN_TOTAL_QUOTA=40
VOXLY_TURN_MEMORY_LIMIT=128m
VOXLY_TURN_MEMORY_RESERVATION=32m
```

`TURN_STATIC_AUTH_SECRET` must contain at least 32 random bytes. The application
and Coturn must use the same value. Rotating it invalidates credentials signed
with the previous value.

The default total quota fits inside the 41-port relay range. Increase the port
range before increasing `TURN_TOTAL_QUOTA`.

`VOXLY_TURN_MEMORY_LIMIT` is the hard container memory ceiling. Docker may kill
Coturn if it exceeds this value. `VOXLY_TURN_MEMORY_RESERVATION` is the soft
reservation used for scheduling and contention; it is not an additional limit.
The defaults target small private rooms. Increase the limit only after observing
actual usage with `docker stats`, and keep the reservation below the limit.

## 5. Validate and deploy

```sh
cd /opt/voxly
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
docker compose -f compose.yaml -f compose.turn.yaml up -d --build
docker compose -f compose.yaml -f compose.turn.yaml ps
docker compose -f compose.yaml -f compose.turn.yaml logs --tail=100 coturn
```

The startup wrapper rejects missing values, short secrets, invalid port ranges,
quota/port mismatches, and unreadable certificate files before Coturn starts.

Deploy only `compose.yaml` when TURN is intentionally disabled, and leave both
`TURN_REALM` and `TURN_STATIC_AUTH_SECRET` empty.

### Coturn under a PaaS or container-managed proxy

When the Voxly web application is deployed through a platform that manages
containers for you (Dokploy, Coolify, CapRover, or similar), Coturn is deployed
as a **separate Compose stack** using the same `compose.turn.yaml` from this
repository. No platform-specific compose file is required.

Do not attach an HTTP domain or ingress route to the Coturn stack. TURN is not
HTTP traffic; it must listen directly on the VPS ports via `network_mode: host`,
so the platform's reverse proxy is not involved at all.

Keep a checkout of this repository on the server for the Coturn compose file
and certificate export helper:

```sh
sudo git clone https://github.com/REDLANTERNDEV/Voxly.git /opt/voxly
sudo chown -R "$USER":"$USER" /opt/voxly
cd /opt/voxly
```

If the repository already exists at `/opt/voxly`, update it instead:

```sh
cd /opt/voxly
git pull --ff-only
```

Create the TURN DNS record at your DNS provider. With Cloudflare, keep the TURN
record in **DNS only** mode. The orange-cloud HTTP proxy does not proxy TURN
traffic.

```text
turn.example.com → 203.0.113.10
```

Open the TURN ports on the VPS and in the hosting provider firewall:

```sh
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp
```

When Cloudflare manages DNS for the domain, the cleanest ACME flow is a
Cloudflare DNS challenge. Create a Cloudflare API token with `Zone / DNS / Edit`
and `Zone / Zone / Read` permissions for the specific zone, then install the
Certbot plugin:

```sh
sudo apt update
sudo apt install certbot python3-certbot-dns-cloudflare
sudo mkdir -p /root/.secrets
sudo nano /root/.secrets/cloudflare.ini
sudo chmod 600 /root/.secrets/cloudflare.ini
```

Store the token in `/root/.secrets/cloudflare.ini`:

```ini
dns_cloudflare_api_token = replace-with-cloudflare-token
```

Request the TURN certificate:

```sh
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d turn.example.com
```

Export the root-only Certbot files into the directory that the Coturn container
can read:

```sh
cd /opt/voxly
sudo ./infra/export-turn-cert.sh turn.example.com /etc/letsencrypt /opt/voxly/secrets/turn
```

Generate the shared TURN secret:

```sh
openssl rand -base64 48
```

Create a new Docker Compose service for Coturn in your platform:

- Repository: this Voxly repository
- Compose path: `compose.turn.yaml`
- Domain: none

Set the Coturn service environment in the platform:

```dotenv
TURN_REALM=turn.example.com
TURN_EXTERNAL_IP=203.0.113.10
TURN_STATIC_AUTH_SECRET=replace-with-generated-secret
TURN_CERT_DIR=/opt/voxly/secrets/turn
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_USER_QUOTA=12
TURN_TOTAL_QUOTA=40
VOXLY_TURN_MEMORY_LIMIT=128m
VOXLY_TURN_MEMORY_RESERVATION=32m
```

Deploy the Coturn service and check its logs. Then add the same realm and
secret to the environment of the Voxly web application service and redeploy it:

```dotenv
TURN_REALM=turn.example.com
TURN_STATIC_AUTH_SECRET=replace-with-the-same-generated-secret
TURN_CREDENTIAL_TTL_SECONDS=86400
```

## 6. Certificate renewal

Coturn must receive the exported certificate and restart after renewal. With
Certbot, create `/etc/letsencrypt/renewal-hooks/deploy/restart-voxly-turn.sh`:

```sh
#!/bin/sh
cd /opt/voxly || exit 1
./infra/export-turn-cert.sh turn.example.com /etc/letsencrypt /opt/voxly/secrets/turn || exit 1
docker compose -f compose.yaml -f compose.turn.yaml restart coturn
```

```sh
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/restart-voxly-turn.sh
sudo certbot renew --dry-run
```

When the Coturn stack is started by a platform rather than by your own
`docker compose` invocation, the compose project name is chosen by the platform,
so the hook has to find the container by label instead. Create the same deploy
hook file with this restart command:

```sh
#!/bin/sh
set -eu
cd /opt/voxly
./infra/export-turn-cert.sh turn.example.com /etc/letsencrypt /opt/voxly/secrets/turn
ids=$(docker ps --filter "label=com.docker.compose.service=coturn" --format "{{.ID}}")
[ -n "$ids" ] || { echo "no running coturn container found" >&2; exit 1; }
docker restart $ids
```

The explicit emptiness check matters: without it the hook exits `0` after
restarting nothing, and the stale certificate is not noticed until TLS fails
weeks later.

Then apply the same hook permissions and dry-run renewal check:

```sh
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/restart-voxly-turn.sh
sudo certbot renew --dry-run
```

## 7. Verify relay connectivity

From a machine outside the VPS network, confirm STUN and TLS listeners:

```sh
turnutils_stunclient turn.example.com -p 3478
openssl s_client -connect turn.example.com:5349 -servername turn.example.com
```

Sign in to Voxly and inspect `GET /api/rtc/config` in browser developer tools.
It should return:

- `stun:turn.example.com:3478`
- TURN over UDP on 3478
- TURN over TCP on 3478
- TURN over TLS/TCP on 5349
- A temporary username formatted as `<expiry>:<user-id>`

Use only the temporary username and credential in a Trickle ICE test. Never
paste `TURN_STATIC_AUTH_SECRET` into a browser or third-party tool. Verify a
`relay` candidate for UDP, TCP, and TLS, then test voice and screen sharing
between two devices on different networks.

## Troubleshooting

### Coturn exits immediately

```sh
docker compose -f compose.yaml -f compose.turn.yaml logs coturn
sudo ls -l /opt/voxly/secrets/turn/live/turn.example.com/
```

Check the realm, certificate path, secret length, external IP, and relay range.

When the log says a certificate is not readable, run the export helper again,
confirm `.env` points `TURN_CERT_DIR` at the export directory, then recreate the
container so the bind mount is refreshed:

```sh
sudo ./infra/export-turn-cert.sh turn.example.com /etc/letsencrypt /opt/voxly/secrets/turn
docker compose -f compose.yaml -f compose.turn.yaml up -d --force-recreate coturn
```

### TLS works but no relay candidate appears

Confirm the UDP relay range is open in both host and provider firewalls. Verify
that `TURN_EXTERNAL_IP` is the server's public address and the TURN DNS record
does not pass through an HTTP proxy.

### UDP fails but TCP/TLS succeeds

This is acceptable as a fallback but usually indicates a firewall or provider
rule blocking UDP 3478 or the relay port range.

## Standalone Coturn

[`infra/coturn.example.conf`](../infra/coturn.example.conf) is provided for
operators who install Coturn outside Docker Compose. The supported repository
deployment path is `compose.turn.yaml`, which also performs startup validation.
