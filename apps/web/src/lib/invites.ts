export function buildInviteUrl(token: string, origin: string) {
  return `${origin.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;
}

export function resolveInviteOrigin(publicUrl: string | null | undefined, browserOrigin: string) {
  return (publicUrl?.trim() || browserOrigin).replace(/\/+$/, "");
}

export function inviteReference(inviteId: string) {
  return `Ref ${inviteId.slice(0, 8)}`;
}
