import type { ShellActions } from "./types.js";

type RoleShellActions = Pick<
  ShellActions,
  "onSetMemberRole" | "onCreateRole" | "onUpdateRole" | "onReorderRoles" | "onDeleteRole"
>;

/** The Role actions the shell hands down (ADR-0038), each carried out by the workspace controller. */
export function roleActions(workspace: {
  actions: {
    setMemberRole: RoleShellActions["onSetMemberRole"];
    createRole: RoleShellActions["onCreateRole"];
    updateRole: RoleShellActions["onUpdateRole"];
    reorderRoles: RoleShellActions["onReorderRoles"];
    deleteRole: RoleShellActions["onDeleteRole"];
  };
}): RoleShellActions {
  return {
    onSetMemberRole: workspace.actions.setMemberRole,
    onCreateRole: workspace.actions.createRole,
    onUpdateRole: workspace.actions.updateRole,
    onReorderRoles: workspace.actions.reorderRoles,
    onDeleteRole: workspace.actions.deleteRole
  };
}
