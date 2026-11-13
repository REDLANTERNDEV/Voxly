import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PresenceUser, RoleSummary, RoomAccessUpdate, RoomSummary } from "@voxly/shared";
import type { Translate } from "../../app/types.js";
import { EyeIcon, LockIcon } from "../../components/ui/Icons.js";
import { ModalPortal } from "../../components/ui/Dialogs.js";
import { roleDisplayName } from "../../lib/roles.js";

/** A proposed Channel access, before it is sent. */
export interface ChannelAccessDraft {
  isPrivate: boolean;
  listed: boolean;
  userIds: ReadonlySet<string>;
  roleIds: ReadonlySet<string>;
}

export function channelAccessDraft(
  room?: Pick<RoomSummary, "isPrivate" | "listed" | "accessUserIds" | "accessRoleIds">
) {
  return {
    isPrivate: room?.isPrivate ?? false,
    listed: room?.listed ?? false,
    userIds: new Set(room?.accessUserIds ?? []),
    roleIds: new Set(room?.accessRoleIds ?? [])
  } satisfies ChannelAccessDraft;
}

/**
 * The whole new setting the server is asked for. Owners are never listed:
 * they always have access. Administrator Roles are kept as chosen, since
 * their entry outlives Administrator being switched off later.
 */
export function channelAccessUpdate(draft: ChannelAccessDraft, members: readonly PresenceUser[]): RoomAccessUpdate {
  const ownerIds = new Set(members.filter((member) => member.role === "owner").map((member) => member.userId));
  return {
    isPrivate: draft.isPrivate,
    listed: draft.isPrivate && draft.listed,
    userIds: draft.isPrivate ? [...draft.userIds].filter((userId) => !ownerIds.has(userId)) : [],
    roleIds: draft.isPrivate ? [...draft.roleIds] : []
  };
}

