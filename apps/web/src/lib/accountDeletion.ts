import type { AccountDeletionRequest } from "../types.js";

export const accountDeletionCooldownMs = 24 * 60 * 60 * 1000;

export function remainingDeletionCooldownHours(
  request: Pick<AccountDeletionRequest, "status" | "resolvedAt">,
  now = Date.now()
) {
  if (!request.resolvedAt || (request.status !== "cancelled" && request.status !== "rejected")) return null;
  const resolvedAt = Date.parse(request.resolvedAt);
  if (!Number.isFinite(resolvedAt)) return null;
  const remaining = resolvedAt + accountDeletionCooldownMs - now;
  return remaining > 0 ? Math.ceil(remaining / (60 * 60 * 1000)) : null;
}
