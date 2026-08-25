# ADR-0012 — The Music bot ships as its own image and its own service

- **Status:** accepted
- **Date:** 2026-08-26
- **Context:** ticket 14, "Deployment"

## Context

Until now the Music bot ran only where somebody started it by hand. The
application had an image and a Compose service; the bot had a `npm run start`
line in the self-hosting guide and two programs the operator was told to install
themselves.

Three things force a decision rather than an obvious extension of what exists.
The bot needs **two external programs** — yt-dlp and ffmpeg — that the
application has no use for. It needs to be **restartable on its own**, because
music breaks on a schedule set by YouTube and chat and voice should not go down
with it (design story 38). And the deployment it joins has a **security posture
that is already established twice**, on `app` and on `coturn`: read-only root,
`no-new-privileges`, a pids limit and memory bounds, all as `${VOXLY_*}` with
defaults (story 39).

The extractor's breakage is the part that shapes everything else.
[ADR-0004](./0004-fetched-audio-path.md) accepted it as a cost rather than a
defect: YouTube changes how it serves video several times a year, yt-dlp fixes
it within days, and the repair is a redeploy. A deployment design that makes
that repair slow or manual makes the accepted cost worse than it was assumed to
be when it was accepted.

## Decision

### 1. Its own image, from a second runtime stage in the same Dockerfile

`deps` and `build` are unchanged and shared; the Dockerfile now ends in two
runtime stages, `runtime` (the application) and `bot`. The `bot` stage is the
only one that installs an extractor and an encoder, and it copies
`apps/bot/dist` where the other copies `apps/server/dist`.

The alternative was **one image carrying both**, selected by the command. It is
cheaper to build and it was rejected anyway: it puts an extractor, an encoder
and a Python runtime inside the container that holds the database and owns the
only published port, for programs that container never runs. It also welds the
two release cadences together — every yt-dlp bump would rebuild and restart
chat and voice, which is the exact thing story 38 asks not to happen.

**A second process inside the application container** — a supervisor, or a
`&` — was rejected for the same reason and one more:
[ADR-0003](./0003-music-bot-service-account-credentials.md) already chose a
credential exchange over trusting loopback precisely so the bot would not depend
on sharing a host. Sharing one now would waste that.

### 2. Its own service, opt-in behind a Compose profile

`bot` is a service in `compose.yaml` and in `compose.external-proxy.yaml`,
carrying the same hardening as `app` and `coturn`, and it is gated behind the
`music` profile. An operator turns it on with `COMPOSE_PROFILES=music` in `.env`
— after which every documented `docker compose` command includes it — or with
`--profile music` for one command.

It is opt-in because **a deployment with `VOXLY_BOT_TOKEN` blank is a supported
deployment**, documented as such: the bot accounts still appear in every member
list, offline, and the application registers no credential endpoint at all. An
always-on service would put a container in front of those operators that exits
on every start with a message about a value they deliberately left empty, and
`restart: unless-stopped` would do it forever.

Requiring the token instead — `${VOXLY_BOT_TOKEN:?...}` — was tried and
rejected on evidence: Compose interpolates the whole file before it filters by
profile, so a required variable inside a profiled service fails
`docker compose config` for every operator, including the ones who never asked
for music.

The bot reaches the application at `http://app:3000` over the internal bridge,
not through the public URL. A round trip out to DNS, a proxy and a certificate,
to arrive where it started, buys nothing and adds three things that can be
down. `VOXLY_SERVER_URL` remains an override for a bot that runs elsewhere.

### 3. yt-dlp is pinned to a release; ffmpeg comes from the distribution

The image installs `yt-dlp==${VOXLY_YTDLP_VERSION}` from PyPI, defaulting to the
release that was current when this was written, and passes the argument through
from Compose so an operator can raise it in `.env` without editing the
repository or waiting for a Voxly release. ffmpeg is installed from Alpine's
repository, fixed by the base image tag rather than by a version string.

The build then asserts both: `yt-dlp --version` runs, and `ffmpeg -encoders`
must contain `libopus`. An ffmpeg without libopus cannot encode anything the
mesh can carry, and without the assertion the symptom is a Track that resolves
and then never plays — a failure that surfaces in front of a room rather than in
front of the person doing the deployment.

Alternatives, in the order they were dismissed:

- **yt-dlp from Alpine's package repository.** One line, no version string to
  guess, and it makes the documented repair a lie: a stable-branch distribution
  package can be weeks behind the nightly that fixed the breakage, so "redeploy
  and it works again" would redeploy the same broken extractor.
- **The standalone `yt-dlp` binary from GitHub releases.** It is a PyInstaller
  build against glibc and does not run on musl, which is what this image is.
- **Letting yt-dlp update itself** (`yt-dlp -U`, or a nightly channel it
  refreshes at runtime). It needs a writable install directory, which means
  relaxing the read-only root for the one container that runs a program parsing
  a hostile source's output. ADR-0004 and the design already ruled this out;
  this ADR is where the *filesystem* consequence is recorded.
- **An exact apk pin for ffmpeg.** Alpine drops superseded versions from its
  repository within weeks, so the pin converts a routine security rebuild into a
  build that cannot resolve its own package.

## Consequences

- **There are two images.** They share every layer up to the runtime split, so
  the second costs one `apk add` and one `pip install` rather than a second
  install and a second build — but the bot image is substantially larger than
  the application's, because ffmpeg and a Python runtime are in it.
- **The repair path is now two-sided.** A Voxly release raises the default pin;
  an operator who cannot wait sets `VOXLY_YTDLP_VERSION` in `.env` and rebuilds
  the one service. Both end in `docker compose up -d --build bot`, and neither
  touches chat or voice.
- **The bot service has no healthcheck**, because it has no surface of its own
  to probe. A check that proved a Node process exists would report a bot that
  has been failing to authenticate for an hour as healthy; what an operator
  reads instead is `docker compose logs bot`, which says which value is missing
  or rejected.
- **`docker compose config` renders the bot only with the profile enabled.**
  Schema validation covers it either way, but a rendering check that means to
  see the service has to ask for it: `docker compose --profile music config`.
- **The credential crosses the bridge network in cleartext HTTP.** That network
  is the same trust domain as the data volume, and the alternative was to
  require a certificate for a hop between two containers on one host. An
  operator who splits the two across hosts should set `VOXLY_SERVER_URL` to the
  public HTTPS origin, which is what that override is for.
- **This pins two binaries into an image for the first time, which is not the
  same as having run them.** No part of the fetch path — yt-dlp, ffmpeg, a real
  query, a Listener hearing anything — has ever executed in this repository's
  CI or on the machine this was written on. What changes here is that it is now
  reproducible enough for one person with a Docker daemon to settle it. The
  operator documentation says which checks still need that person.
