import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { musicTitleMaxLength } from "@voxly/shared";
import { classifyExtractorFailure, parseTrackMetadata, youtubeVideoUrl } from "../src/track.js";
import { resolveTimeoutMs } from "../src/stream.js";
import { refusedExtractor, unavailableVideo } from "./fixtures/extractorFailures.js";

/**
 * Everything here is pure. Turning the extractor's answer into a Track is the
 * one place a source's vocabulary is understood, so it is the one place worth
 * pinning against real output; the process that produces that output is a thin
 * adapter with nothing in it to get wrong.
 *
 * The fixtures' provenance is in `fixtures/README.md`, and it matters: they were
 * written to yt-dlp's documented shape rather than captured from a live run.
 * The extractor's own JSON is read from `fixtures/*.json`; what it prints when
 * it gives up is one line each, so it lives in `fixtures/extractorFailures.ts`
 * rather than in a directory of files that read like stray logs.
 */

function fixture(name: string) {
  return readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), "utf8");
}

describe("recognising a link the bot can play", () => {
  it("accepts the forms a person actually pastes", () => {
    const expected = "https://www.youtube.com/watch?v=aB3dE5gH7jK";
    for (const input of [
      "https://www.youtube.com/watch?v=aB3dE5gH7jK",
      "https://youtube.com/watch?v=aB3dE5gH7jK",
      "https://m.youtube.com/watch?v=aB3dE5gH7jK",
      "https://music.youtube.com/watch?v=aB3dE5gH7jK",
      "https://youtu.be/aB3dE5gH7jK",
      "https://www.youtube.com/shorts/aB3dE5gH7jK",
      "https://www.youtube.com/live/aB3dE5gH7jK",
      "http://youtu.be/aB3dE5gH7jK"
    ]) {
      assert.equal(youtubeVideoUrl(input), expected, input);
    }
  });

  it("keeps the video and drops the rest of what a share link carries", () => {
    // A share link brings a timestamp, a playlist and a tracking parameter with
    // it. Rebuilding the URL from the id alone means none of them reach the
    // extractor, so two people pasting the same video from different places
    // ask for exactly the same thing.
    assert.equal(
      youtubeVideoUrl("https://www.youtube.com/watch?v=aB3dE5gH7jK&list=PL0000000000&index=4&t=90s"),
      "https://www.youtube.com/watch?v=aB3dE5gH7jK"
    );
    assert.equal(
      youtubeVideoUrl("https://youtu.be/aB3dE5gH7jK?si=RtQyRZDNGkeVj1sY&t=90"),
      "https://www.youtube.com/watch?v=aB3dE5gH7jK"
    );
  });

  it("tolerates the whitespace that comes with a paste", () => {
    assert.equal(youtubeVideoUrl("  https://youtu.be/aB3dE5gH7jK\n"), "https://www.youtube.com/watch?v=aB3dE5gH7jK");
  });

  it("refuses what is not one video on YouTube", () => {
    for (const input of [
      "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "https://www.youtube.com/@someone",
      "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx",
      "https://www.youtube.com/results?search_query=nocturne",
      "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
      "https://soundcloud.com/someone/a-track",
      "https://example.com/watch?v=aB3dE5gH7jK",
      "not a link at all",
      "javascript:alert(1)",
      "file:///etc/passwd",
      ""
    ]) {
      assert.equal(youtubeVideoUrl(input), null, input);
    }
  });

  it("refuses a video id that is not one, rather than passing it to a subprocess", () => {
    // Eleven characters of a known alphabet. Checking it here is what makes
    // "that is not a link I can play" a certain answer given instantly,
    // instead of a subprocess spawned to find out.
    assert.equal(youtubeVideoUrl("https://youtu.be/short"), null);
    assert.equal(youtubeVideoUrl("https://youtu.be/waaaaaaaaaaytoolong"), null);
    assert.equal(youtubeVideoUrl("https://youtu.be/has.a.dot!!"), null);
  });

  it("refuses a host that merely ends in the right letters", () => {
    assert.equal(youtubeVideoUrl("https://notyoutube.com/watch?v=aB3dE5gH7jK"), null);
    assert.equal(youtubeVideoUrl("https://youtube.com.evil.example/watch?v=aB3dE5gH7jK"), null);
    assert.equal(youtubeVideoUrl("https://evil.example/youtu.be/aB3dE5gH7jK"), null);
  });
});

