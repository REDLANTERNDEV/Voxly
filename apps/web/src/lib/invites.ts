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

export type ParsedInviteInput =
  { kind: "here"; token: string } | { kind: "elsewhere"; origin: string; url: string } | { kind: "invalid" };

/** An invite token is URL-safe base64 from `createOpaqueToken`; anything else is not one. */
const inviteTokenPattern = /^[A-Za-z0-9_-]{24,128}$/;

/**
 * What a pasted or clicked string is, relative to this Installation (ADR-0036).
 *
 * A bare token always means here. A link is ours only when its origin is one of
 * this Installation's — the page origin and the configured public URL, which
 * invite links prefer — and its path is `/invite#<token>` or the older
 * `/invite/<token>`. A well-formed invite link anywhere else belongs to another
 * Installation, whose Accounts are not ours, so it is never joined from here.
 */
export function parseInviteInput(value: string, installationOrigins: readonly string[]): ParsedInviteInput {
  const trimmed = value.trim();
  if (inviteTokenPattern.test(trimmed)) return { kind: "here", token: trimmed };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: "invalid" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search) {
    return { kind: "invalid" };
  }
  let token = "";
  if (url.pathname === "/invite" && url.hash.length > 1) {
    try {
      token = decodeURIComponent(url.hash.slice(1));
    } catch {
      return { kind: "invalid" };
    }
  } else if (url.pathname.startsWith("/invite/") && !url.hash) {
    token = url.pathname.slice("/invite/".length);
  }
  if (!inviteTokenPattern.test(token)) return { kind: "invalid" };
  const ours = installationOrigins.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
  return ours ? { kind: "here", token } : { kind: "elsewhere", origin: url.origin, url: url.href };
}

let configuredPublicUrl: string | null = null;

/** Recorded once `/api/config` answers, so a link in chat can be recognised as this Installation's. */
export function rememberInstallationPublicUrl(publicUrl: string | null) {
  configuredPublicUrl = publicUrl;
}

export function installationOrigins(): string[] {
  return [window.location.origin, ...(configuredPublicUrl ? [configuredPublicUrl] : [])];
}

/**
 * Opens this Installation's invite card in place. Chat links open a new window,
 * and the desktop shell hands every new window to the default browser — often
 * one with no session, where joining made a second Account. A route change
 * through history keeps the member in this window, signed in, with any call
 * still connected; `App` follows `popstate` like any other navigation.
 */
export function openInviteInPlace(token: string) {
  window.history.pushState(null, "", `/invite#${encodeURIComponent(token)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
