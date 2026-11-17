import {
  afkTimeoutOptions,
  DEFAULT_AFK_TIMEOUT_MINUTES,
  isAfkTimeoutMinutes,
  type AfkTimeoutMinutes,
  type RoomSummary,
  type ServerWelcomeSettings
} from "@voxly/shared";
import { useEffect, useState, type RefObject } from "react";
import type { Translate } from "../../app/types.js";
import { EyeIcon, PlusIcon } from "../../components/ui/Icons.js";
import { UnsavedChangesBar, useUnsavedChanges } from "../../components/ui/UnsavedChangesBar.js";
import { maskSecretLink } from "../../lib/invites.js";
import type { ServerSummary } from "../../types.js";
export function SecretLinkDisplay({ value, t }: { value: string; t: Translate }) {
  const [revealed, setRevealed] = useState(false);
  const label = revealed ? t("owner.hideLink") : t("owner.revealLink");
  return (
    <div className="secret-link-display">
      <span className="mono">{revealed ? value : maskSecretLink(value)}</span>
      <button
        className="secret-link-toggle"
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={revealed}
        onClick={() => setRevealed((current) => !current)}
      >
        <EyeIcon off={revealed} />
      </button>
    </div>
  );
}

/** What leaving the Overview has to ask first; the window holds the ref. */
export interface UnsavedGuard {
  dirty: boolean;
  alert: () => void;
}

interface OverviewDraft {
  name?: string;
  afkTimeoutMinutes?: AfkTimeoutMinutes;
  welcomeNotices?: boolean;
  welcomeRoomId?: string | null;
}

/**
 * One Server's name, AFK timeout and Welcome notice: Server settings ›
 * Overview, on Manage server (ADR-0038). The server re-checks every save.
 *
 * Every field is a draft until the shared Save/Reset bar saves it, the way the
 * Profile dialog works. Only a field the member touched is held: the rest keep
 * following the server, so another manager's change is not hidden behind a
 * stale value. While anything is unsaved, the window refuses to be left.
 */