function toggled(current: ReadonlySet<string>, id: string) {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * The Channel access controls (ADR-0037): the Private switch, who else sees
 * the channel, then Roles before members (ADR-0038). Shared by the channel
 * menu's dialog and the last step of creating a channel, so both read the
 * same. Owners and Roles holding Administrator appear checked and locked
 * because they always have access whatever the list says.
 */
export function ChannelAccessFields({
  draft,
  onChange,
  members,
  roles = [],
  lockedReason,
  privateLocked,
  disabled,
  idPrefix,
  firstControl,
  t
}: {
  draft: ChannelAccessDraft;
  onChange: (next: ChannelAccessDraft) => void;
  /** The member-safe directory of this Server. Bots are left out here. */
  members: readonly PresenceUser[];
  /** The Server's Roles, highest first. */
  roles?: readonly RoleSummary[];
  /** Why this channel can never be private, when it cannot. */
  lockedReason: string | null;
  /** True when the Private switch may not be turned on. */
  privateLocked: boolean;
  disabled: boolean;
  /** Keeps ids and the radio group unique when two of these are on screen. */
  idPrefix: string;
  firstControl?: RefObject<HTMLInputElement | null>;
  t: Translate;
}) {
  const [query, setQuery] = useState("");
  // `@everyone` on the list would make the channel public under another name.
  const listableRoles = roles.filter((role) => role.kind !== "everyone");
  const people = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return members
      .filter((member) => !member.isBot)
      .filter((member) => !needle || member.nickname.toLocaleLowerCase().includes(needle))
      .sort((a, b) => (a.role === b.role ? a.nickname.localeCompare(b.nickname) : a.role === "owner" ? -1 : 1));
  }, [members, query]);
  const chosenRoleCount = listableRoles.filter(
    (role) => role.permissions.includes("administrator") || draft.roleIds.has(role.id)
  ).length;
  const chosenMemberCount = members.filter(
    (member) => !member.isBot && (member.role === "owner" || draft.userIds.has(member.userId))
  ).length;

  return (
    <div className={`channel-access-fields ${draft.isPrivate ? "is-private" : ""}`}>
      <label className="channel-access-private">
        <span className="channel-access-private-mark" aria-hidden="true">
          <LockIcon />
        </span>
        <span className="channel-access-private-copy">
          <strong id={`${idPrefix}PrivateLabel`}>{t("channel.accessPrivate")}</strong>
          <span id={`${idPrefix}PrivateHint`} className="muted">
            {lockedReason ?? t("channel.accessPrivateHint")}
          </span>
        </span>
        <input
          ref={firstControl}
          type="checkbox"
          role="switch"
          className="channel-access-switch"
          checked={draft.isPrivate}
          disabled={disabled || (privateLocked && !draft.isPrivate)}
          aria-labelledby={`${idPrefix}PrivateLabel`}
          aria-describedby={`${idPrefix}PrivateHint`}
          onChange={(event) => onChange({ ...draft, isPrivate: event.currentTarget.checked })}
        />
      </label>
      {draft.isPrivate ? (
        <>
          <fieldset className="channel-access-visibility" disabled={disabled}>
            <legend>{t("channel.accessVisibility")}</legend>
            <div className="channel-access-tiles">
              <label className="channel-access-tile">
                <input
                  type="radio"
                  name={`${idPrefix}Visibility`}
                  checked={!draft.listed}
                  aria-describedby={`${idPrefix}HiddenHint`}
                  onChange={() => onChange({ ...draft, listed: false })}
                />
                <span className="channel-access-tile-mark" aria-hidden="true">
                  <EyeIcon off />
                </span>
                <span className="channel-access-tile-copy">
                  <strong>{t("channel.accessHidden")}</strong>
                  <span id={`${idPrefix}HiddenHint`} className="muted">
                    {t("channel.accessHiddenHint")}
                  </span>
                </span>
              </label>
              <label className="channel-access-tile">
                <input
                  type="radio"
                  name={`${idPrefix}Visibility`}
                  checked={draft.listed}
                  aria-describedby={`${idPrefix}ListedHint`}
                  onChange={() => onChange({ ...draft, listed: true })}
                />
                <span className="channel-access-tile-mark" aria-hidden="true">
                  <EyeIcon />
                </span>
                <span className="channel-access-tile-copy">
                  <strong>{t("channel.accessListed")}</strong>
                  <span id={`${idPrefix}ListedHint`} className="muted">
                    {t("channel.accessListedHint")}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
          {listableRoles.length > 0 ? (
            <fieldset className="channel-access-members channel-access-roles" disabled={disabled}>
              <legend>
                <span>{t("channel.accessRoles")}</span>
                <span className="channel-access-count">{t("channel.accessSelected", { count: chosenRoleCount })}</span>
              </legend>
              <ul className="channel-access-list">
                {listableRoles.map((role) => {
                  // Administrator enters every Private channel; its Roles are in already.
                  const implicit = role.permissions.includes("administrator");
                  return (
                    <li key={role.id}>
                      <label className={implicit ? "is-locked" : undefined}>
                        <input
                          type="checkbox"
                          checked={implicit || draft.roleIds.has(role.id)}
                          disabled={implicit}
                          onChange={() => onChange({ ...draft, roleIds: toggled(draft.roleIds, role.id) })}
                        />
                        <span className="channel-access-name">{roleDisplayName(role, t)}</span>
                        <span
                          className={`channel-access-avatar is-role${role.color ? "" : " is-plain"}`}
                          aria-hidden="true"
                          style={role.color ? ({ "--role-color": role.color } as CSSProperties) : undefined}
                        />
                        {implicit ? <span className="muted">{t("channel.accessAdministratorAlways")}</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ) : null}
          <fieldset className="channel-access-members" disabled={disabled}>
            <legend>
              <span>{t("channel.accessMembers")}</span>
              <span className="channel-access-count">{t("channel.accessSelected", { count: chosenMemberCount })}</span>
            </legend>
            <input
              className="input channel-access-search"
              type="search"
              aria-label={t("channel.accessSearch")}
              placeholder={t("channel.accessSearch")}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <ul className="channel-access-list">
              {people.length === 0 ? (
                <li className="muted channel-access-empty">{t("channel.accessNoMembers")}</li>
              ) : null}
              {people.map((member) => {
                const isOwner = member.role === "owner";
                return (
                  <li key={member.userId}>
                    <label className={isOwner ? "is-locked" : undefined}>
                      <input
                        type="checkbox"
                        checked={isOwner || draft.userIds.has(member.userId)}
                        disabled={isOwner}
                        onChange={() => onChange({ ...draft, userIds: toggled(draft.userIds, member.userId) })}
                      />
                      <span className="channel-access-name">{member.nickname}</span>
                      <span className="channel-access-avatar" aria-hidden="true">
                        {[...member.nickname.trim()][0]?.toLocaleUpperCase() ?? "?"}
                      </span>
                      {isOwner ? <span className="muted">{t("channel.accessOwnerAlways")}</span> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </>
      ) : null}
    </div>
  );
}

/**
 * Where a Manage channels holder makes an existing channel private and
 * chooses its Channel access from the channel menu. The server is the
 * authority: this only proposes a whole new setting.
 */
export function ChannelAccessDialog({
  room,
  members,
  roles = [],
  lockedReason,
  returnFocus,
  t,
  onCancel,
  onSave
}: {
  room: RoomSummary;
  members: PresenceUser[];
  roles?: readonly RoleSummary[];
  lockedReason: string | null;
  returnFocus: HTMLButtonElement | null;
  t: Translate;
  onCancel: () => void;
  onSave: (access: RoomAccessUpdate) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ChannelAccessDraft>(() => channelAccessDraft(room));
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

  return (
    <ModalPortal>
      <div
        className="confirm-backdrop"
        onMouseDown={() => {
          if (!saving) close();
        }}
        onContextMenu={(event) => event.stopPropagation()}
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
            void onSave(channelAccessUpdate(draft, members))
              .then(close)
              .catch(() => setError(t("channel.accessFailed")))
              .finally(() => setSaving(false));
          }}
        >
          <h2 id="channelAccessTitle">{t("channel.accessTitle", { channel: room.name })}</h2>
          <ChannelAccessFields
            draft={draft}
            onChange={setDraft}
            members={members}
            roles={roles}
            lockedReason={lockedReason}
            privateLocked={lockedReason !== null}
            disabled={saving}
            idPrefix="channelAccess"
            firstControl={firstControl}
            t={t}
          />
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
    </ModalPortal>
  );
}
