import type { RoleSummary } from "@voxly/shared";
import { createContext, useContext } from "react";

/**
 * The active Server's Roles, highest first, for what Roles look like deep in
 * the tree — a name's colour, a card's labels — without threading them through
 * every message row (ADR-0038, design decisions 12 and 13).
 */
export const ServerRolesContext = createContext<readonly RoleSummary[]>([]);

export function useServerRoles() {
  return useContext(ServerRolesContext);
}
