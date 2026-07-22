export function buildInviteUrl(token: string, origin: string) {
  return `${origin.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;
}

export function resolveInviteOrigin(publicUrl: string | null | undefined, browserOrigin: string) {
  return (publicUrl?.trim() || browserOrigin).replace(/\/+$/, "");
}

export function inviteReference(inviteId: string) {
  return `Ref ${inviteId.slice(0, 8)}`;
}

export function maskSecretLink(value: string) {
  const mask = "••••••••••••";
  try {
    const url = new URL(value);
    if (url.hash) {
      const hashPrefix = url.hash.startsWith("#token=") ? "#token=" : "#";
      return `${url.origin}${url.pathname}${hashPrefix}${mask}`;
    }
    const segments = url.pathname.split("/");
    segments[segments.length - 1] = mask;
    return `${url.origin}${segments.join("/")}`;
  } catch {
    return mask;
  }
}
