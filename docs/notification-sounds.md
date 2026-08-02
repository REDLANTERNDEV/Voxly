# Notification sounds

Voxly plays short audio cues for voice-room activity, new messages, and
connection changes. Each listener can turn the cues off, set their level, or
disable a category from the audio settings popover in the sidebar.

## Sound files

The cues are plain files in `apps/web/public/sounds`. The client resolves them
by name, so replacing a file is enough to change a cue; no code change is
needed as long as the name and the format stay the same.

| File | Plays when |
| --- | --- |
| `voice-join.wav` | You join a voice room |
| `voice-leave.wav` | You leave a voice room |
| `voice-peer-join.wav` | Someone else joins the room you are in |
| `voice-peer-leave.wav` | Someone else leaves the room you are in |
| `mute.wav` | You mute your microphone |
| `unmute.wav` | You unmute your microphone |
| `deafen.wav` | You deafen |
| `undeafen.wav` | You undeafen |
| `message.wav` | A message arrives in another room, or while the window is away |
| `connection-lost.wav` | The reconnect overlay opens |
| `connection-restored.wav` | The connection recovers |

The files currently in the repository are synthesized placeholder tones. They
exist so the feature works out of the box and are meant to be replaced.

### Format requirements

- **Container:** RIFF WAV, 16-bit PCM. Every supported browser decodes it, and
  the cues are short enough that compression saves little.
- **Channels:** mono.
- **Sample rate:** 22.05 kHz or 44.1 kHz.
- **Length:** 100–400 ms. Longer cues overlap the next event and feel slow.
- **Level:** peak around −6 dBFS. The client scales cues by the listener's
  notification level, so a normalized file leaves room to turn them up.
- **Silence:** trim leading silence, keep a short fade-out so the cue does not
  click.

Rebuild the web client after replacing a file (`npm run build -w @voxly/web`,
or rebuild the container image) — `public/` is copied into the build output.

## Producing your own cues

All of these are free and let you keep or license the result yourself.

**Synthesizing a cue (recommended for UI sounds).** Short two-note blips are
easier to synthesize than to record.

- [Audacity](https://www.audacityteam.org/) — free and open source. Use
  `Generate → Tone` for each note, `Effect → Fade Out` on the tail, then
  `File → Export → Export as WAV` with "Other uncompressed files", signed
  16-bit PCM. Set the project rate to 22050 Hz in the bottom-left selector.
- [SFXR / jsfxr](https://sfxr.me/) — a browser tool for short UI and game
  blips. Everything it generates is yours; export as WAV.
- [ChipTone](https://sfbgames.itch.io/chiptone) — same idea with more control
  over envelope and timbre.
- [Bfxr](https://www.bfxr.net/) — desktop and web, sounds it produces are free
  to use commercially.

**Recording or editing existing material.**

- [Audacity](https://www.audacityteam.org/) or
  [Ocenaudio](https://www.ocenaudio.com/) for trimming, fading, and
  normalizing.
- `ffmpeg` for batch conversion, for example:
  `ffmpeg -i cue.mp3 -ac 1 -ar 22050 -c:a pcm_s16le cue.wav`

**Free sound libraries.** Check the license on each individual file, not just
the site.

- [freesound.org](https://freesound.org/) — filter by license and prefer
  **CC0**. Attribution licenses require crediting the author somewhere in the
  project.
- [Kenney UI Audio](https://kenney.nl/assets/ui-audio) — CC0, a set built for
  interface cues.
- [Pixabay sound effects](https://pixabay.com/sound-effects/) — free for
  commercial use under the Pixabay content license.
- [OpenGameArt](https://opengameart.org/) — filter to CC0.

Do not copy cues from Discord, Slack, Teams, or any other product. Their sounds
are covered by copyright and, in some cases, trademark; a similar-sounding
original is fine, a copied file is not.

## Behavior notes

- Cues follow the selected audio output device.
- While deafened — by yourself or by an owner — every cue is silent except the
  deafen and undeafen cues themselves.
- Joining a room that already has participants does not announce the people
  already there; only later arrivals and departures play.
- Reconnecting to a voice room after a network interruption is silent, because
  the session was never left.
- Browsers block audio before the first user interaction. A cue that arrives
  before any click or keypress is dropped silently.
