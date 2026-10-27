import type { Translate } from "../app/types.js";
import type { InviteTrailPerson, OwnerInvite } from "../types.js";

/** Mirrors the server's retention for a past invite nobody joined through (ADR-0034). */
export const unusedPastInviteRetentionDays = 30;
const dayMs = 24 * 60 * 60 * 1000;

/** Active invites stay in the main list; expired, used-up and revoked ones are past. */
export function partitionInvites(invites: OwnerInvite[]) {
  const active: OwnerInvite[] = [];
  const past: OwnerInvite[] = [];
  for (const invite of invites) (invite.inactiveSince === null ? active : past).push(invite);
  return { active, past };
}

/**
 * Whole days until a past invite is removed, or null when it never will be:
 * still active, or somebody joined through it and it is now the trail.
 */
export function daysUntilRemoval(invite: OwnerInvite, now = Date.now()) {
  if (invite.inactiveSince === null || invite.uses.length > 0) return null;
  const removedAt = Date.parse(invite.inactiveSince) + unusedPastInviteRetentionDays * dayMs;
  return Math.max(0, Math.ceil((removedAt - now) / dayMs));
}

/** "Nickname #code", or the Deleted member label with no former name. */
export function trailPersonName(person: InviteTrailPerson, t: Translate) {
  if (person.state === "deleted" || person.nickname === null) return t("common.deletedMember");
  return person.mentionCode ? `${person.nickname} #${person.mentionCode}` : person.nickname;
}
