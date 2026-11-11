import {
  roleColors,
  roleNameMaxLength,
  serverPermissions,
  type Permission,
  type PresenceUser,
  type RoleChange,
  type RoleSummary
} from "@voxly/shared";
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ApiError } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { ArrowIcon, GripIcon, PlusIcon, TrashIcon } from "../../components/ui/Icons.js";
import { MemberRow } from "../../components/ui/Primitives.js";
import {
  canManageRole,
  clearedPermissions,
  dropRole,
  memberRoleRows,
  moveRole,
  roleDisplayName,
  roleEditLock,
  roleMemberCount,
  rolesInOrder,
  type RoleActor
} from "../../lib/roles.js";

/** Each palette colour's spoken name, in the palette's order, so a colour is never chosen by sight alone. */
const colorNameKeys = [
  "roles.colorRed",
  "roles.colorOrange",
  "roles.colorGold",
  "roles.colorGreen",
  "roles.colorTeal",
  "roles.colorBlue",
  "roles.colorIndigo",
  "roles.colorPurple",
  "roles.colorPink",
  "roles.colorGrey"
] as const;

export interface RoleActions {
  onCreateRole: (name: string) => Promise<RoleSummary>;
  onUpdateRole: (roleId: string, change: RoleChange) => Promise<RoleSummary>;
  onReorderRoles: (roleIds: string[]) => Promise<void>;
  onDeleteRole: (roleId: string) => Promise<void>;
  onSetMemberRole: (userId: string, roleId: string, give: boolean) => Promise<PresenceUser>;
}

function RoleDot({ role }: { role: Pick<RoleSummary, "color"> }) {
  return (
    <span
      className={`member-role-dot${role.color ? "" : " is-plain"}`}
      aria-hidden="true"
      style={role.color ? ({ "--role-color": role.color } as CSSProperties) : undefined}
    />
  );
}

/**
 * Server settings › Roles (ADR-0038, design decisions 6, 17 and 19): the Roles
 * in rank order with their member counts, reordered by dragging or with Move
 * up / Move down, and the Role editor for one of them.
 */
