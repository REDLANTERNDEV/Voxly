import { useState, type ReactNode } from "react";
import type { ServerSummary } from "../types.js";

interface ServerSwitcherProps {
  activeServerId: string;
  servers: ServerSummary[];
  canCreate: boolean;
  createIcon: ReactNode;
  labels: {
    switcher: string;
    server: string;
    create: string;
    creating: string;
    serverName: string;
    nameRequired: string;
    createFailed: string;
  };
  onSelect(serverId: string): Promise<void>;
  onCreate(name: string): Promise<void>;
}

export function ServerSwitcher(props: ServerSwitcherProps) {
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  return (
    <section className="server-switcher" aria-label={props.labels.switcher}>
      <label className="form-field" htmlFor="serverSelect">
        <span className="label">{props.labels.server}</span>
        <select
          className="input"
          id="serverSelect"
          value={props.activeServerId}
          onChange={(event) => { void props.onSelect(event.currentTarget.value); }}
        >
          {props.servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
        </select>
      </label>
      {props.canCreate ? (
        <div className="server-create-control">
          <button className="btn btn-ghost full-width" type="button" aria-expanded={showCreate} aria-controls="server-create-form" onClick={() => setShowCreate((current) => !current)}>{props.createIcon}<span>{props.labels.create}</span></button>
          {showCreate ? <form id="server-create-form" onSubmit={(event) => {
            event.preventDefault();
            const nextName = name.trim();
            if (!nextName) {
              setError(props.labels.nameRequired);
              return;
            }
            setIsCreating(true);
            setError("");
            void props.onCreate(nextName)
              .then(() => { setName(""); setShowCreate(false); })
              .catch(() => setError(props.labels.createFailed))
              .finally(() => setIsCreating(false));
          }}>
            <label className="form-field" htmlFor="serverName"><span>{props.labels.serverName}</span><input className="input" id="serverName" name="serverName" value={name} onChange={(event) => setName(event.currentTarget.value)} autoComplete="off" maxLength={64} /></label>
            <p className="error-text" aria-live="polite">{error}</p>
            <button className="btn btn-primary" type="submit" disabled={isCreating}><span>{isCreating ? props.labels.creating : props.labels.create}</span></button>
          </form> : null}
        </div>
      ) : null}
    </section>
  );
}
