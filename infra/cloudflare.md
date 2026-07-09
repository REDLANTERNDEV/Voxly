# Cloudflare Notes

Voxly can use Cloudflare for the web app, but TURN should stay direct.

Recommended DNS when Coturn is enabled:

- `voxly.example.com`: proxied, points to the VPS reverse proxy.
- `turn.voxly.example.com`: DNS-only, points to Coturn on the VPS.

Do not create the TURN record while Coturn is disabled.

Use Cloudflare for:

- DNS management.
- HTTPS edge for the web app.
- WAF and coarse rate limiting.
- WebSocket proxying for Socket.IO.
- Turnstile on invite/session creation.

Do not treat Cloudflare as application auth. Backend session checks remain the
security boundary for API and Socket.IO access.

Turnstile should be low-frequency:

- Enable it on `POST /api/invites/accept`.
- Avoid putting it on chat, presence, voice room, or WebRTC events.
- Validate the token server-side before creating a session.

TURN traffic:

- Coturn should not sit behind the normal Cloudflare orange-cloud proxy.
- Use DNS-only for `turn.voxly.example.com`.
- Let WebRTC try P2P first; use Coturn only as ICE fallback.
