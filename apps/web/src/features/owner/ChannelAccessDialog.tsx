import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresenceUser, RoomAccessUpdate, RoomSummary } from "@voxly/shared";
import type { Translate } from "../../app/types.js";

/**
 * Where a Server owner makes a channel private and chooses its Channel access
 * (ADR-0037). The server is the authority: this only proposes a whole new
 * setting, and owners appear checked and locked because they always have
 * access whatever the list says.
 */
export function ChannelAccessDialog({
  room,
  members,
  lockedReason,
  returnFocus,
  t,
  onCancel,
  onSave
}: {
  room: RoomSummary;
  /** The member-safe directory of this Server. Bots are left out here. */
  members: PresenceUser[];
  /** Why this channel can never be private, when it cannot. */
  lockedReason: string | null;
  returnFocus: HTMLButtonElement | null;
  t: Translate;
  onCancel: () => void;
  onSave: (access: RoomAccessUpdate) => Promise<void>;
}) {
  const [isPrivate, setIsPrivate] = useState(room.isPrivate);
  const [listed, setListed] = useState(room.listed);
  const [chosen, setChosen] = useState(() => new Set(room.accessUserIds ?? []));
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const firstControl = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    onCancel();
    window.setTimeout(() => returnFocus?.focus(), 0);
  }, [onCancel, returnFocus]);

  // Focus once per opening, so a realtime rerender never steals it back.
  useEffect(() => {
    firstControl.current?.focus();
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        close();
      }
      if (event.key !== "Tab") return;
      const controls = form.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)");
      if (!controls?.length) {
        event.preventDefault();
        return;
      }
      const first = controls[0],
        last = controls[controls.length - 1];
      if (!form.current?.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, saving]);

  const people = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return members
      .filter((member) => !member.isBot)
      .filter((member) => !needle || member.nickname.toLocaleLowerCase().includes(needle))
      .sort((a, b) => (a.role === b.role ? a.nickname.localeCompare(b.nickname) : a.role === "owner" ? -1 : 1));
  }, [members, query]);

  const toggle = (userId: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  return (
    <div
      className="confirm-backdrop"
      onMouseDown={() => {
        if (!saving) close();
      }}
    >
      <form
        ref={form}
        noValidate
        className="confirm-dialog channel-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channelAccessTitle"
        aria-busy={saving}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError("");
          const ownerIds = new Set(members.filter((member) => member.role === "owner").map((member) => member.userId));
          void onSave({
            isPrivate,
            listed: isPrivate && listed,
            userIds: isPrivate ? [...chosen].filter((userId) => !ownerIds.has(userId)) : []
          })
            .then(close)
            .catch(() => setError(t("channel.accessFailed")))
            .finally(() => setSaving(false));
        }}
      >
        <h2 id="channelAccessTitle">{t("channel.accessTitle", { channel: room.name })}</h2>
        <label className="channel-access-toggle">
          <input
            ref={firstControl}
            type="checkbox"
            role="switch"
            checked={isPrivate}
            disabled={saving || (lockedReason !== null && !room.isPrivate)}
            aria-describedby="channelAccessPrivateHint"
            onChange={(event) => setIsPrivate(event.currentTarget.checked)}
          />
          <span>{t("channel.accessPrivate")}</span>
        </label>
        <p id="channelAccessPrivateHint" className="muted">
          {lockedReason ?? t("channel.accessPrivateHint")}
        </p>
        {isPrivate ? (
          <>
            <fieldset className="channel-access-visibility" disabled={saving}>
              <legend>{t("channel.accessVisibility")}</legend>
              <label>
                <input
                  type="radio"
                  name="channelAccessVisibility"
                  checked={!listed}
                  onChange={() => setListed(false)}
                />
                <span>{t("channel.accessHidden")}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="channelAccessVisibility"
                  checked={listed}
                  aria-describedby="channelAccessListedHint"
                  onChange={() => setListed(true)}
                />
                <span>{t("channel.accessListed")}</span>
              </label>
              <p id="channelAccessListedHint" className="muted">
                {t("channel.accessListedHint")}
              </p>
            </fieldset>
            <fieldset className="channel-access-members" disabled={saving}>
              <legend>{t("channel.accessMembers")}</legend>
              <input
                className="input"
                type="search"
                aria-label={t("channel.accessSearch")}
                placeholder={t("channel.accessSearch")}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <ul className="channel-access-list">
                {people.length === 0 ? <li className="muted">{t("channel.accessNoMembers")}</li> : null}
                {people.map((member) => {
                  const isOwner = member.role === "owner";
                  return (
                    <li key={member.userId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={isOwner || chosen.has(member.userId)}
                          disabled={isOwner}
                          onChange={() => toggle(member.userId)}
                        />
                        <span className="channel-access-name">{member.nickname}</span>
                        {isOwner ? <span className="muted">{t("channel.accessOwnerAlways")}</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          </>
        ) : null}
        <p className="error-text" aria-live="polite">
          {error}
        </p>
        <div className="confirm-actions">
          <button className="btn btn-ghost" type="button" disabled={saving} onClick={close}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {t("channel.accessSave")}
          </button>
        </div>
      </form>
    </div>
  );
}
