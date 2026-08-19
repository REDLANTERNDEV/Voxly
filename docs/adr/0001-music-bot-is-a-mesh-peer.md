# The music bot is a mesh peer, not server-side media

Voxly's media architecture is a full peer-to-peer mesh with no SFU, and `AGENTS.md`
forbids introducing server-side media processing. A music bot still has to get audio
into a voice room, and in a mesh the only thing that can produce sound is a real
WebRTC peer — there is no central point to inject a stream into.

So the bot runs as a **separate `apps/bot` process** that authenticates as an ordinary
member and joins the mesh like any other participant, holding one peer connection per
listener. `apps/server` continues to relay opaque signalling and never touches media,
so the invariant it protects is intact.

## Considered options

- **An SFU** — would let one stream fan out centrally, but replaces the entire media
  architecture to serve one feature.
- **Mixing inside `apps/server`** — puts audio processing in the signalling server,
  which is exactly what the invariant exists to prevent, and couples playback uptime
  to chat uptime.
- **A fabricated participant with no account** — not viable. A member with no socket
  holds no peer connection, so it would render in the sidebar and be permanently silent.

## Consequences

The bot is subject to the same server-authoritative rules as a person: an owner can
mute it, and it is silenced in the AFK room. It also inherits the one-voice-room-per-
account limit, which is why each server gets its own bot account.