export function ServerRolesSection(
  props: {
    actor: RoleActor;
    roles: RoleSummary[];
    members: PresenceUser[];
    t: Translate;
    onError: (message: string) => void;
  } & RoleActions
) {
  const { actor, t } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  // The order a reorder on its way to the server will leave; drawn at once, so
  // a press shows before the answer and the next press builds on it.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const roles = rolesInOrder(props.roles, pendingOrder);
  const orderKey = roles.map((role) => role.id).join(" ");
  // A pointer drag runs from a row's grip: HTML5 drag events never fire from touch.
  const [drag, setDrag] = useState<{ roleId: string; pointerId: number; targetId: string | null } | null>(null);
  const editing = props.roles.find((role) => role.id === editingId);
  const listRef = useRef<HTMLUListElement | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);
  const returningRef = useRef(false);
  // Coming back from the editor (or after a delete unmounts it), focus lands
  // on the list's first control rather than on the page.
  useEffect(() => {
    if (editingId !== null || !returningRef.current) return;
    returningRef.current = false;
    createRef.current?.focus();
  }, [editingId]);
  // A keyboard move can disable the very button that was pressed (the Role
  // reached an edge); the Role's row keeps the focus rather than the page.
  const movedRef = useRef<{ roleId: string; direction: "up" | "down" } | null>(null);
  useEffect(() => {
    const moved = movedRef.current;
    if (!moved) return;
    movedRef.current = null;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-role-row="${moved.roleId}"]`);
    const same = row?.querySelector<HTMLButtonElement>(`[data-move="${moved.direction}"]`);
    const other = row?.querySelector<HTMLButtonElement>(`[data-move="${moved.direction === "up" ? "down" : "up"}"]`);
    const target = [same, other].find((button) => button && !button.disabled) ?? row?.querySelector("button");
    target?.focus();
  }, [orderKey]);

  const failed = (error: unknown) =>
    props.onError(
      error instanceof ApiError && error.code === "role_limit_reached" ? t("roles.limitReached") : t("roles.saveFailed")
    );
  const createRole = () => {
    void props
      .onCreateRole(t("roles.newRoleName"))
      .then((role) => setEditingId(role.id))
      .catch(failed);
  };
  // One reorder in flight at a time. A move made meanwhile waits, and only the
  // latest waiting order is sent: each one names every movable Role, so it
  // already carries the moves before it.
  const inFlightRef = useRef(false);
  const queuedRef = useRef<string[] | null>(null);
  const send = (ids: string[]) => {
    inFlightRef.current = true;
    void props.onReorderRoles(ids).then(
      () => {
        const next = queuedRef.current;
        queuedRef.current = null;
        if (next) return send(next);
        inFlightRef.current = false;
        setPendingOrder(null);
      },
      (error: unknown) => {
        queuedRef.current = null;
        inFlightRef.current = false;
        setPendingOrder(null);
        failed(error);
      }
    );
  };
  const reorder = (ids: string[] | null, moved?: { roleId: string; direction: "up" | "down" }) => {
    if (!ids) return;
    movedRef.current = moved ?? null;
    setPendingOrder(ids);
    if (inFlightRef.current) queuedRef.current = ids;
    else send(ids);
  };

  // The Role row under a pointer, by height alone so a finger drifting sideways
  // still lands; a target the actor may not drop onto is no target.
  const dropTargetAt = (roleId: string, clientY: number) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-role-row]") ?? []);
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (clientY < bounds.top || clientY > bounds.bottom) continue;
      const targetId = row.dataset.roleRow ?? null;
      return targetId && dropRole(actor, roles, roleId, targetId) ? targetId : null;
    }
    return null;
  };
  const startDrag = (roleId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ roleId, pointerId: event.pointerId, targetId: null });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    // The section scrolls under the drag near its edges, so a Role can travel
    // past the first screen.
    const scroller = listRef.current?.closest<HTMLElement>(".server-settings-content");
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientY < bounds.top + 32) scroller.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 32) scroller.scrollTop += 12;
    }
    const targetId = dropTargetAt(drag.roleId, event.clientY);
    if (targetId !== drag.targetId) setDrag({ ...drag, targetId });
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDrag(null);
    if (event.type === "pointerup" && drag.targetId) reorder(dropRole(actor, roles, drag.roleId, drag.targetId));
  };

  if (editing) {
    return (
      <RoleEditor
        key={editing.id}
        {...props}
        role={editing}
        onSelect={setEditingId}
        onBack={() => {
          returningRef.current = true;
          setEditingId(null);
        }}
        onCreate={createRole}
        onFailed={failed}
      />
    );
  }

  return (
    <section className="dash-panel server-settings-panel server-roles">
      <header className="dash-panel-head server-roles-head">
        <p className="muted small">{t("roles.copy")}</p>
        <button className="btn btn-primary" type="button" ref={createRef} onClick={createRole}>
          <PlusIcon />
          <span>{t("roles.create")}</span>
        </button>
      </header>
      {roles.some((role) => moveRole(actor, roles, role.id, -1) || moveRole(actor, roles, role.id, 1)) ? (
        <p className="muted small">{t("roles.dragHint")}</p>
      ) : null}
      <ul className={`server-roles-list${drag ? " is-dragging" : ""}`} ref={listRef}>
        {roles.map((role) => {
          const name = roleDisplayName(role, t);
          const movable = role.kind === null && canManageRole(actor, role);
          const up = moveRole(actor, roles, role.id, -1);
          const down = moveRole(actor, roles, role.id, 1);
          const dragClass =
            drag?.roleId === role.id ? " is-dragging" : drag?.targetId === role.id ? " is-drop-target" : "";
          return (
            <li key={role.id} data-role-row={role.id} className={`server-roles-row${dragClass}`}>
              {/* The grip is the drag handle, for a mouse, a pen and a finger alike.
                  It is hidden from assistive technology: the named Move up and
                  Move down buttons give the same order. */}
              {movable ? (
                <span
                  className="server-roles-grip is-handle"
                  aria-hidden="true"
                  onPointerDown={(event) => startDrag(role.id, event)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onLostPointerCapture={endDrag}
                >
                  <GripIcon />
                </span>
              ) : (
                <span className="server-roles-grip" aria-hidden="true" />
              )}
              <RoleDot role={role} />
              <button
                className="server-roles-open"
                type="button"
                aria-label={t("roles.edit", { role: name })}
                onClick={() => setEditingId(role.id)}
              >
                <span className="server-roles-name">{name}</span>
                <span className="muted small">
                  {roleMemberCount(role, props.members) === 1
                    ? t("roles.memberCountOne")
                    : t("roles.memberCount", { count: roleMemberCount(role, props.members) })}
                </span>
              </button>
              {role.kind === null ? (
                <span className="server-roles-move">
                  <button
                    className="icon-btn"
                    type="button"
                    data-move="up"
                    disabled={!up}
                    aria-label={t("roles.moveUp", { role: name })}
                    title={t("roles.moveUp", { role: name })}
                    onClick={() => reorder(up, { roleId: role.id, direction: "up" })}
                  >
                    <ArrowIcon />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    data-move="down"
                    disabled={!down}
                    aria-label={t("roles.moveDown", { role: name })}
                    title={t("roles.moveDown", { role: name })}
                    onClick={() => reorder(down, { roleId: role.id, direction: "down" })}
                  >
                    <ArrowIcon />
                  </button>
                </span>
              ) : (
                <span className="server-roles-move" />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type EditorTab = "display" | "permissions" | "members";

export function RoleEditor(
  props: {
    actor: RoleActor;
    roles: RoleSummary[];
    members: PresenceUser[];
    role: RoleSummary;
    t: Translate;
    onSelect: (roleId: string) => void;
    onBack: () => void;
    onCreate: () => void;
    onFailed: (error: unknown) => void;
  } & RoleActions
) {
  const { actor, role, t } = props;
  const isEveryone = role.kind === "everyone";
  const tabs: EditorTab[] = isEveryone ? ["permissions"] : ["display", "permissions", "members"];
  const [tab, setTab] = useState<EditorTab>(tabs[0]!);
  const lock = roleEditLock(actor, role);
  const editable = lock === null;
  const tabId = useId();
  const name = roleDisplayName(role, t);

  return (
    <section className="server-role-editor">
      <nav className="server-role-editor-list" aria-label={t("roles.list")}>
        <div className="server-role-editor-list-head">
          <button className="btn btn-ghost server-role-editor-back" type="button" onClick={props.onBack}>
            <ArrowIcon />
            <span>{t("roles.back")}</span>
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label={t("roles.create")}
            title={t("roles.create")}
            onClick={props.onCreate}
          >
            <PlusIcon />
          </button>
        </div>
        {props.roles.map((item) => (
          <button
            key={item.id}
            className="settings-nav-item server-role-editor-item"
            type="button"
            aria-current={item.id === role.id ? true : undefined}
            onClick={() => props.onSelect(item.id)}
          >
            <RoleDot role={item} />
            <span>{roleDisplayName(item, t)}</span>
          </button>
        ))}
      </nav>
      <div className="server-role-editor-body">
        <h3 className="server-role-editor-title">
          <RoleDot role={role} />
          <span>{name}</span>
        </h3>
        {lock ? (
          <p className="muted small" role="note">
            {lock === "ownerOnly" ? t("roles.lockedOwnerOnly") : t("roles.lockedBelowYours")}
          </p>
        ) : null}
        <div className="server-role-editor-tabs" role="tablist" aria-label={name}>
          {tabs.map((item) => (
            <button
              key={item}
              id={`${tabId}-${item}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={tab === item ? `${tabId}-${item}-panel` : undefined}
              tabIndex={tab === item ? 0 : -1}
              className="server-role-editor-tab"
              onClick={() => setTab(item)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault();
                const next =
                  tabs[(tabs.indexOf(item) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!;
                setTab(next);
                document.getElementById(`${tabId}-${next}`)?.focus();
              }}
            >
              {t(
                item === "display"
                  ? "roles.tabDisplay"
                  : item === "permissions"
                    ? "roles.tabPermissions"
                    : "roles.tabMembers"
              )}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${tabId}-${tab}-panel`} aria-labelledby={`${tabId}-${tab}`}>
          {tab === "display" ? <RoleDisplayTab {...props} editable={editable} /> : null}
          {tab === "permissions" ? <RolePermissionsTab {...props} editable={editable} /> : null}
          {tab === "members" ? <RoleMembersTab {...props} /> : null}
        </div>
      </div>
    </section>
  );
}

const colorChoices: ReadonlyArray<RoleSummary["color"]> = [null, ...roleColors];

function RoleDisplayTab(
  props: {
    role: RoleSummary;
    t: Translate;
    editable: boolean;
    onBack: () => void;
    onFailed: (error: unknown) => void;
  } & Pick<RoleActions, "onUpdateRole" | "onDeleteRole">
) {
  const { role, t, editable } = props;
  const shownName = roleDisplayName(role, t);
  const [name, setName] = useState(shownName);
  const [status, setStatus] = useState("");
  const [deleting, setDeleting] = useState(false);
  const nameId = useId();
  // Only a new name resets the field: a colour change or a refresh from another
  // member's edit must not wipe what is being typed.
  useEffect(() => setName(shownName), [role.id, shownName]);
  const update = (change: RoleChange) => {
    setStatus("");
    void props
      .onUpdateRole(role.id, change)
      .then(() => setStatus(t("roles.saved")))
      .catch(props.onFailed);
  };
  return (
    <div className="server-role-display">
      <form
        className="server-role-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed.length < 1 || trimmed.length > roleNameMaxLength) {
            setStatus(t("roles.nameLength"));
            return;
          }
          // A seeded Role saved under its shown name keeps no name of its own,
          // so every reader goes on seeing it in their own language.
          if (role.name === null && trimmed === shownName) return;
          update({ name: trimmed });
        }}
      >
        <label className="form-field" htmlFor={nameId}>
          <span>{t("roles.name")}</span>
          <input
            className="input"
            id={nameId}
            value={name}
            autoComplete="off"
            aria-invalid={name.trim().length < 1 || name.trim().length > roleNameMaxLength}
            disabled={!editable}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!editable}>
          {t("common.save")}
        </button>
      </form>
      <fieldset className="form-field server-role-colors" disabled={!editable}>
        <legend>{t("roles.color")}</legend>
        <div
          role="radiogroup"
          aria-label={t("roles.color")}
          className="server-role-color-options"
          onKeyDown={(event) => {
            // One Tab stop; the arrow keys move between colours and choose, as
            // a radio group does.
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
            if (!step || !editable) return;
            event.preventDefault();
            const index = colorChoices.indexOf(role.color);
            const next = colorChoices[(index + step + colorChoices.length) % colorChoices.length]!;
            update({ color: next });
            event.currentTarget.querySelector<HTMLElement>(`[data-color="${next ?? "none"}"]`)?.focus();
          }}
        >
          {colorChoices.map((color, index) => {
            const label = color ? t(colorNameKeys[index - 1]!) : t("roles.noColor");
            return (
              <button
                key={color ?? "none"}
                data-color={color ?? "none"}
                type="button"
                role="radio"
                aria-checked={role.color === color}
                aria-label={label}
                title={label}
                tabIndex={role.color === color ? 0 : -1}
                className={`server-role-color${color ? "" : " is-none"}`}
                style={color ? ({ "--role-color": color } as CSSProperties) : undefined}
                disabled={!editable}
                onClick={() => update({ color })}
              />
            );
          })}
        </div>
      </fieldset>
      <div className="server-role-switch">
        <span aria-hidden="true">{t("roles.separate")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={role.separate}
          aria-label={t("roles.separate")}
          className={`audio-switch ${role.separate ? "is-on" : ""}`}
          disabled={!editable}
          onClick={() => update({ separate: !role.separate })}
        >
          <span />
        </button>
      </div>
      <p className="small" aria-live="polite">
        {status}
      </p>
      {role.kind === null && editable ? (
        <div className="server-role-danger">
          <button className="btn btn-danger" type="button" onClick={() => setDeleting(true)}>
            <TrashIcon />
            <span>{t("roles.delete")}</span>
          </button>
        </div>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          title={t("roles.deleteTitle", { role: roleDisplayName(role, t) })}
          copy={t("roles.deleteCopy")}
          confirmLabel={t("common.delete")}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void props.onDeleteRole(role.id).then(props.onBack).catch(props.onFailed);
          }}
        />
      ) : null}
    </div>
  );
}

export function RolePermissionsTab(
  props: {
    actor: RoleActor;
    role: RoleSummary;
    t: Translate;
    editable: boolean;
    onFailed: (error: unknown) => void;
  } & Pick<RoleActions, "onUpdateRole">
) {
  const { actor, role, t, editable } = props;
  const [query, setQuery] = useState("");
  const searchId = useId();
  // Toggles in quick succession build on each other, not on the list as it
  // stood when the page last drew; the server's answer resets it.
  const pendingRef = useRef(role.permissions);
  useEffect(() => {
    pendingRef.current = role.permissions;
  }, [role.permissions]);
  const normalized = query.trim().toLocaleLowerCase();
  const shown = serverPermissions.filter(
    (permission) =>
      !normalized ||
      t(`permission.${permission}`).toLocaleLowerCase().includes(normalized) ||
      t(`permission.${permission}Hint`).toLocaleLowerCase().includes(normalized)
  );
  const save = (permissions: Permission[]) => {
    pendingRef.current = permissions;
    void props.onUpdateRole(role.id, { permissions }).catch(props.onFailed);
  };
  return (
    <div className="server-role-permissions">
      {role.kind === "everyone" ? <p className="muted small">{t("roles.everyoneNote")}</p> : null}
      <div className="server-role-permissions-tools">
        <label className="form-field" htmlFor={searchId}>
          <span className="sr-only">{t("roles.searchPermissions")}</span>
          <input
            className="input"
            id={searchId}
            type="search"
            placeholder={t("roles.searchPermissions")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={!editable || role.permissions.length === clearedPermissions(actor, role).length}
          onClick={() => save(clearedPermissions(actor, role))}
        >
          {t("roles.clearPermissions")}
        </button>
      </div>
      {shown.length === 0 ? <p className="muted small">{t("roles.noPermissionMatch")}</p> : null}
      <ul className="server-role-permission-list">
        {shown.map((permission) => {
          const on = role.permissions.includes(permission);
          // Only the owner switches Administrator, on any Role (decision 5), and
          // nobody else switches on a Permission they do not hold themselves.
          // Admin's own Administrator never switches off (ADR-0038).
          const ownerOnly = permission === "administrator" && (actor.role !== "owner" || role.kind === "admin");
          const notHeld = !on && actor.role !== "owner" && !actor.permissions.includes(permission);
          const hintId = `${searchId}-${permission}`;
          return (
            <li key={permission} className="server-role-permission">
              <span className="server-role-permission-copy">
                <strong>{t(`permission.${permission}`)}</strong>
                <span className="muted small" id={hintId}>
                  {t(`permission.${permission}Hint`)}
                  {ownerOnly ? ` ${t("roles.administratorOwnerOnly")}` : notHeld ? ` ${t("roles.notHeld")}` : ""}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={t(`permission.${permission}`)}
                aria-describedby={hintId}
                className={`audio-switch ${on ? "is-on" : ""}`}
                disabled={!editable || ownerOnly || notHeld}
                onClick={() => {
                  const current = pendingRef.current;
                  save(
                    current.includes(permission)
                      ? current.filter((item) => item !== permission)
                      : serverPermissions.filter((item) => item === permission || current.includes(item))
                  );
                }}
              >
                <span />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RoleMembersTab(
  props: {
    actor: RoleActor;
    roles: RoleSummary[];
    members: PresenceUser[];
    role: RoleSummary;
    t: Translate;
    onFailed: (error: unknown) => void;
  } & Pick<RoleActions, "onSetMemberRole">
) {
  const { actor, role, t } = props;
  const [choice, setChoice] = useState("");
  const selectId = useId();
  // The same rule as the member menu's Roles ›: a member is offered only when
  // this Role's row would be unlocked for them there.
  const changeable = (member: PresenceUser) =>
    memberRoleRows(actor, props.roles, member)?.find((row) => row.role.id === role.id)?.lock === null;
  const holders = props.members.filter((member) => !member.isBot && member.roleIds?.includes(role.id));
  const candidates = props.members.filter(
    (member) => !member.isBot && !member.roleIds?.includes(role.id) && changeable(member)
  );
  const set = (userId: string, give: boolean) => {
    void props.onSetMemberRole(userId, role.id, give).catch(props.onFailed);
  };
  return (
    <div className="server-role-members">
      <form
        className="server-role-add-member"
        onSubmit={(event) => {
          event.preventDefault();
          if (!choice) return;
          set(choice, true);
          setChoice("");
        }}
      >
        <label className="form-field" htmlFor={selectId}>
          <span>{t("roles.addMember")}</span>
          <select
            className="input"
            id={selectId}
            value={choice}
            disabled={candidates.length === 0}
            onChange={(event) => setChoice(event.currentTarget.value)}
          >
            <option value="">{t("roles.addMemberChoose")}</option>
            {candidates.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.nickname}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" type="submit" disabled={!choice}>
          <PlusIcon />
          <span>{t("roles.addMember")}</span>
        </button>
      </form>
      {holders.length === 0 ? (
        <p className="muted small">{t("roles.noMembers")}</p>
      ) : (
        <ul className="server-settings-list">
          {holders.map((member) => (
            <li key={member.userId}>
              <MemberRow user={member.nickname} detail={member.mentionCode ? `@${member.mentionCode}` : ""} />
              <button
                className="icon-btn"
                type="button"
                disabled={!changeable(member)}
                aria-label={t("roles.removeMember", { nickname: member.nickname })}
                title={t("roles.removeMember", { nickname: member.nickname })}
                onClick={() => set(member.userId, false)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
