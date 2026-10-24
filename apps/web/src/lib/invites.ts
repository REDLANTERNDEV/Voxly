/**
 * The token rides in the fragment, which browsers never send: no Voxly request
 * log or reverse-proxy access log along the way records it. Links shared in the
 * old `/invite/<token>` shape still open (`getInviteToken`).
 */
export function buildInviteUrl(token: string, origin: string) {
  return `${origin.replace(/\/+$/, "")}/invite#${encodeURIComponent(token)}`;
}

/** The token from whatever was pasted: a bare token or a link of either shape. */
export function extractInviteToken(value: string) {
  const trimmed = value.trim();
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("#"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
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
