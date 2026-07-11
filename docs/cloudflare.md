# Optional Cloudflare configuration

Cloudflare is not required to self-host Voxly. When it is used, keep the web
application and TURN DNS records separate:

- `chat.example.com`: may be proxied through Cloudflare.
- `turn.example.com`: must be **DNS only** with the normal Cloudflare proxy
  disabled.

Cloudflare can provide DNS, HTTPS edge termination, WAF rules, coarse rate
limiting, WebSocket proxying, and optional Turnstile protection. It does not
replace Voxly's backend authorization.

Do not apply Turnstile or interactive challenges to Socket.IO, room state,
voice signaling, or WebRTC traffic. If Turnstile is enabled, configure it only
for the low-frequency invite acceptance flow and set both values in `.env`:

```dotenv
TURNSTILE_SITE_KEY=public-site-key
TURNSTILE_SECRET_KEY=private-secret-key
```

Coturn must remain directly reachable because Cloudflare's normal HTTP proxy
does not carry arbitrary STUN/TURN UDP and TCP traffic.
