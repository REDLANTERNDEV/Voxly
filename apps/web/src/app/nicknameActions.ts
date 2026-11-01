import type { PresenceUser } from "@voxly/shared";
import type { ShellActions } from "./types.js";

/**
 * Nickname changes, applied from the HTTP acknowledgement to the directory (by
 * the workspace controller) and to loaded chat here. Realtime brings the same
 * update to every other member of that server.
 */
export function nicknameActions(
  workspace: {
    activeServerId: string;
    actions: {
      updateMemberNickname: (userId: string, nickname: string) => Promise<PresenceUser>;
      updateOwnNickname: (serverId: string, nickname: string | null) => Promise<PresenceUser>;
    };
  },
  chat: { applyMemberRename: (serverId: string, user: PresenceUser) => void }
): Pick<ShellActions, "onUpdateMemberNickname" | "onUpdateOwnNickname"> {
  return {
    onUpdateMemberNickname: async (userId, nickname) => {
      const updated = await workspace.actions.updateMemberNickname(userId, nickname);
      chat.applyMemberRename(workspace.activeServerId, updated);
      return updated;
    },
    onUpdateOwnNickname: async (serverId, nickname) => {
      const updated = await workspace.actions.updateOwnNickname(serverId, nickname);
      chat.applyMemberRename(serverId, updated);
      return updated;
    }
  };
}
