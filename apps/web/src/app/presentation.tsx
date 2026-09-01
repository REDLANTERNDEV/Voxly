import type { ChatMessage,PresenceUser,PublicUser,VoiceForceLeaveReason,VoiceMediaState,VoiceModerationState } from "@voxly/shared";
import type { ReactNode } from "react";
import { CameraIcon,HeadsetIcon,MicIcon,ScreenIcon } from "../components/ui/Icons.js";
import { type LanguageCode,type TranslationKey,type VoiceErrorKey } from "../lib/i18n.js";
import type { ConnectionHealth } from "../lib/useConnectionHealth.js";
import type { VoiceQuality } from "../lib/useVoiceQuality.js";
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

/**
 * What the signal in the dock is reporting, and in which words.
 *
 * Outside a call the only connection a member has is the one to the server, so
 * the round trip to it is the right thing to show. Inside a call it is the
 * wrong path entirely — it stays green through a voice problem, which is how
 * "my ping is fine" came to be offered as evidence that voice was not the
 * fault. In a call the signal reports the media instead, and names the symptom
 * rather than a number, because a member can confirm or deny "the voice is
 * breaking up" and cannot do anything at all with "1.8%".
 */
export function voiceSignalPresentation(
  health: ConnectionHealth,
  quality: VoiceQuality,
  inCall: boolean,
  t: Translate
) {
  if (!inCall || quality.grade === "measuring") {
    return {
      tone: health.quality === "good" ? "good" : health.quality === "poor" ? "poor" : "fair",
      value: health.rttMs === null ? "-- ms" : `${Math.round(health.rttMs)} ms`,
      label: health.rttMs === null
        ? t("connection.measuring")
        : t("connection.latency", { value: Math.round(health.rttMs) })
    };
  }

  const tone = quality.grade === "clear" ? "good" : quality.grade === "unstable" ? "fair" : "poor";
  const reading = quality.reading;
  return {
    tone,
    value: t(`voiceQuality.${quality.grade}` as TranslationKey),
    // The detail is what a member screenshots when they report a problem, so it
    // carries the figures even though the badge itself shows only the verdict.
    label: [
      t(`voiceQuality.symptom.${quality.symptom}` as TranslationKey),
      reading ? t("voiceQuality.detail", {
        loss: reading.lossPercent.toFixed(1),
        gaps: Math.round(reading.concealedMs),
        buffer: Math.round(reading.bufferMs)
      }) : ""
    ].filter(Boolean).join(" · ")
  };
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

/**
 * Voice and RTC failures travel up as translation keys so the sentence is
 * chosen here, where the reader's language is known, rather than in the hook
 * that noticed the failure.
 */
export function voiceErrorMessage(key: VoiceErrorKey | "", t: Translate) {
  return key ? t(key) : "";
}

/**
 * Why voice ended, for a member who did not end it.
 *
 * Every one of these used to be a silent teardown, which left the member
 * unable to tell a call that moved from a call that broke. `joined_another_device`
 * is deliberately worded as a statement of fact rather than an apology — it is
 * the feature working.
 */
export function forceLeaveNoticeKey(reason: VoiceForceLeaveReason): TranslationKey {
  if (reason === "joined_another_device") return "voiceNotice.joinedAnotherDevice";
  if (reason === "joined_another_room") return "voiceNotice.joinedAnotherRoom";
  if (reason === "owner_disconnect") return "voiceNotice.ownerDisconnect";
  if (reason === "server_access_revoked") return "voiceNotice.accessRevoked";
  return "voiceNotice.roomGone";
}

/**
 * Whether the member has silenced themselves — in either direction.
 *
 * The one rule behind two signals: the sentence the dock writes and the colour
 * the button wears. Both ask "can this member be heard, and can they hear", and
 * they were never going to stay in step if each worked it out for itself.
 *
 * Only the member's own doing. An owner's mute is a different sentence with a
 * different remedy, and the controls carry it in their own language.
 */
export function voiceDockSilenced(controls: VoiceControls) {
  return controls.deafen.on || !controls.mic.on;
}

/**
 * The line under the room name: facts, in one order, each said once.
 *
 * It used to read *"Mic muted - 1 connected · Connected"* — the word "connected"
 * twice, meaning two unrelated things, with the second one restating that a
 * working application was working. So the silence state no longer carries the
 * head count, and the link state is only named when it is worth naming.
 *
 * The order is what is wrong first, then who is here, then whether the server
 * can be reached. A member scanning the dock reads left to right and should hit
 * the actionable part immediately.
 */
export function voiceDockStatusLabel(
  controls: VoiceControls,
  connectedCount: number,
  socketState: ShellModel["socketState"],
  t: Translate
) {
  const parts: string[] = [];
  if (controls.deafen.on) parts.push(t("status.deafened"));
  else if (!controls.mic.on) parts.push(t("status.micMuted"));
  parts.push(t("common.connected", { count: connectedCount }));
  // "Connected" beside a working app is noise; a link that is *not* live is the
  // only version of this worth a member's attention.
  if (socketState !== "live") parts.push(connectionLabel(socketState, t));
  return parts.join(" · ");
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