export function ServerOverviewSettings({
  server,
  t,
  onRename,
  onSetAfkTimeout,
  textRooms,
  onSetWelcome,
  guardRef
}: {
  server: ServerSummary;
  t: Translate;
  onRename: (name: string) => Promise<ServerSummary>;
  onSetAfkTimeout: (minutes: AfkTimeoutMinutes) => Promise<void>;
  /** The Server's text channels, in sidebar order. */
  textRooms: RoomSummary[];
  onSetWelcome: (settings: ServerWelcomeSettings) => Promise<void>;
  guardRef?: RefObject<UnsavedGuard | null>;
}) {
  const [draft, setDraft] = useState<OverviewDraft>({});
  const [failures, setFailures] = useState<{ name?: string; afk?: string; welcome?: string }>({});
  const [saving, setSaving] = useState(false);
  const { barRef, blocked, setBlocked, alertUnsaved } = useUnsavedChanges();

  // Drafts belong to one Server.
  useEffect(() => {
    setDraft({});
    setFailures({});
    setBlocked(false);
  }, [server.id, setBlocked]);

  const savedAfk = server.afkTimeoutMinutes ?? DEFAULT_AFK_TIMEOUT_MINUTES;
  const name = draft.name ?? server.name;
  const afkTimeoutMinutes = draft.afkTimeoutMinutes ?? savedAfk;
  const welcomeNotices = draft.welcomeNotices ?? server.welcomeNotices;
  const welcomeRoomId = draft.welcomeRoomId !== undefined ? draft.welcomeRoomId : server.welcomeRoomId;

  const nameChanged = name.trim() !== server.name;
  const afkChanged = afkTimeoutMinutes !== savedAfk;
  const welcomeChanged = welcomeNotices !== server.welcomeNotices || welcomeRoomId !== server.welcomeRoomId;
  const dirty = nameChanged || afkChanged || welcomeChanged;
  const nameInvalid = nameChanged && (name.trim().length < 2 || name.trim().length > 64);

  if (guardRef) guardRef.current = { dirty, alert: alertUnsaved };
  useEffect(
    () => () => {
      if (guardRef) guardRef.current = null;
    },
    [guardRef]
  );

  const edit = (change: OverviewDraft) => setDraft((current) => ({ ...current, ...change }));

  const reset = () => {
    setDraft({});
    setFailures({});
    setBlocked(false);
  };

  const save = async () => {
    if (!dirty || nameInvalid) return;
    setSaving(true);
    setFailures({});
    const nextFailures: typeof failures = {};
    const saved: Array<keyof OverviewDraft> = [];
    await Promise.all([
      nameChanged
        ? onRename(name.trim())
            .then(() => saved.push("name"))
            .catch(() => (nextFailures.name = t("server.renameFailed")))
        : null,
      afkChanged
        ? onSetAfkTimeout(afkTimeoutMinutes)
            .then(() => saved.push("afkTimeoutMinutes"))
            .catch(() => (nextFailures.afk = t("owner.afkTimeoutFailed")))
        : null,
      welcomeChanged
        ? onSetWelcome({ welcomeNotices, welcomeRoomId })
            .then(() => saved.push("welcomeNotices", "welcomeRoomId"))
            .catch(() => (nextFailures.welcome = t("owner.welcomeFailed")))
        : null
    ]);
    // A saved field follows the server again; a failed one stays a draft.
    setDraft((current) => {
      const next = { ...current };
      for (const key of saved) delete next[key];
      return next;
    });
    setFailures(nextFailures);
    if (Object.keys(nextFailures).length === 0) setBlocked(false);
    setSaving(false);
  };

  return (
    <div className="owner-server-context">
      <section className="owner-current-server" aria-labelledby="ownerServerContextTitle">
        <div className="owner-server-context-copy">
          <h2 id="ownerServerContextTitle">{t("server.current", { server: server.name })}</h2>
          <p className="muted small">{t("server.currentCopy")}</p>
        </div>
        <div className="owner-server-rename-form">
          <label className="form-field owner-server-rename-field" htmlFor="ownerServerRename">
            <span>{t("server.rename")}</span>
            <input
              className="input"
              id="ownerServerRename"
              name="ownerServerRename"
              value={name}
              minLength={2}
              maxLength={64}
              autoComplete="off"
              aria-invalid={nameInvalid}
              onChange={(event) => edit({ name: event.currentTarget.value })}
            />
          </label>
          <p className="muted small owner-server-rename-copy">{t("server.renameCopy")}</p>
          <p className="small owner-server-rename-status" aria-live="polite">
            {nameInvalid ? t("server.nameLength") : (failures.name ?? "")}
          </p>
        </div>
        <label className="form-field owner-server-afk" htmlFor="ownerServerAfkTimeout">
          <span>{t("owner.afkTimeout")}</span>
          <select
            className="input"
            id="ownerServerAfkTimeout"
            value={afkTimeoutMinutes}
            onChange={(event) => {
              const minutes = Number(event.currentTarget.value);
              if (isAfkTimeoutMinutes(minutes)) edit({ afkTimeoutMinutes: minutes });
            }}
          >
            {afkTimeoutOptions.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60
                  ? t("owner.afkTimeoutMinutes", { count: minutes })
                  : minutes === 60
                    ? t("owner.afkTimeoutOneHour")
                    : t("owner.afkTimeoutHours", { count: minutes / 60 })}
              </option>
            ))}
          </select>
          <span className="muted small">{t("owner.afkTimeoutHint")}</span>
          <span className="small" aria-live="polite">
            {failures.afk ?? ""}
          </span>
        </label>
        <fieldset className="form-field owner-server-welcome">
          <legend>{t("owner.welcomeNotices")}</legend>
          <label className="owner-server-welcome-toggle">
            <input
              type="checkbox"
              checked={welcomeNotices}
              onChange={(event) => edit({ welcomeNotices: event.currentTarget.checked })}
            />
            <span>{t("owner.welcomeNoticesHint")}</span>
          </label>
          <label className="owner-server-welcome-room" htmlFor="ownerServerWelcomeRoom">
            <span>{t("owner.welcomeRoom")}</span>
            <select
              className="input"
              id="ownerServerWelcomeRoom"
              disabled={!welcomeNotices}
              value={welcomeRoomId ?? ""}
              onChange={(event) => edit({ welcomeRoomId: event.currentTarget.value || null })}
            >
              <option value="">{t("owner.welcomeRoomTop")}</option>
              {/* A Welcome notice in a channel the newcomer cannot read greets nobody (ADR-0037). */}
              {textRooms
                .filter((room) => !room.isPrivate)
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    # {room.name}
                  </option>
                ))}
            </select>
          </label>
          <span className="small" aria-live="polite">
            {failures.welcome ?? ""}
          </span>
        </fieldset>
      </section>
      <UnsavedChangesBar
        barRef={barRef}
        className="server-settings-unsaved"
        dirty={dirty}
        blocked={blocked}
        blockedMessage={t("serverSettings.unsavedBlocked")}
        saving={saving}
        canSave={!nameInvalid}
        t={t}
        onReset={reset}
        onSave={() => void save()}
      />
    </div>
  );
}

/** A new Server, separate from every existing one: the owner panel's installation overview. */
export function CreateServerSection({ t, onCreate }: { t: Translate; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="owner-new-server" aria-labelledby="ownerServerCreateTitle">
      <h2 id="ownerServerCreateTitle">{t("server.createNew")}</h2>
      <p className="muted small">{t("server.createCopy")}</p>
      <form
        className="owner-server-create-form"
        id="owner-server-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          const nextName = name.trim();
          if (nextName.length < 2 || nextName.length > 64) {
            setError(t("server.nameLength"));
            return;
          }
          setIsCreating(true);
          setError("");
          void onCreate(nextName)
            .then(() => {
              setName("");
            })
            .catch(() => setError(t("server.createFailed")))
            .finally(() => setIsCreating(false));
        }}
      >
        <label className="form-field" htmlFor="ownerServerName">
          <span>{t("server.name")}</span>
          <input
            className="input"
            id="ownerServerName"
            name="ownerServerName"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoComplete="off"
            maxLength={64}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={isCreating}>
          <PlusIcon />
          <span>{isCreating ? t("server.creating") : t("server.create")}</span>
        </button>
        {error ? (
          <p className="error-text" aria-live="polite">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
