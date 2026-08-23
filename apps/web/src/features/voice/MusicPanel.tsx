import type { MusicControlAck, MusicTrackSummary, VoiceMemberState } from "@voxly/shared";
import { useState } from "react";
import type { Translate } from "../../app/types.js";
import {
  isSendableLink,
  musicBotIn,
  musicErrorKey,
  musicPanelState,
  offersStop,
  trackAddedMessage,
  type MusicCommand
} from "../../lib/musicBot.js";

/**
 * Pasting a link, and telling the bot what to do with what is playing.
 *
 * Shown only to a member who is in the voice channel, because being in it is
 * what entitles them to ask — the server enforces that, and offering a control
 * that would be refused is a worse answer than not offering it.
 *
 * Whether the bot is playing is read from the room's own snapshot rather than
 * remembered locally. The bot reports it the same way a person's microphone
 * does, so everyone in the channel sees the same thing, including the people
 * who did not press anything.
 *
 * The transport controls appear only once a bot is here. Before that there is
 * nothing to stop and nothing to resume, and a Play button that did nothing
 * would be indistinguishable from one that was broken.
 */
export function MusicPanel({ members, roomId, connected, onMusicControl, t }: {
  members: VoiceMemberState[];
  roomId: string | null;
  connected: boolean;
  onMusicControl: (roomId: string, command: MusicCommand) => Promise<MusicControlAck>;
  t: Translate;
}) {
  const [link, setLink] = useState("");
  const [refusal, setRefusal] = useState("");
  const [track, setTrack] = useState<MusicTrackSummary | null>(null);
  const [pending, setPending] = useState(false);
  const bot = musicBotIn(members);
  const state = musicPanelState(bot);
  const stopping = offersStop(state);

  const send = async (command: MusicCommand) => {
    if (!roomId) return;
    setPending(true);
    setRefusal("");
    const response = await onMusicControl(roomId, command);
    setPending(false);
    if (!response.ok) {
      setRefusal(t(musicErrorKey(response.error)));
      return;
    }
    // The link is cleared only once it was accepted, so a refused paste is
    // still there to be corrected rather than retyped from memory.
    if (command.kind === "add") setLink("");
    if (response.track) setTrack(response.track);
  };

  const busy = pending || !connected || !roomId;
  const resting = state === "muted" ? t("music.muted") : state === "playing" ? t("music.playing") : t("music.idle");
  /**
   * One line, and the live state has the last word on it.
   *
   * The Track's name is remembered from the acknowledgement, which is the only
   * place the browser learns it until ticket 08 broadcasts the Queue — so it is
   * shown only while the room still says the bot is playing. Left to persist,
   * it would still read "Playing Nocturne" beside a button offering to start
   * something, which is a state nobody is in.
   */
  const message = pending
    ? t("music.summoning")
    : refusal || (state === "playing" && track ? trackAddedMessage(track, t) : resting);

  return (
    <section className="music-panel" aria-labelledby="musicPanelTitle">
      <header className="compact-section-head">
        <div>
          <p className="label" id="musicPanelTitle">{t("music.title")}</p>
          <span>{t("music.copy")}</span>
        </div>
      </header>
      <form
        className="music-panel-link"
        onSubmit={(event) => {
          event.preventDefault();
          if (isSendableLink(link)) void send({ kind: "add", url: link.trim() });
        }}
      >
        <input
          aria-label={t("music.linkLabel")}
          autoComplete="off"
          disabled={busy}
          inputMode="url"
          name="musicLink"
          onChange={(event) => setLink(event.target.value)}
          placeholder={t("music.linkPlaceholder")}
          type="text"
          value={link}
        />
        <button className="btn btn-primary" disabled={busy || !isSendableLink(link)} type="submit">
          {t("music.add")}
        </button>
      </form>
      <div className="music-panel-controls">
        {bot ? (
          <>
            <button
              className={`btn ${stopping ? "is-active" : ""}`}
              type="button"
              disabled={busy}
              aria-pressed={state === "playing"}
              onClick={() => void send({ kind: stopping ? "stop" : "play" })}
            >
              {stopping ? t("music.stop") : t("music.play")}
            </button>
            <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void send({ kind: "leave" })}>
              {t("music.leave")}
            </button>
          </>
        ) : null}
        <span className="muted small" aria-live="polite">
          {message}
        </span>
      </div>
    </section>
  );
}
