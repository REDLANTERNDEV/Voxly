export type MessageContentSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

export type MessageEmbedProvider = "youtube" | "x" | "vimeo" | "spotify";

export interface MessageEmbed {
  key: string;
  provider: MessageEmbedProvider;
  sourceUrl: string;
  embedUrl: string;
}

const urlPattern = /https?:\/\/[^\s<>"']+/giu;
const trailingPunctuation = /[.,!?;:\)\]\}]+$/u;
const maximumEmbeds = 4;

export function messageContentSegments(body: string): MessageContentSegment[] {
  const segments: MessageContentSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(urlPattern)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const text = raw.replace(trailingPunctuation, "");
    if (!text) continue;
    let href: string;
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      href = url.toString();
    } catch {
      continue;
    }
    if (match.index > cursor) segments.push({ kind: "text", text: body.slice(cursor, match.index) });
    segments.push({ kind: "link", text, href });
    cursor = match.index + text.length;
  }
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text: body }];
}

export function messageEmbeds(body: string, suppressedKeys: string[] = []): MessageEmbed[] {
  const suppressed = new Set(suppressedKeys);
  const seen = new Set<string>();
  const embeds: MessageEmbed[] = [];
  for (const segment of messageContentSegments(body)) {
    if (segment.kind !== "link") continue;
    const embed = embedForUrl(segment.href);
    if (!embed || suppressed.has(embed.key) || seen.has(embed.key)) continue;
    seen.add(embed.key);
    embeds.push(embed);
    if (embeds.length === maximumEmbeds) break;
  }
  return embeds;
}

function embedForUrl(sourceUrl: string): MessageEmbed | null {
  const url = new URL(sourceUrl);
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "youtu.be" || ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    const videoId = host === "youtu.be"
      ? parts[0]
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : ["shorts", "embed", "live"].includes(parts[0] ?? "")
          ? parts[1]
          : null;
    if (videoId && /^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
      return {
        key: `youtube:${videoId}`,
        provider: "youtube",
        sourceUrl,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?playsinline=1`
      };
    }
  }

  if (["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(host)) {
    const statusIndex = parts.indexOf("status");
    const postId = statusIndex >= 0 ? parts[statusIndex + 1] : null;
    if (postId && /^\d+$/u.test(postId)) {
      return {
        key: `x:${postId}`,
        provider: "x",
        sourceUrl,
        embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${postId}&dnt=true`
      };
    }
  }

  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
    const videoId = parts[0] === "video" ? parts[1] : parts[0];
    if (videoId && /^\d+$/u.test(videoId)) {
      return {
        key: `vimeo:${videoId}`,
        provider: "vimeo",
        sourceUrl,
        embedUrl: `https://player.vimeo.com/video/${videoId}`
      };
    }
  }

  if (host === "open.spotify.com") {
    const [kind, itemId] = parts;
    if (["track", "album", "playlist", "episode", "show", "artist"].includes(kind ?? "")
      && itemId && /^[A-Za-z0-9]{1,64}$/u.test(itemId)) {
      return {
        key: `spotify:${kind}:${itemId}`,
        provider: "spotify",
        sourceUrl,
        embedUrl: `https://open.spotify.com/embed/${kind}/${itemId}`
      };
    }
  }

  return null;
}
