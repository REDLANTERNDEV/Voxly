# Spike — can a headless peer be heard?

Throwaway. Not a workspace, not in the root `package.json`, not for merging.
It exists to answer one question before [ticket 06](../../.scratch/music-bot/issues/06-bot-joins-voice-and-plays-audio.md)
is built on top of it: **can a Node process join a Voxly voice room as an
ordinary member and be heard by people in browsers?**

The answer is yes. What that cost, and what it taught us, is in
[FINDINGS.md](./FINDINGS.md). Read that first; this file is how to re-run it.

Two of the links from here need a word of warning. The ADRs and the design doc
are not committed yet, so those resolve once they are. The ticket link points
into `.scratch/`, which is ignored on purpose — it only ever resolves for
whoever has the tickets locally.

## What is here

| File | What it is |
| --- | --- |
| `src/play.ts` | The spike: signs in, joins a voice room, plays the bundled Track to everyone in it |
| `src/listen.ts` | A headless Listener that decodes what arrives and reports the level |
| `src/prove.ts` | One command: boots a throwaway Voxly, runs the bot and two Listeners, checks both heard it |
| `src/mesh.ts` | The negotiation — deliberately the browser client's rules |
| `src/audio.ts` | Ogg Opus in, RTP frames out. The only part with real tests |
| `src/player.ts` | One encoded Track, one output per Listener |
| `src/ear.ts` | Decodes received Opus and measures it, so silence cannot pass for success |
| `assets/chime.opus` | The Track. Synthesised, so nothing here is licensed audio |

```bash
npm install
npm test
```

## The check that needs nobody

Builds a throwaway Voxly, puts the bot in a voice room with two headless
Listeners, and fails unless both of them decoded real audio at the same time.

```bash
npm run build -w @voxly/server
```

```bash
npm run prove
```

It does **not** prove the thing this spike is for. It proves the path is live,
so nobody wastes time on headphones while something obvious is broken.

## The check that needs a person

Point the bot at a Voxly you can also open in a browser. Ask the owner for an
invite; the bot accepts it and becomes an ordinary member.

```bash
VOXLY_URL=http://127.0.0.1:3000 VOXLY_INVITE=<invite token> npm run play
```

Then join the same voice room in a browser, put headphones on, and listen. You
are judging three things: that you hear it at all, that it is *clear* — no
stutter, no metallic edge, no dropouts at the loop point — and that it stays
that way for a couple of minutes. Have a second person join and confirm you both
hear it together.

**Join with your microphone on, and not into the AFK room.** A member who joins
with no microphone track offers no media at all, and roughly half of those
connections deadlock rather than carrying audio — finding 1 in FINDINGS.md. That
is a defect in the client, not in the bot, but until it is fixed a muted
Listener is not a valid test of anything: hearing nothing would tell you about
the bug rather than about the bot. Grant microphone permission, join an ordinary
voice room, and mute yourself afterwards if you want quiet.

The Track is a short phrase with a silent gap before it repeats. The gap is
deliberate: a loop that stalls is obvious, and a phrase you can hum makes a
mangled decode obvious in a way a test tone never is.

| Variable | Meaning |
| --- | --- |
| `VOXLY_URL` | Where Voxly is. Defaults to `http://127.0.0.1:3000` |
| `VOXLY_INVITE` | An invite token. The bot accepts it and becomes a member |
| `VOXLY_SESSION` | Instead of an invite: an existing `voxly_session` cookie value |
| `VOXLY_ROOM` | Voice room name or id. Defaults to the first non-AFK voice room |
| `VOXLY_NICKNAME` | What the bot is called in the member list |
| `VOXLY_RELAY` | `1` to refuse host and reflexive candidates, forcing TURN |
| `VOXLY_TRACE` | `1` to log every offer, answer and candidate |
| `VOXLY_LISTEN_SECONDS` | How long `listen` and `prove` run for. Defaults to 12 and 10 |

`npm run listen` starts a headless Listener against the same server with the
same variables, if you want a second opinion without a second browser.

## Forcing the traffic through TURN

`VOXLY_RELAY=1` makes every peer refuse host and reflexive candidates, so the
run only succeeds if the audio went through TURN.

On a Linux host, or anywhere `--network host` works, coturn can sit beside
Voxly and the browser can reach it too:

```bash
docker run --rm --network host coturn/coturn:4.14.0-r0 -n --listening-port=3478 --realm=$TURN_REALM --use-auth-secret --static-auth-secret=$TURN_STATIC_AUTH_SECRET --min-port=49160 --max-port=49200 --no-tls --no-dtls --fingerprint --log-file=stdout
```

Start Voxly with the same `TURN_REALM` and `TURN_STATIC_AUTH_SECRET` and run
the bot with `VOXLY_RELAY=1`.

**On Docker Desktop for Mac this does not work**, and it is worth knowing why
before losing an afternoon to it: a TURN server behind published ports cannot
relay, because coturn sees every peer arriving from the Docker gateway rather
than from the address the peer advertised, so its permissions never match. Host
networking, which would avoid that, is not reachable from the host on Docker
Desktop. Put every participant on the same Docker network instead:

```bash
docker network create voxly-spike
```

```bash
docker run -d --name turn --network voxly-spike --network-alias turn coturn/coturn:4.14.0-r0 -n --listening-ip=0.0.0.0 --listening-port=3478 --relay-ip=0.0.0.0 --realm=turn --use-auth-secret --static-auth-secret=$TURN_STATIC_AUTH_SECRET --min-port=49160 --max-port=49200 --no-tls --no-dtls --fingerprint --log-file=stdout --verbose
```

```bash
docker run --rm --network voxly-spike -v "$PWD/../..":/repo -w /repo/spike/headless-peer-audio -e VOXLY_RELAY=1 -e TURN_REALM=turn -e TURN_STATIC_AUTH_SECRET=$TURN_STATIC_AUTH_SECRET node:24-alpine node dist/src/prove.js
```

That is how the TURN leg in FINDINGS.md was verified. Every package here is
pure JavaScript, so the host's `node_modules` runs unchanged inside the
container.

Note what that recipe cannot do: a browser on the host is not on that Docker
network, so it cannot take part. Putting a person and a TURN server on the same
footing needs a host where `--network host` works, or a real deployment. Until
then the TURN leg is proven between headless peers only.

## Regenerating the Track

`assets/chime.opus` is synthesised, then encoded to Ogg Opus. Neither generator
is checked in — Voxly is a Node monorepo and `AGENTS.md` discourages tooling
that is not needed to build or test, which is the same call already made for
the notification cues in `apps/web/public/sounds`.

The recipe, if it ever needs regenerating: a Python script using the standard
library's `wave` and `math` writes 48 kHz mono 16-bit PCM — a C major phrase at
0.34 s per note over a held C3, each note built from four sine partials with
per-partial decay `[(1, 1.0, 2.2), (2, 0.34, 5.5), (3, 0.14, 9.0), (4, 0.06,
13.0)]`, a 6 ms attack ramp, notes ringing three slots so the phrase is legato,
and 1.2 s of silence before the loop. Normalised to about −3 dBFS peak. Then a
Node script encodes it with `opusscript` at 96 kbit/s in 20 ms frames with
in-band FEC on, and writes the Ogg pages itself.

macOS `afconvert` claims to write Ogg Opus and does not: `-f Oggf -d opus`
fails with `ExtAudioFileWrite failed ('pck?')`. Do not spend time on it.
