import type { ServerSummary } from "../types.js";

interface ServerSwitcherProps {
  activeServerId: string;
  servers: ServerSummary[];
  labels: {
    switcher: string;
    server: string;
  };
  onSelect(serverId: string): Promise<void>;
}

export function ServerSwitcher(props: ServerSwitcherProps) {
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
    </section>
  );
}
