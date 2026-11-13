/**
 * How one Audit log line reads (ADR-0039). Pure, so the sentence for every
 * action is tested in both languages without rendering anything.
 *
 * Each action has one sentence template with named slots — `{actor}`,
 * `{target}`, `{name}`, `{room}` — and the slots are filled here, so the
 * component can draw the names in bold without parsing a finished sentence.
 */

import type { AuditLogAction, AuditLogEntry, AuditLogPerson, Permission } from "@voxly/shared";
import type { TranslationKey } from "./i18n.js";

export type AuditTranslate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** The sentence key for each action. */
export const auditSentenceKeys = {
  "server.created": "audit.serverCreated",
  "server.renamed": "audit.serverRenamed",
  "server.afkTimeoutChanged": "audit.serverAfkChanged",
  "server.welcomeChanged": "audit.serverWelcomeChanged",
  "room.created": "audit.roomCreated",
  "room.renamed": "audit.roomRenamed",
  "room.accessChanged": "audit.roomAccessChanged",
  "room.deleted": "audit.roomDeleted",
  "category.created": "audit.categoryCreated",
  "category.renamed": "audit.categoryRenamed",
  "category.deleted": "audit.categoryDeleted",
  "role.created": "audit.roleCreated",
  "role.updated": "audit.roleUpdated",
  "role.reordered": "audit.roleReordered",
  "role.deleted": "audit.roleDeleted",
  "role.given": "audit.roleGiven",
  "role.removed": "audit.roleRemoved",
  "member.nickname_updated": "audit.nicknameChanged",
  "member.kick": "audit.memberKicked",
  "member.ban": "audit.memberBanned",
  "member.unban": "audit.memberUnbanned",
  "member.voice_moderation_updated": "audit.voiceModerated",
  "voice.disconnected": "audit.voiceDisconnected",
  "voice.moved": "audit.voiceMoved",
  "message.deleted": "audit.messageDeleted",
  "message.pinned": "audit.messagePinned",
  "message.unpinned": "audit.messageUnpinned",
  "invite.created": "audit.inviteCreated",
  "invite.revoked": "audit.inviteRevoked",
  "bot.created": "audit.botCreated"
} as const satisfies Record<AuditLogAction, TranslationKey>;

/** The filter's label for each action. */
export const auditFilterKeys = {
  "server.created": "auditFilter.serverCreated",
  "server.renamed": "auditFilter.serverRenamed",
  "server.afkTimeoutChanged": "auditFilter.serverAfkChanged",
  "server.welcomeChanged": "auditFilter.serverWelcomeChanged",
  "room.created": "auditFilter.roomCreated",
  "room.renamed": "auditFilter.roomRenamed",
  "room.accessChanged": "auditFilter.roomAccessChanged",
  "room.deleted": "auditFilter.roomDeleted",
  "category.created": "auditFilter.categoryCreated",
  "category.renamed": "auditFilter.categoryRenamed",
  "category.deleted": "auditFilter.categoryDeleted",
  "role.created": "auditFilter.roleCreated",
  "role.updated": "auditFilter.roleUpdated",
  "role.reordered": "auditFilter.roleReordered",
  "role.deleted": "auditFilter.roleDeleted",
  "role.given": "auditFilter.roleGiven",
  "role.removed": "auditFilter.roleRemoved",
  "member.nickname_updated": "auditFilter.nicknameChanged",
  "member.kick": "auditFilter.memberKicked",
  "member.ban": "auditFilter.memberBanned",
  "member.unban": "auditFilter.memberUnbanned",
  "member.voice_moderation_updated": "auditFilter.voiceModerated",
  "voice.disconnected": "auditFilter.voiceDisconnected",
  "voice.moved": "auditFilter.voiceMoved",
  "message.deleted": "auditFilter.messageDeleted",
  "message.pinned": "auditFilter.messagePinned",
  "message.unpinned": "auditFilter.messageUnpinned",
  "invite.created": "auditFilter.inviteCreated",
  "invite.revoked": "auditFilter.inviteRevoked",
  "bot.created": "auditFilter.botCreated"
} as const satisfies Record<AuditLogAction, TranslationKey>;

/** A piece of a sentence: plain text, or a name to draw in bold. */
export type AuditSentencePart = { text: string; strong: boolean };

function personName(person: AuditLogPerson | null, t: AuditTranslate, fallback: TranslationKey) {
  if (!person) return t(fallback);
  return person.nickname ?? t("common.deletedMember");
}

