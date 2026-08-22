import type { ChatMessage,PresenceUser,PublicUser,VoiceMediaState,VoiceModerationState } from "@voxly/shared";
import type { ReactNode } from "react";
import { CameraIcon,HeadsetIcon,MicIcon,ScreenIcon } from "../components/ui/Icons.js";
import { type LanguageCode,type TranslationKey } from "../lib/i18n.js";
import { sidebarVoiceStatusKeys,type VoiceControls } from "../lib/voiceControls.js";
import type { OwnerInvite } from "../types.js";
import type { ShellModel,ThemeChoice,Translate } from "./types.js";

export function activeServerRole(props: Pick<ShellModel, "activeServerId" | "servers">) {
  return props.servers.find((server) => server.id === props.activeServerId)?.role ?? null;
}

export function canInviteToActiveServer(props: Pick<ShellModel, "activeServerId" | "servers">) {
  const server = props.servers.find((item) => item.id === props.activeServerId);
  return Boolean(server && (server.role === "owner" || server.canInvite));
}

/**
 * Owner outranks the delegated invite grant, which outranks a plain member. A
 * Bot is none of those: it is named for what it is, because "User" next to a
 * service account is the one thing this label must never say.
 */
export function memberRoleLabel(user: Pick<PresenceUser, "role" | "canInvite" | "isBot">, t: Translate) {
  if (user.isBot) return t("common.bot");
  if (user.role === "owner") return t("common.owner");
  return user.canInvite ? t("member.inviterRole") : t("common.user");
}

export function includeCurrentPresence(users: PresenceUser[], user: PublicUser) {
  return upsertPresence(users, presenceFromUser(user), user);
}

export function upsertPresence(users: PresenceUser[], next: PresenceUser, currentUser: PublicUser) {
  const withCurrent = users.some((item) => item.userId === currentUser.id) ? users : [presenceFromUser(currentUser), ...users];
  return withCurrent.some((item) => item.userId === next.userId)
    ? withCurrent.map((item) => (item.userId === next.userId ? next : item))
    : [...withCurrent, next];
}

export function presenceFromUser(user: PublicUser, nickname = user.nickname): PresenceUser {
  return { userId: user.id, nickname, role: user.role };
}

export function connectionLabel(state: ShellModel["socketState"], t: Translate) {
  if (state === "live") return t("connection.live");
  if (state === "reconnecting") return t("connection.reconnecting");
  if (state === "offline") return t("connection.offline");
  return t("connection.connecting");
}

export function connectionCopy(state: ShellModel["socketState"], t: Translate) {
  if (state === "live") return t("connection.liveCopy");
  if (state === "reconnecting") return t("connection.reconnectingCopy");
  if (state === "offline") return t("connection.offlineCopy");
  return t("connection.connectingCopy");
}

export function statusClass(status: "ready" | "loading" | "valid" | "danger") {
  if (status === "loading") return "is-loading";
  if (status === "danger") return "is-danger";
  return "is-valid";
}

export function inviteStatusTitle(status: "ready" | "loading" | "valid" | "danger", t: Translate) {
  if (status === "loading") return t("invite.checking");
  if (status === "danger") return t("invite.unavailable");
  if (status === "valid") return t("invite.accepted");
  return t("invite.ready");
}

export function inviteAvailabilityCopy(preview: { expiresAt: string | null; remainingUses: number | null } | null, language: LanguageCode, t: Translate) {
  if (!preview) return t("invite.checking");
  const uses = preview.remainingUses === null
    ? t("invite.unlimitedUses")
    : t("invite.remainingUses", { count: preview.remainingUses });
  return `${uses} · ${formatShortDate(preview.expiresAt, language, t)}`;
}

export function isInviteRevocable(invite: OwnerInvite) {
  if (invite.revokedAt || (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now())) return false;
  return invite.maxUses === null || invite.usedCount < invite.maxUses;
}

export function inviteLifecycleKey(invite: OwnerInvite): TranslationKey {
  if (invite.revokedAt) return "common.revoked";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return "invite.expired";
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return "invite.exhausted";
  return "common.active";
}

export function extractInviteToken(value: string) {
  const trimmed = value.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

export function formatShortDate(value: string | null, language: LanguageCode, t: Translate) {
  if (!value) return t("common.noExpiry");
  return new Intl.DateTimeFormat(language, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function themeLabel(theme: ThemeChoice, t: Translate) {
  if (theme === "light") return t("common.light");
  if (theme === "dark") return t("common.dark");
  return t("common.auto");
}

export function voiceDockStatusLabel(controls: VoiceControls, connectedCount: number, t: Translate) {
  if (controls.deafen.on) {
    return t("status.deafenedOutputOff");
  }

  if (!controls.mic.on) {
    return t("status.micMuted", { count: connectedCount });
  }

  return t("common.connected", { count: connectedCount });
}

export function voiceStatusItems(media: VoiceMediaState | undefined, moderation: VoiceModerationState | undefined, t: Translate) {
  if (!media) return [];
  const items: Array<{ label: string; icon: ReactNode; tone: "danger" | "live" | "online" | "neutral" }> = [];
  if (moderation?.deafened) {
    items.push({ label: t("member.ownerDeafened"), icon: <HeadsetIcon off />, tone: "danger" });
  }
  if (moderation?.muted) {
    items.push({ label: t("member.ownerMuted"), icon: <MicIcon off />, tone: "danger" });
  }
  const selfStatuses = sidebarVoiceStatusKeys(media, moderation);
  if (selfStatuses.includes("deafened")) {
    items.push({ label: t("common.deafened"), icon: <HeadsetIcon off />, tone: "neutral" });
  }
  if (selfStatuses.includes("muted")) {
    items.push({ label: t("common.muted"), icon: <MicIcon off />, tone: "neutral" });
  }
  if (media.screen) {
    items.push({ label: t("status.screenSharing"), icon: <ScreenIcon off={false} />, tone: "live" });
  } else if (media.camera) {
    items.push({ label: t("status.cameraOn"), icon: <CameraIcon off={false} />, tone: "online" });
  }
  // Speaking is deliberately absent. It is the one status that changes several
  // times a sentence, and a chip appearing and disappearing at that rate reads
  // as flicker; the avatar ring on the row carries it continuously instead.
  return items;
}

export function voiceMembersForRoom(props: Pick<ShellModel,
  "activeVoiceRoomId" | "controls" | "currentNickname" | "user" |
  "voiceModeration" | "voiceSnapshots"
>, roomId: string) {
  if (props.voiceSnapshots[roomId]) {
    return props.voiceSnapshots[roomId].members;
  }
  if (props.activeVoiceRoomId === roomId) {
    return [{
      user: presenceFromUser(props.user, props.currentNickname),
      media: {
        mic: props.controls.mic.on,
        camera: props.controls.camera.on,
        screen: props.controls.screenShare.on,
        deafened: props.controls.deafen.on,
        speaking: false
      },
      moderation: props.voiceModeration
    }];
  }
  return [];
}

export function upsertMessage(messages: ChatMessage[], next: ChatMessage) {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next].slice(-200);
}

export function initial(value: string) {
  return value.trim().charAt(0).toUpperCase() || "V";
}
