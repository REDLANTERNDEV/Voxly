import { afkTimeoutOptions,DEFAULT_AFK_TIMEOUT_MINUTES,isAfkTimeoutMinutes,type AfkTimeoutMinutes } from "@voxly/shared";
import { useEffect,useState } from "react";
import type { Translate } from "../../app/types.js";
import { EditIcon,EyeIcon,PlusIcon,TrashIcon } from "../../components/ui/Icons.js";
import { maskSecretLink } from "../../lib/invites.js";
import type { ServerSummary } from "../../types.js";
export function SecretLinkDisplay({ value, t }: { value: string; t: Translate }) {
  const [revealed, setRevealed] = useState(false);
  const label = revealed ? t("owner.hideLink") : t("owner.revealLink");
  return (
    <div className="secret-link-display">
      <span className="mono">{revealed ? value : maskSecretLink(value)}</span>
      <button className="secret-link-toggle" type="button" aria-label={label} title={label} aria-pressed={revealed} onClick={() => setRevealed((current) => !current)}>
        <EyeIcon off={revealed} />
      </button>
    </div>
  );
}

export function OwnerServerContext({
  activeServerId,
  servers,
  t,
  onSelect,
  onCreate,
  onRename,
  onSetAfkTimeout,
  onRequestDelete
}: {
  activeServerId: string;
  servers: ServerSummary[];
  t: Translate;
  onSelect: (serverId: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (name: string) => Promise<ServerSummary>;
  onSetAfkTimeout: (minutes: AfkTimeoutMinutes) => Promise<void>;
  onRequestDelete: () => void;
}) {
  const [afkStatus, setAfkStatus] = useState("");
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [renameName, setRenameName] = useState("");
  const [renameStatus, setRenameStatus] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const ownerServers = servers.filter((server) => server.role === "owner");
  const activeServer = ownerServers.find((server) => server.id === activeServerId);

  useEffect(() => {
    setRenameName(activeServer?.name ?? "");
    setRenameStatus("");
  }, [activeServer?.id, activeServer?.name]);

  return (
    <section className="owner-server-context" aria-labelledby="ownerServerContextTitle">
      <div className="owner-server-context-copy">
        <p className="label">{t("owner.serverContextLabel")}</p>
        <h2 id="ownerServerContextTitle">{t("owner.serverContextTitle")}</h2>
        <p className="muted small">{t("owner.serverContextCopy")}</p>
      </div>
      <label className="form-field owner-server-select" htmlFor="ownerServerSelect">
        <span>{t("owner.targetServer")}</span>
        <select className="input" id="ownerServerSelect" value={activeServerId} onChange={(event) => onSelect(event.currentTarget.value)}>
          {ownerServers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
        </select>
      </label>
      <div className="owner-server-actions">
        <button className="btn btn-primary" type="button" aria-expanded={showCreate} aria-controls="owner-server-create-form" onClick={() => {
          setShowCreate((current) => !current);
          setError("");
        }}><PlusIcon /><span>{t("server.create")}</span></button>
        <button className="btn btn-danger" type="button" disabled={ownerServers.length <= 1} onClick={onRequestDelete}><TrashIcon /><span>{t("server.delete")}</span></button>
      </div>
      <form className="owner-server-rename-form" onSubmit={(event) => {
        event.preventDefault();
        const nextName = renameName.trim();
        if (nextName.length < 2 || nextName.length > 64) {
          setRenameStatus(t("server.nameLength"));
          return;
        }
        setIsRenaming(true);
        setRenameStatus("");
        void onRename(nextName)
          .then(() => setRenameStatus(t("server.renamed")))
          .catch(() => setRenameStatus(t("server.renameFailed")))
          .finally(() => setIsRenaming(false));
      }}>
        <label className="form-field owner-server-rename-field" htmlFor="ownerServerRename">
          <span>{t("server.rename")}</span>
          <input
            className="input"
            id="ownerServerRename"
            name="ownerServerRename"
            value={renameName}
            minLength={2}
            maxLength={64}
            autoComplete="off"
            onChange={(event) => setRenameName(event.currentTarget.value)}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={isRenaming || renameName.trim() === activeServer?.name}>
          <EditIcon />
          <span>{t("common.save")}</span>
        </button>
        <p className="muted small owner-server-rename-copy">{t("server.renameCopy")}</p>
        <p className="small owner-server-rename-status" aria-live="polite">{renameStatus}</p>
      </form>
      <label className="form-field owner-server-afk" htmlFor="ownerServerAfkTimeout">
        <span>{t("owner.afkTimeout")}</span>
        <select
          className="input"
          id="ownerServerAfkTimeout"
          value={activeServer?.afkTimeoutMinutes ?? DEFAULT_AFK_TIMEOUT_MINUTES}
          onChange={(event) => {
            const minutes = Number(event.currentTarget.value);
            if (!isAfkTimeoutMinutes(minutes)) return;
            setAfkStatus("");
            void onSetAfkTimeout(minutes).catch(() => setAfkStatus(t("owner.afkTimeoutFailed")));
          }}
        >
          {afkTimeoutOptions.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes < 60
                ? t("owner.afkTimeoutMinutes", { count: minutes })
                : t("owner.afkTimeoutHours", { count: minutes / 60 })}
            </option>
          ))}
        </select>
        <span className="muted small">{t("owner.afkTimeoutHint")}</span>
        <span className="small" aria-live="polite">{afkStatus}</span>
      </label>
      {showCreate ? <form className="owner-server-create-form" id="owner-server-create-form" onSubmit={(event) => {
        event.preventDefault();
        const nextName = name.trim();
        if (!nextName) {
          setError(t("server.nameRequired"));
          return;
        }
        setIsCreating(true);
        setError("");
        void onCreate(nextName)
          .then(() => {
            setName("");
            setShowCreate(false);
          })
          .catch(() => setError(t("server.createFailed")))
          .finally(() => setIsCreating(false));
      }}>
        <label className="form-field" htmlFor="ownerServerName"><span>{t("server.name")}</span><input className="input" id="ownerServerName" name="ownerServerName" value={name} onChange={(event) => setName(event.currentTarget.value)} autoComplete="off" maxLength={64} /></label>
        <button className="btn btn-primary" type="submit" disabled={isCreating}><span>{isCreating ? t("server.creating") : t("server.create")}</span></button>
        {error ? <p className="error-text" aria-live="polite">{error}</p> : null}
      </form> : null}
    </section>
  );
}
