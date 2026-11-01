/**
 * The Profile dialog's server nickname rows, as pure rules.
 *
 * An empty field is not an error: it is how a member says "use my account
 * nickname here", and it travels as `null`. Anything else follows the server's
 * trimmed 2–32 character contract.
 */

export const nicknameMinLength = 2;
export const nicknameMaxLength = 32;

export interface ProfileNicknameRow {
  serverId: string;
  /** The override the server last acknowledged; null where the account nickname shows. */
  saved: string | null;
  /** What the field holds now, untrimmed. */
  draft: string;
}

/** The value a draft is saved as: trimmed, and `null` once nothing is left. */
export function nicknameRequestValue(draft: string): string | null {
  const trimmed = draft.trim();
  return trimmed ? trimmed : null;
}

export function nicknameDraftError(draft: string): "length" | null {
  const value = nicknameRequestValue(draft);
  if (value === null) return null;
  return value.length < nicknameMinLength || value.length > nicknameMaxLength ? "length" : null;
}

/** Rows whose field would save something other than what the server holds. */
export function changedNicknameRows<Row extends ProfileNicknameRow>(rows: readonly Row[]): Row[] {
  return rows.filter((row) => nicknameRequestValue(row.draft) !== row.saved);
}

/** The name other members would read on that server if the draft were saved. */
export function effectiveNickname(draft: string, accountNickname: string): string {
  return nicknameRequestValue(draft) ?? accountNickname;
}