describe("reading what the extractor said about a video", () => {
  it("carries the Track's title, length and identity", () => {
    const result = parseTrackMetadata(fixture("video.json"));

    assert.deepEqual(result, {
      ok: true,
      track: {
        id: "aB3dE5gH7jK",
        title: "Nocturne in E-flat major",
        durationSeconds: 273,
        url: "https://www.youtube.com/watch?v=aB3dE5gH7jK"
      }
    });
  });

  it("refuses a live stream, which has no end to queue after", () => {
    assert.deepEqual(parseTrackMetadata(fixture("live.json")), { ok: false, error: "live_stream" });
  });

  it("refuses a premiere that has not happened yet", () => {
    // It has a duration and looks playable. `live_status` is the only thing
    // that says there is nothing there to fetch.
    assert.deepEqual(parseTrackMetadata(fixture("premiere.json")), { ok: false, error: "live_stream" });
  });

  it("refuses a playlist rather than silently playing its first entry", () => {
    assert.deepEqual(parseTrackMetadata(fixture("playlist.json")), { ok: false, error: "unsupported_link" });
  });

  it("refuses output it cannot make sense of instead of inventing a Track", () => {
    assert.deepEqual(parseTrackMetadata("not json"), { ok: false, error: "extractor_failed" });
    assert.deepEqual(parseTrackMetadata(""), { ok: false, error: "extractor_failed" });
    assert.deepEqual(parseTrackMetadata("null"), { ok: false, error: "extractor_failed" });
    assert.deepEqual(parseTrackMetadata('{"id":"aB3dE5gH7jK"}'), { ok: false, error: "extractor_failed" });
    assert.deepEqual(
      parseTrackMetadata('{"id":"aB3dE5gH7jK","title":"x","duration":0,"live_status":"not_live"}'),
      { ok: false, error: "extractor_failed" },
      "a zero-length Track is not something to start playing"
    );
  });

  it("rounds a fractional duration rather than carrying it onto the wire", () => {
    const result = parseTrackMetadata('{"id":"aB3dE5gH7jK","title":"x","duration":212.61,"live_status":"not_live"}');

    assert.equal(result.ok && result.track.durationSeconds, 213);
  });
});

describe("reading why the extractor gave up", () => {
  it("blames the video when the video is the problem", () => {
    for (const [name, stderr] of Object.entries(unavailableVideo)) {
      assert.equal(classifyExtractorFailure(stderr), "track_unavailable", name);
    }
  });

  it("blames the extractor when the source is refusing it", () => {
    // Nothing is wrong with the link, so telling the member their link is bad
    // would send them looking for a different one. Worth its own answer.
    for (const [name, stderr] of Object.entries(refusedExtractor)) {
      assert.equal(classifyExtractorFailure(stderr), "extractor_failed", name);
    }
  });

  it("falls back to blaming the extractor for a message nobody has seen before", () => {
    // The safe default: "try again later" wastes a member's time, while "your
    // link is wrong" sends them to fix something that was never broken.
    assert.equal(classifyExtractorFailure("ERROR: something entirely new"), "extractor_failed");
    assert.equal(classifyExtractorFailure(""), "extractor_failed");
  });
});

describe("what the extractor is allowed to hand back", () => {
  it("bounds a title, which is somebody else's string on its way to the room", () => {
    const long = "x".repeat(musicTitleMaxLength + 500);
    const result = parseTrackMetadata(
      JSON.stringify({ id: "aB3dE5gH7jK", title: long, duration: 100, live_status: "not_live" })
    );

    assert.equal(result.ok && result.track.title.length, musicTitleMaxLength);
  });

  it("trims a title rather than carrying the extractor's whitespace onto the wire", () => {
    const result = parseTrackMetadata(
      JSON.stringify({ id: "aB3dE5gH7jK", title: "  Nocturne \n", duration: 100, live_status: "not_live" })
    );

    assert.equal(result.ok && result.track.title, "Nocturne");
  });

  it("gives up well before the server gives up on it", () => {
    // The two timeouts are in different workspaces and neither import can see
    // the other, so this is the only place the ordering between them is
    // written down. Inverted, the member gets `bot_timeout` — "the bot did not
    // answer" — in place of whatever the bot actually found out.
    assert.ok(
      resolveTimeoutMs <= 15_000,
      `resolveTimeoutMs is ${resolveTimeoutMs}ms; the server's botAckTimeoutMs is 25000ms and the join follows this`
    );
  });
});
