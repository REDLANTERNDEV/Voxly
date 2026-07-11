import type { ServerSummary } from "../types.js";

interface InviteTargetSelectorProps {
  activeServerId: string;
  servers: ServerSummary[];
  label: string;
  onSelect(serverId: string): void;
}

export function InviteTargetSelector(props: InviteTargetSelectorProps) {
  const ownerServers = props.servers.filter((server) => server.role === "owner");
  return (
    <label className="form-field" htmlFor="inviteServer">
      <span>{props.label}</span>
      <select className="input" id="inviteServer" name="inviteServer" value={props.activeServerId} onChange={(event) => props.onSelect(event.currentTarget.value)}>
        {ownerServers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
      </select>
    </label>
  );
}
