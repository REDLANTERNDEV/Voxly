import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messageContentSegments, messageEmbeds } from "../src/lib/messageEmbeds.js";

describe("message links", () => {
  it("turns HTTP links into safe segments while retaining punctuation", () => {
    assert.deepEqual(
      messageContentSegments("Watch https://example.com/path?q=1, then reply."),
      [
        { kind: "text", text: "Watch " },
        { kind: "link", text: "https://example.com/path?q=1", href: "https://example.com/path?q=1" },
        { kind: "text", text: ", then reply." }
      ]
    );
  });

  it("does not linkify unsafe protocols", () => {
    assert.deepEqual(messageContentSegments("javascript:alert(1) data:text/html,test"), [
      { kind: "text", text: "javascript:alert(1) data:text/html,test" }
    ]);
  });
});

describe("rich message embeds", () => {
  it("recognizes approved YouTube, X, Vimeo, and Spotify URLs", () => {
    const embeds = messageEmbeds([
      "https://youtu.be/dQw4w9WgXcQ",
      "https://x.com/OpenAI/status/1234567890",
      "https://vimeo.com/123456789",
      "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
    ].join("\n"));

    assert.deepEqual(embeds.map(({ key, provider, embedUrl }) => ({ key, provider, embedUrl })), [
      {
        key: "youtube:dQw4w9WgXcQ",
        provider: "youtube",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1"
      },
      {
        key: "x:1234567890",
        provider: "x",
        embedUrl: "https://platform.twitter.com/embed/Tweet.html?id=1234567890&dnt=true"
      },
      {
        key: "vimeo:123456789",
        provider: "vimeo",
        embedUrl: "https://player.vimeo.com/video/123456789"
      },
      {
        key: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
        provider: "spotify",
        embedUrl: "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"
      }
    ]);
  });

  it("deduplicates embeds, caps them at four, and omits suppressed keys", () => {
    const body = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://x.com/user/status/1",
      "https://vimeo.com/2",
      "https://open.spotify.com/album/3",
      "https://x.com/user/status/4"
    ].join(" ");

    assert.deepEqual(
      messageEmbeds(body, ["x:1"]).map((embed) => embed.key),
      ["youtube:dQw4w9WgXcQ", "vimeo:2", "spotify:album:3", "x:4"]
    );
  });

  it("keeps YouTube timestamps by mapping them onto the embed start parameter", () => {
    const embedUrls = messageEmbeds([
      "https://youtu.be/dQw4w9WgXcQ?t=90",
      "https://www.youtube.com/watch?v=aQw4w9WgXcQ&t=1m30s",
      "https://www.youtube.com/watch?v=bQw4w9WgXcQ&t=1h2m3s",
      "https://www.youtube.com/embed/cQw4w9WgXcQ?start=45"
    ].join("\n")).map((embed) => embed.embedUrl);

    assert.deepEqual(embedUrls, [
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1&start=90",
      "https://www.youtube-nocookie.com/embed/aQw4w9WgXcQ?playsinline=1&start=90",
      "https://www.youtube-nocookie.com/embed/bQw4w9WgXcQ?playsinline=1&start=3723",
      "https://www.youtube-nocookie.com/embed/cQw4w9WgXcQ?playsinline=1&start=45"
    ]);
  });

  it("ignores unusable YouTube timestamps", () => {
    assert.deepEqual(
      messageEmbeds([
        "https://youtu.be/dQw4w9WgXcQ?t=later",
        "https://youtu.be/aQw4w9WgXcQ?t=0",
        "https://youtu.be/bQw4w9WgXcQ?t="
      ].join("\n")).map((embed) => embed.embedUrl),
      [
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1",
        "https://www.youtube-nocookie.com/embed/aQw4w9WgXcQ?playsinline=1",
        "https://www.youtube-nocookie.com/embed/bQw4w9WgXcQ?playsinline=1"
      ]
    );
  });

  it("leaves unapproved hosts as ordinary links", () => {
    assert.deepEqual(messageEmbeds("https://youtube.example/video/dQw4w9WgXcQ"), []);
  });
});
