import type { MusicControlAck, MusicQueueState, MusicSearchResult, VoiceMemberState } from "@voxly/shared";
import { useEffect, useRef, useState } from "react";
import type { Translate } from "../../app/types.js";
import { CloseIcon, LeaveIcon, PauseIcon, PlayIcon, PlayingIcon, SkipIcon } from "../../components/ui/Icons.js";
import {
  isSendableInput,
  musicBotIn,
  musicErrorKey,
  musicQueueFor,
  musicQueueRows,
  musicRestingKey,
  musicSearchRows,
  musicSetLogRows,
  musicTransport,
  trackAddedMessage,
  transportToggleCommand,
  type MusicCommand
} from "../../lib/musicBot.js";

/**
 * Typing a name or pasting a link, the Queue, and telling the bot what to do.
 *
 * Shown only to a member who is in the voice channel, because being in it is
 * what entitles them to ask — the server enforces that, and offering a control
 * that would be refused is a worse answer than not offering it.
 *
 * Almost everything the panel shows is read from the room rather than
 * remembered here. The Queue, what is playing, and which entry the transport
 * controls act on all come from the one thing the bot published to everyone in
 * the room, so the member who pasted the link and the four who did not are
 * looking at the same panel, a reload is not a different one, and an action the
 * bot turns down leaves every client showing what the bot shows. ADR-0006
 * records why that is the Queue and not the bot's `speaking` flag on the voice
 * snapshot.
 *
 * **Search results are the exception, and they are the only one.** They arrive
 * on this member's own acknowledgement, they live in this component and nowhere
 * else, and they are never published: a Queue is the room's and everyone must
 * see the same one, while a list of Results belongs to the single member who
 * is still deciding between them. Read ADR-0007 before moving them anywhere,
 * because the rule immediately above says the opposite and applies to
 * everything else here.
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
  const [input, setInput] = useState("");
  /**
   * What a typed name might have meant, for this member alone. Component state
   * on purpose — see the note above: nothing here goes near the room's Queue,
   * and it is gone the moment one of them is chosen.
   */
  const [results, setResults] = useState<MusicSearchResult[]>([]);
  const [refusal, setRefusal] = useState("");
  const [accepted, setAccepted] = useState("");
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const firstResultRef = useRef<HTMLButtonElement>(null);
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
  // The Set log arrives inside the same published Queue, so it is read the same
  // way and nothing here remembers a line. ADR-0008.
  const logRows = musicSetLogRows(queue, members, t);
  const resultRows = musicSearchRows(results, t);
  // Play, Pause, Skip and every row's Remove all read the Queue the bot
  // published, so one message moves the whole panel and no two controls here
  // can disagree about what is happening. ADR-0006.
  const transport = musicTransport(bot, queue);

  /**
   * `closesWhatWasPressed` names the controls that take away the thing they act
   * on: a skip and a removal, and now choosing a result, which unmounts the
   * whole list including the button under the keyboard. One answer for all
   * three rather than a second mechanism for the newest of them.
   */
  const send = async (command: MusicCommand, closesWhatWasPressed = false) => {
    if (!roomId) return;
    droppedFocus.current = closesWhatWasPressed || command.kind === "skip" || command.kind === "remove";
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
    // A typed name that found Results. Nothing was queued and nothing is
    // said to the room; this member is being asked which one they meant.
    if (response.kind === "results") {
      droppedFocus.current = false;
      setResults(response.results);
      setAccepted(t(response.results.length > 0 ? "music.resultsFound" : "music.resultsEmpty"));
      return;
    }
    // A Track is in the Queue, so whatever was on offer has been decided.
    setResults([]);
    // What was typed is cleared only once it was accepted, so a refused paste
    // is still there to be corrected rather than retyped from memory.
    if (command.kind === "add") setInput("");
    if (response.track) setAccepted(trackAddedMessage(response.track, t));
  };

  /**
   * Puts the list away without choosing, and gives the keyboard back. The
   * sentence goes with it: "Choose one to add it to the queue" left standing
   * over an empty panel is the live region describing something that is no
   * longer there.
   */
  const dismissResults = () => {
    setResults([]);
    setAccepted("");
    inputRef.current?.focus();
  };

  const busy = pending || !connected || !roomId;
  // Nothing queued is nothing to play, pause or skip. A control that is visible
  // and enabled and does nothing is indistinguishable from a broken one.
  const transportDisabled = busy || !transport.currentEntryId;
  const restingKey = musicRestingKey(transport);

  // Put the keyboard back on the field that queues the next Track, rather than
  // at the top of the document, when the control a member just used went away
  // under them. `document.body` holding focus is the browser saying it had
  // nowhere to put it; anything else and the press left focus where it was.
  useEffect(() => {
    if (!droppedFocus.current) return;
    droppedFocus.current = false;
    if (document.activeElement === document.body) inputRef.current?.focus();
  }, [rows.length, results.length]);

  /**
   * The closest match is the one on offer, so the keyboard goes to it: a member
   * who pressed Enter to search presses Enter again to take the obvious answer,
   * and Tab reaches the rest. Nothing but this member's own search can produce
   * a list, so this never pulls focus for somebody else's action.
   */
  useEffect(() => {
    if (results.length > 0) firstResultRef.current?.focus();
  }, [results]);
  /**
   * The member's Reply: what the bot said back to *this* member about what they
   * just asked for, refusal or acknowledgement alike. It sits under the field
   * that produced it and it is the live region, because it is the feedback a
   * screen-reader user gets in place of watching the field empty itself.
   *
   * Separate from the room's notice below, which belongs to everybody and says
   * only the one thing the room cannot see for itself. They used to share a
   * line and therefore took turns: a member whose request was refused while the
   * bot was muted saw one of the two and never learned about the other.
   */
  const reply = pending ? t("music.summoning") : refusal || accepted;
  const roomNotice = restingKey ? t(restingKey) : "";

  return (
    <section
      className="music-panel"
      aria-labelledby="musicPanelTitle"
      onKeyDown={(event) => {
        // The way out of a list of Results without choosing one, and the
        // keyboard comes back with it — the same answer the popovers and
        // dialogs here already give. On the panel rather than on the list
        // itself, because the field is where a member goes to ask a different
        // question and Escape has to reach them there too.
        if (event.key === "Escape" && results.length > 0) dismissResults();
      }}
    >
      <header className="compact-section-head">
        <div>
          <p className="label" id="musicPanelTitle">{t("music.title")}</p>
        </div>
      </header>
      <form
        className="music-panel-link"
        onSubmit={(event) => {
          event.preventDefault();
          if (isSendableInput(input)) void send({ kind: "add", input: input.trim() });
        }}
      >
        {/* No URL input mode any more: this field takes a name as often as a
            link, and a URL keyboard is the wrong one for typing words. */}
        <input
          ref={inputRef}
          aria-label={t("music.inputLabel")}
          autoComplete="off"
          disabled={busy}
          name="musicInput"
          onChange={(event) => {
            setInput(event.target.value);
            // Editing the field is the start of a different question, and the
            // answer to the last one should not sit under it looking current —
            // neither the list nor the sentence that pointed at it.
            setResults([]);
            setAccepted("");
            setRefusal("");
          }}
          placeholder={t("music.inputPlaceholder")}
          type="text"
          value={input}
        />
        <button className="btn btn-primary" disabled={busy || !isSendableInput(input)} type="submit">
          {t("music.add")}
        </button>
      </form>
      {/* Always rendered, never conditionally: a live region has to be in the
          document before its content arrives, or the first Reply is the one
          nobody hears. Its role stays put for the same reason — swapping
          between status and alert as the Reply changes is not something screen
          readers follow reliably. The colour is what changes, and it is the
          app's own colour for a failure rather than the muted grey this used
          to share with the room's status. */}
      <p className={`music-reply ${refusal ? "error-text" : "muted small"}`} role="status" aria-live="polite">{reply}</p>
      {/* What a typed name might have meant. This member's list and nobody
          else's — it never reaches `music:queue`, and ADR-0007 says why. */}
      {resultRows.length > 0 ? (
        <section aria-labelledby="musicResultsTitle" className="music-results">
          <p className="label" id="musicResultsTitle">{t("music.results")}</p>
          <ol className="music-results-list">
            {resultRows.map((row, index) => (
              <li key={row.url}>
                {/* The whole row is the control, so the pointer target is the
                    result rather than a word inside it, and Tab reaches each
                    one in turn. Its accessible name is the Track, because a
                    column of buttons all called "Add" says nothing about which
                    one a screen-reader user is choosing. */}
                <button
                  aria-label={row.label}
                  className={`btn btn-ghost music-result ${row.isClosest ? "is-closest" : ""}`}
                  disabled={busy}
                  onClick={() => void send({ kind: "add", input: row.url }, true)}
                  ref={index === 0 ? firstResultRef : undefined}
                  type="button"
                >
                  <span className="music-result-copy">
                    {/* The one on offer, said rather than only shaded. Focus
                        shows it to whoever searched with the keyboard; a
                        member who submitted with the pointer gets focus moved
                        programmatically, which browsers deliberately draw no
                        ring for — so without this the "already selected" the
                        design asks for would be invisible to them. */}
                    {row.isClosest ? <span className="music-result-closest">{t("music.closest")}</span> : null}
                    <strong>{row.title}</strong>
                    {row.channel ? <span>{row.channel}</span> : null}
                  </span>
                  <span className="music-result-length">{row.length}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {queue ? (
        <section className="music-queue" aria-labelledby="musicQueueTitle">
          <p className="label" id="musicQueueTitle">{t("music.queue")}</p>
          {rows.length > 0 ? (
            <ol className="music-queue-list">
              {rows.map((row) => (
                <li className={`music-queue-row ${row.isCurrent ? "is-current" : ""}`} key={row.entryId}>
                  {/* The Track that is playing is marked, not merely shaded: a
                      member who cannot tell two greys apart still gets the word,
                      because `role="img"` gives the mark the accessible name the
                      row used to spend a whole column of text on. The words moved
                      into the mark rather than being dropped — the transport
                      control and this row were saying the same thing twice. */}
                  {row.isCurrent ? (
                    <span className="music-queue-position is-current" role="img" aria-label={row.positionLabel}>
                      {transport.playing ? <PlayingIcon /> : <PauseIcon />}
                    </span>
                  ) : (
                    <span className="music-queue-position">{row.positionLabel}</span>
                  )}
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
      {transport.present || roomNotice ? (
      <div className="music-panel-controls">
        {transport.present ? (
          <>
            {/* One button, and the mark on it says which half it is. The word
                moved from the face into the accessible name when the face
                became an icon: it is still the only place the pressed state is
                said, because "Pause, pressed" leaves a listener working out
                whether the music is running or stopped, which is the one thing
                the name has already told them. */}
            <button
              aria-label={transport.playing ? t("music.pause") : t("music.play")}
              className="icon-btn music-transport"
              disabled={transportDisabled}
              onClick={() => void send(transportToggleCommand(transport))}
              title={transport.playing ? t("music.pause") : t("music.play")}
              type="button"
            >
              {transport.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            {/* The skip names the entry it believes is playing. A panel one
                message out of date therefore skips nothing rather than skipping
                whatever moved up — which is what makes two members pressing it
                together cost one Track. */}
            <button
              aria-label={t("music.skip")}
              className="icon-btn music-transport"
              disabled={transportDisabled}
              onClick={() => {
                // Narrowing, not a second guard: `disabled` has already ruled
                // this out, and the command cannot carry a null entry.
                if (transport.currentEntryId) void send({ kind: "skip", entryId: transport.currentEntryId });
              }}
              title={t("music.skip")}
              type="button"
            >
              <SkipIcon />
            </button>
          </>
        ) : null}
        {/* The room's own notice, and the only thing left in it: the mute,
            which is the one state the room cannot see for itself. Before the
            control that sends the bot away, so that control keeps the same
            place on the row whether or not an owner has muted anything. */}
        {roomNotice ? <span className="music-room-notice muted small">{roomNotice}</span> : null}
        {transport.present ? (
          <button className="btn btn-ghost music-leave" type="button" disabled={busy} onClick={() => void send({ kind: "leave" })}>
            <LeaveIcon />
            <span>{t("music.leave")}</span>
          </button>
        ) : null}
      </div>
      ) : null}
      {/* Last on the page, because it is the part that grows. The Queue grows
          when somebody adds; this grows on every press anyone in the room
          makes, including a pause that changes nothing else here — so anything
          above it would drift down the page under a member who was reaching
          for it. Not a live region either: the panel has one, and it belongs to
          the member waiting for an answer to their own press. */}
      {logRows.length > 0 ? (
        <section className="music-log" aria-labelledby="musicLogTitle">
          <p className="label" id="musicLogTitle">{t("music.log")}</p>
          <ol className="music-log-list">
            {logRows.map((row) => (
              /* By id and not by what it says: two members pausing in turn
                 produce two lines that read identically. */
              <li key={row.lineId}>{row.message}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}
