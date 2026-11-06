import type { RoleSummary } from "@voxly/shared";
import type { CSSProperties } from "react";
import type { Translate } from "../../app/types.js";
import { roleDisplayName } from "../../lib/roles.js";

/**
 * A member's Roles as small labels, highest first (ADR-0038, design decision
 * 13): a colour dot and the Role's name, so colour is never the only signal.
 */
export function RoleLabels({ roles, t }: { roles: readonly RoleSummary[]; t: Translate }) {
  if (roles.length === 0) return null;
  return (
    <ul className="role-labels" aria-label={t("member.roles")}>
      {roles.map((role) => (
        <li key={role.id} className="role-label">
          <span
            className={`member-role-dot${role.color ? "" : " is-plain"}`}
            aria-hidden="true"
            style={role.color ? ({ "--role-color": role.color } as CSSProperties) : undefined}
          />
          <span>{roleDisplayName(role, t)}</span>
        </li>
      ))}
    </ul>
  );
}
