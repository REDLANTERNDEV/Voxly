import type { MusicControlAck, MusicQueueState, VoiceMemberState } from "@voxly/shared";
import { useState } from "react";
import type { Translate } from "../../app/types.js";
import {
  isSendableLink,
  musicBotIn,
  musicErrorKey,
  musicPanelState,
  musicQueueFor,
  musicQueueRows,
  offersStop,
  trackAddedMessage,
  type MusicCommand
} from "../../lib/musicBot.js";

/**
 * Pasting a link, the Queue, and telling the bot what to do with it.
 *
 * Shown only to a member who is in the voice channel, because being in it is
 * what entitles them to ask — the server enforces that, and offering a control
 * that would be refused is a worse answer than not offering it.
 *
 * Everything the panel shows is read from the room rather than remembered here.
 * Whether the bot is playing comes from the room's own snapshot, the same way a
 * person's microphone does; the Queue comes from what the bot published to
 * everyone in the room. So the member who pasted the link and the four who did
 * not are looking at the same panel, and a reload is not a different one.
 *
 * The transport controls appear only once a bot is here. Before that there is
 * nothing to stop and nothing to resume, and a Play button that did nothing
 * would be indistinguishable from one that was broken.
 *
 * It owns no scroll region. The call surface is the sole scroll owner, so the
 * Queue grows the page rather than becoming a little window of its own, and the
 * screen-share stage above it is never squeezed to make room.
 */
export function MusicPanel({ members, queues, roomId, connected, onMusicControl, t }: {
  members: VoiceMemberState[];
  queues: Record<string, MusicQueueState>;
  roomId: string | null;
  connected: boolean;
  onMusicControl: (roomId: string, command: MusicCommand) => Promise<MusicControlAck>;
  t: Translate;
}) {
  const [link, setLink] = useState("");
  const [refusal, setRefusal] = useState("");
  const [accepted, setAccepted] = useState("");
  const [pending, setPending] = useState(false);
  const bot = musicBotIn(members);
  const state = musicPanelState(bot);
  const stopping = offersStop(state);
  const queue = musicQueueFor(queues, roomId, bot);
  const rows = musicQueueRows(queue, members, t);

  const send = async (command: MusicCommand) => {
    if (!roomId) return;
    setPending(true);
    setRefusal("");
    setAccepted("");
    const response = await onMusicControl(roomId, command);
    setPending(false);
    if (!response.ok) {
      setRefusal(t(musicErrorKey(response.error)));
      return;
    }
    // The link is cleared only once it was accepted, so a refused paste is
    // still there to be corrected rather than retyped from memory.
    if (command.kind === "add") setLink("");
    if (response.track) setAccepted(trackAddedMessage(response.track, t));
  };

  const busy = pending || !connected || !roomId;
  const resting = state === "muted" ? t("music.muted") : state === "playing" ? t("music.playing") : t("music.idle");
  /**
   * One line, and it is the live region. What is playing and what is coming are
   * the list's job now, so this carries only the outcome of what somebody just
   * asked for: the sentence a refusal earned, or the confirmation that a paste
   * landed — which is the feedback a screen-reader user gets in place of
   * watching the link field empty itself — and otherwise what the room says the
   * bot is doing.
   */
  const message = pending ? t("music.summoning") : refusal || accepted || resting;

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
      {queue ? (
        <section className="music-queue" aria-labelledby="musicQueueTitle">
          <p className="label" id="musicQueueTitle">{t("music.queue")}</p>
          {rows.length > 0 ? (
            <ol className="music-queue-list">
              {rows.map((row) => (
                <li className={`music-queue-row ${row.isCurrent ? "is-current" : ""}`} key={row.entryId}>
                  {/* The Track that is playing is named, not merely shaded: a
                      member who cannot tell two greys apart still reads it. */}
                  <span className="music-queue-position">{row.positionLabel}</span>
                  <span className="music-queue-copy">
                    <strong>{row.title}</strong>
                    <span>{t("music.requestedBy", { nickname: row.requester })}</span>
                  </span>
                  <span className="music-queue-length">{row.length}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{t("music.queueEmpty")}</p>
          )}
        </section>
      ) : null}
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