function roleName(entry: AuditLogEntry, t: AuditTranslate) {
  const { name, roleKind } = entry.details;
  if (name) return name;
  return t(roleKind === "everyone" ? "role.everyone" : roleKind === "admin" ? "role.admin" : "role.recruiter");
}

function roomName(entry: AuditLogEntry, room: string | undefined, t: AuditTranslate) {
  const { roomKind, roomHidden } = entry.details;
  if (roomHidden) return t("audit.privateChannel");
  if (!room) return t("audit.aChannel");
  return roomKind === "voice" ? room : `#${room}`;
}

/** The slot values one line fills its sentence with. */
export function auditSlots(entry: AuditLogEntry, t: AuditTranslate): Record<string, string> {
  const { details } = entry;
  const slots: Record<string, string> = {
    actor: personName(entry.actor, t, "audit.someone"),
    target: personName(entry.target, t, "audit.someone"),
    room: roomName(entry, details.room, t),
    previousRoom: roomName(entry, details.previousRoom, t),
    name: details.name ?? "",
    previousName: details.previousName ?? ""
  };
  if (entry.action.startsWith("role.") && entry.action !== "role.reordered") slots.name = roleName(entry, t);
  if (entry.action === "server.afkTimeoutChanged") {
    slots.name =
      details.minutes === null || details.minutes === undefined
        ? t("audit.afkNever")
        : t("audit.minutes", { count: details.minutes });
  }
  if (entry.action === "member.nickname_updated" && !details.name) slots.name = t("audit.nicknameReset");
  return slots;
}

/** Which sentence an action uses; a few pick a variant by what they recorded. */
export function auditSentenceKey(entry: AuditLogEntry): TranslationKey {
  const { action, details } = entry;
  switch (action) {
    case "member.nickname_updated":
      return entry.actor && entry.actor.userId === entry.target?.userId
        ? "audit.nicknameChangedOwn"
        : "audit.nicknameChanged";
    case "server.welcomeChanged":
      if (details.enabled === undefined) break;
      return details.enabled ? "audit.serverWelcomeOn" : "audit.serverWelcomeOff";
    case "room.accessChanged":
      if (details.enabled === undefined) break;
      return details.enabled ? "audit.roomMadePrivate" : "audit.roomMadePublic";
    case "member.voice_moderation_updated":
      if (details.muted === undefined) break;
      return details.muted || details.deafened ? "audit.voiceModerationOn" : "audit.voiceModerationOff";
    case "server.renamed":
      return details.previousName ? "audit.serverRenamedFrom" : "audit.serverRenamed";
    case "category.renamed":
      return details.previousName ? "audit.categoryRenamedFrom" : "audit.categoryRenamed";
    case "room.renamed":
      return details.previousRoom && !details.roomHidden ? "audit.roomRenamedFrom" : "audit.roomRenamed";
  }
  return auditSentenceKeys[action];
}

/**
 * The line as parts, slots in bold. The template is read unfilled so a slot
 * can be told apart from the words around it in either language.
 */
export function auditSentence(entry: AuditLogEntry, t: AuditTranslate): AuditSentencePart[] {
  const template = t(auditSentenceKey(entry));
  const slots = auditSlots(entry, t);
  return template
    .split(/(\{[a-zA-Z]+\})/)
    .filter((piece) => piece.length > 0)
    .map((piece) => {
      const slot = /^\{([a-zA-Z]+)\}$/.exec(piece)?.[1];
      return slot !== undefined && slot in slots
        ? { text: slots[slot] ?? "", strong: true }
        : { text: piece, strong: false };
    });
}

/** The extra lines a Role edit shows under its sentence: what changed, and which Permissions moved. */
export function auditRoleChanges(
  entry: AuditLogEntry,
  t: AuditTranslate,
  permissionLabel: (permission: Permission) => string
) {
  if (entry.action !== "role.updated") return [];
  const lines: string[] = [];
  const { changes = [], added = [], removed = [], previousName } = entry.details;
  if (changes.includes("name") && previousName) lines.push(t("audit.changeName", { name: previousName }));
  if (changes.includes("color")) lines.push(t("audit.changeColor"));
  if (changes.includes("separate")) lines.push(t("audit.changeSeparate"));
  if (added.length > 0) lines.push(t("audit.permissionsAdded", { list: added.map(permissionLabel).join(", ") }));
  if (removed.length > 0) lines.push(t("audit.permissionsRemoved", { list: removed.map(permissionLabel).join(", ") }));
  return lines;
}
