import type { MusicControlAck, VoiceMemberState } from "@voxly/shared";
import { useState } from "react";
import type { Translate } from "../../app/types.js";
import { musicBotIn, musicErrorKey, musicPanelState, offersStop, type MusicCommand } from "../../lib/musicBot.js";

/**
 * Summoning the Music bot, and telling it to stop.
 *
 * Shown only to a member who is in the voice channel, because being in it is
 * what entitles them to summon — the server enforces that, and offering a
 * control that would be refused is a worse answer than not offering it.
 *
 * Whether the bot is playing is read from the room's own snapshot rather than
 * remembered locally. The bot reports it the same way a person's microphone
 * does, so everyone in the channel sees the same thing, including the people
 * who did not press anything.
 */
export function MusicPanel({ members, roomId, connected, onMusicControl, t }: {
  members: VoiceMemberState[];
  roomId: string | null;
  connected: boolean;
  onMusicControl: (roomId: string, command: MusicCommand) => Promise<MusicControlAck>;
  t: Translate;
}) {
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const bot = musicBotIn(members);
  const state = musicPanelState(bot);
  const stopping = offersStop(state);

  const send = async (command: MusicCommand) => {
    if (!roomId) return;
    setPending(true);
    setStatus(command === "play" && !bot ? t("music.summoning") : "");
    const response = await onMusicControl(roomId, command);
    setPending(false);
    setStatus(response.ok ? "" : t(musicErrorKey(response.error)));
  };

  const busy = pending || !connected || !roomId;
  const resting = state === "muted" ? t("music.muted") : state === "playing" ? t("music.playing") : t("music.idle");

  return (
    <section className="music-panel" aria-labelledby="musicPanelTitle">
      <header className="compact-section-head">
        <div>
          <p className="label" id="musicPanelTitle">{t("music.title")}</p>
          <span>{t("music.copy")}</span>
        </div>
      </header>
      <div className="music-panel-controls">
        <button
          className={`btn ${stopping ? "is-active" : "btn-primary"}`}
          type="button"
          disabled={busy}
          aria-pressed={state === "playing"}
          onClick={() => void send(stopping ? "stop" : "play")}
        >
          {stopping ? t("music.stop") : t("music.play")}
        </button>
        {bot ? (
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void send("leave")}>
            {t("music.leave")}
          </button>
        ) : null}
        <span className="muted small" aria-live="polite">
          {status || resting}
        </span>
      </div>
    </section>
  );
}
