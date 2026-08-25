import type { MusicControlAck, MusicQueueState, VoiceMemberState } from "@voxly/shared";
import { useEffect, useRef, useState } from "react";
import type { Translate } from "../../app/types.js";
import { CloseIcon } from "../../components/ui/Icons.js";
import {
  isSendableLink,
  musicBotIn,
  musicErrorKey,
  musicQueueFor,
  musicQueueRows,
  musicRestingKey,
  musicTransport,
  trackAddedMessage,
  transportToggleCommand,
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
 * The Queue, what is playing, and which entry the transport controls act on all
 * come from the one thing the bot published to everyone in the room, so the
 * member who pasted the link and the four who did not are looking at the same
 * panel, a reload is not a different one, and an action the bot turns down
 * leaves every client showing what the bot shows. ADR-0006 records why that is
 * the Queue and not the bot's `speaking` flag on the voice snapshot.
 *
 * The transport controls appear only once a bot is here, and go quiet when
 * nothing is queued. Before either, there is nothing to pause, skip or resume,
 * and a button that did nothing would be indistinguishable from a broken one.
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
  const linkRef = useRef<HTMLInputElement>(null);
  /**
   * Set while one of this member's own presses is in flight on a control that
   * can take away the thing it acts on. Skipping the last Track disables the
   * button under the cursor and removing a row unmounts it, and either way the
   * browser drops focus to the document — leaving a keyboard user at the top of
   * the page. Only *this* client's press counts: the Queue also changes when
   * somebody else acts, and pulling focus for that would be worse than losing
   * it.
   */
  const droppedFocus = useRef(false);
  const bot = musicBotIn(members);
  const queue = musicQueueFor(queues, roomId, bot);
  const rows = musicQueueRows(queue, members, t);
  // Play, Pause, Skip and every row's Remove all read the Queue the bot
  // published, so one message moves the whole panel and no two controls here
  // can disagree about what is happening. ADR-0006.
  const transport = musicTransport(bot, queue);

  const send = async (command: MusicCommand) => {
    if (!roomId) return;
    droppedFocus.current = command.kind === "skip" || command.kind === "remove";
    setPending(true);
    setRefusal("");
    setAccepted("");
    const response = await onMusicControl(roomId, command);
    setPending(false);
    if (!response.ok) {
      // Nothing was taken away, so nothing lost focus and a later change to the
      // Queue — somebody else's — must not be mistaken for this press.
      droppedFocus.current = false;
      setRefusal(t(musicErrorKey(response.error)));
      return;
    }
    // The link is cleared only once it was accepted, so a refused paste is
    // still there to be corrected rather than retyped from memory.
    if (command.kind === "add") setLink("");
    if (response.track) setAccepted(trackAddedMessage(response.track, t));
  };

  const busy = pending || !connected || !roomId;
  // Nothing queued is nothing to play, pause or skip. A control that is visible
  // and enabled and does nothing is indistinguishable from a broken one.
  const transportDisabled = busy || !transport.currentEntryId;
  const resting = t(musicRestingKey(transport));

  // Put the keyboard back on the field that queues the next Track, rather than
  // at the top of the document, when the control a member just used went away
  // under them. `document.body` holding focus is the browser saying it had
  // nowhere to put it; anything else and the press left focus where it was.
  useEffect(() => {
    if (!droppedFocus.current) return;
    droppedFocus.current = false;
    if (document.activeElement === document.body) linkRef.current?.focus();
  }, [rows.length]);
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
          ref={linkRef}
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
                  {/* Icon-only, so it carries the Track's name itself: a row of
                      buttons all called "Remove" tells a screen-reader user
                      nothing about which Track they are about to lose. */}
                  <button
                    aria-label={t("music.removeTrack", { title: row.title })}
                    className="btn btn-ghost music-queue-remove"
                    disabled={busy}
                    onClick={() => void send({ kind: "remove", entryId: row.entryId })}
                    title={t("music.remove")}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{t("music.queueEmpty")}</p>
          )}
        </section>
      ) : null}
      <div className="music-panel-controls">
        {transport.present ? (
          <>
            {/* One button, and its own label says which half it is. No pressed
                state announced beside that: "Pause, pressed" leaves a listener
                working out whether the music is running or stopped, which is
                the one thing the label has already told them. */}
            <button
              className={`btn ${transport.playing ? "is-active" : ""}`}
              type="button"
              disabled={transportDisabled}
              onClick={() => void send(transportToggleCommand(transport))}
            >
              {transport.playing ? t("music.pause") : t("music.play")}
            </button>
            {/* The skip names the entry it believes is playing. A panel one
                message out of date therefore skips nothing rather than skipping
                whatever moved up — which is what makes two members pressing it
                together cost one Track. */}
            <button
              className="btn"
              type="button"
              disabled={transportDisabled}
              onClick={() => {
                // Narrowing, not a second guard: `disabled` has already ruled
                // this out, and the command cannot carry a null entry.
                if (transport.currentEntryId) void send({ kind: "skip", entryId: transport.currentEntryId });
              }}
            >
              {t("music.skip")}
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
