import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { musicSearchResultsMax, musicTitleMaxLength } from "@voxly/shared";
import {
  classifyExtractorFailure,
  classifyFetchFailure,
  parseSearchResults,
  parseTrackMetadata,
  resolverFor,
  youtubeVideoUrl,
  type TrackFetchOutcome
} from "../src/track.js";
import { resolveTimeoutMs, searchTimeoutMs } from "../src/stream.js";
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

/**
 * A Track that resolved perfectly at eight o'clock and will not play when its
 * turn comes at nine. The pre-playback path never sees this one: `resolveTrack`
 * asked the source an hour ago and got an answer.
 *
 * This is the whole of the rule, and it is here rather than in `stream.ts` for
 * the reason written at the top of that file — the adapter has argument lists
 * and timeouts in it, which only the real binaries can judge, while *which of
 * three things to tell the room* is a decision a test can hold to account.
 */
describe("a Track that fails when its turn comes", () => {
  /** A fetch that ran, delivered the whole Track, and stopped. */
  const playedOut: TrackFetchOutcome = {
    cancelled: false,
    spawnFailed: false,
    timedOut: false,
    extractorStderr: "",
    extractorCode: 0,
    encoderCode: 0,
    incomplete: false,
    silent: false
  };

  it("says nothing about a Track that played out", () => {
    assert.equal(classifyFetchFailure(playedOut), null);
  });

  it("says nothing when the Set moved on, however the processes ended", () => {
    // A skip, a removal or the Set ending kills both programs mid-fetch, so
    // every other signal here looks exactly like a failure. Telling the room a
    // Track was blocked because somebody skipped it would be a line about a
    // thing that did not happen.
    assert.equal(
      classifyFetchFailure({
        ...playedOut,
        cancelled: true,
        extractorCode: null,
        encoderCode: null,
        incomplete: true,
        silent: true
      }),
      null
    );
  });

  it("blames the video for the failures a member can do something about", () => {
    // The same words and the same classifier the pre-playback path uses: a
    // second one beside it would be a second opinion about the source's own
    // vocabulary, and the two would drift.
    for (const [name, stderr] of Object.entries(unavailableVideo)) {
      assert.equal(
        classifyFetchFailure({ ...playedOut, extractorStderr: stderr, extractorCode: 1, encoderCode: 1 }),
        "failedUnavailable",
        name
      );
    }
  });

  it("blames the source when it is refusing the bot rather than hiding the Track", () => {
    // The fourth acceptance criterion: a member who can tell these apart knows
    // whether to find another Track or to wait, and one message for both sends
    // half of them the wrong way.
    for (const [name, stderr] of Object.entries(refusedExtractor)) {
      assert.equal(
        classifyFetchFailure({ ...playedOut, extractorStderr: stderr, extractorCode: 1, encoderCode: 1 }),
        "failedSource",
        name
      );
    }
  });

  it("reads the extractor's words even before its exit has arrived", () => {
    // Two processes end within a tick of each other and the encoder's exit is
    // what ends the fetch, so yt-dlp's own exit code may not have been
    // delivered yet. Its `ERROR:` line has been.
    assert.equal(
      classifyFetchFailure({
        ...playedOut,
        extractorStderr: unavailableVideo.private,
        extractorCode: null,
        encoderCode: 1
      }),
      "failedUnavailable"
    );
  });

  it("blames neither when the bot's own side is what broke", () => {
    // `failedSource` renders as "YouTube is refusing the Music bot right now",
    // so it must mean that. An ffmpeg nobody installed is a wait that never
    // ends, and the person who can fix it is reading the bot's logs.
    assert.equal(classifyFetchFailure({ ...playedOut, spawnFailed: true }), "failedBot");
    assert.equal(classifyFetchFailure({ ...playedOut, timedOut: true, encoderCode: null }), "failedBot");
    assert.equal(classifyFetchFailure({ ...playedOut, encoderCode: 1 }), "failedBot");
    assert.equal(classifyFetchFailure({ ...playedOut, incomplete: true }), "failedBot");
  });

  it("does not mistake a fetch that produced nothing for a Track that played out", () => {
    // The bug this ticket is about, in its most direct form. The encoder's exit
    // is what ends a fetch, so the extractor's own exit code and the tail of
    // its stderr can both still be in flight — and a fetch judged on those
    // alone would look exactly like a Track the room had heard all of.
    assert.equal(
      classifyFetchFailure({ ...playedOut, silent: true, extractorCode: null, encoderCode: null }),
      "failedBot"
    );
  });

  it("still blames the video when a silent fetch says why", () => {
    // Silence is the fallback, not the answer. Whenever the extractor's own
    // words have arrived, they are what the room is told.
    assert.equal(
      classifyFetchFailure({
        ...playedOut,
        silent: true,
        extractorStderr: unavailableVideo.geoBlocked,
        extractorCode: 1,
        encoderCode: 1
      }),
      "failedUnavailable"
    );
  });

  it("blames the source, not the video, for words nobody has seen before", () => {
    // The same safe direction `classifyExtractorFailure` already takes, arrived
    // at from the other end: an unrecognised failure must not put "that video
    // will not play" in front of a room about a Track that is perfectly fine.
    assert.equal(
      classifyFetchFailure({
        ...playedOut,
        extractorStderr: "ERROR: something entirely new",
        extractorCode: 1,
        encoderCode: 1
      }),
      "failedSource"
    );
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

/**
 * A typed name is the second resolver, beside the pasted link — ADR-0004 said
 * one would arrive and ADR-0007 is the one that did. Both halves of it are
 * here, and deliberately: deciding *which* resolver an input belongs to is the
 * bot's knowledge, and reading what the extractor found is the source's own
 * vocabulary. Neither needs a subprocess to assert.
 */
describe("telling a link from a name", () => {
  it("takes anything announcing itself as a web address as a link", () => {
    assert.deepEqual(resolverFor("https://youtu.be/aB3dE5gH7jK"), {
      kind: "link",
      url: "https://www.youtube.com/watch?v=aB3dE5gH7jK"
    });
    assert.deepEqual(resolverFor("  https://www.youtube.com/watch?v=aB3dE5gH7jK\n"), {
      kind: "link",
      url: "https://www.youtube.com/watch?v=aB3dE5gH7jK"
    });
  });

  it("recognises a host that was typed rather than pasted", () => {
    // A paste carries its scheme; a person typing one leaves it off. The one
    // prefix goes through the same exact-host check as everything else, so
    // nothing new is recognised — only the same links, written shorter.
    for (const input of ["youtube.com/watch?v=aB3dE5gH7jK", "youtu.be/aB3dE5gH7jK", "www.youtube.com/watch?v=aB3dE5gH7jK"]) {
      assert.deepEqual(resolverFor(input), { kind: "link", url: "https://www.youtube.com/watch?v=aB3dE5gH7jK" }, input);
    }
  });

  it("refuses a link to something else rather than searching for its text", () => {
    // Somebody who pasted a Spotify link or a playlist wants to be told the
    // link is wrong. Searching YouTube for the text of a URL would answer a
    // question nobody asked, with results nobody wants.
    for (const input of [
      "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
      "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "https://www.youtube.com/@someone",
      "https://example.com/watch?v=aB3dE5gH7jK",
      "http://youtube.com.evil.example/watch?v=aB3dE5gH7jK"
    ]) {
      assert.deepEqual(resolverFor(input), { kind: "unsupported" }, input);
    }
  });

  it("takes everything else as a name to search for", () => {
    for (const input of ["nocturne", "Chopin Nocturne in E-flat major", "R.E.M.", "Beethoven: Symphony No. 5"]) {
      assert.deepEqual(resolverFor(input), { kind: "search", name: input.trim() }, input);
    }
    assert.deepEqual(resolverFor("  nocturne  "), { kind: "search", name: "nocturne" });
  });

  it("asks about the words rather than the spacing they arrived with", () => {
    // A name pasted out of a tracklist brings a newline and a run of spaces.
    assert.deepEqual(resolverFor("Chopin\n  Nocturne"), { kind: "search", name: "Chopin Nocturne" });
  });

  it("has nothing to do with an input that is empty", () => {
    // The panel will not send one, but the server's bound is applied before
    // trimming, so a field of spaces does arrive. It is neither a link nor a
    // name — and it is deliberately not `unsupported`, which means "your link
    // is wrong" and is the wrong sentence for somebody who typed no link.
    assert.deepEqual(resolverFor("   "), { kind: "nothing" });
    assert.deepEqual(resolverFor(""), { kind: "nothing" });
  });
});

describe("reading what a search found", () => {
  it("offers each result with what tells one from another", () => {
    const found = parseSearchResults(fixture("search.json"));

    assert.ok(found.ok);
    assert.deepEqual(found.results[0], {
      track: { id: "aB3dE5gH7jK", title: "Nocturne in E-flat major", durationSeconds: 273 },
      channel: "A Channel",
      url: "https://www.youtube.com/watch?v=aB3dE5gH7jK"
    });
    // The length separates the Track from the hour-long mix, and the channel
    // separates it from the cover. Both are why a member is shown a list.
    assert.deepEqual(
      found.results.map((result) => [result.track.title, result.track.durationSeconds, result.channel]),
      [
        ["Nocturne in E-flat major", 273, "A Channel"],
        ["Nocturne in E-flat major (cover)", 289, "Someone Else"],
        ["Nocturne — 1 hour relaxing mix", 3714, "Study Mixes"],
        ["Nocturne op. 9 no. 2", 261, "A Third Channel"]
      ]
    );
  });

  it("keeps the source's own order, so the closest one is offered first", () => {
    const found = parseSearchResults(fixture("search.json"));

    assert.equal(found.ok && found.results[0]?.track.id, "aB3dE5gH7jK");
  });

  it("drops what could not be queued anyway rather than offering it", () => {
    // A live stream has no end and a premiere has not happened; choosing either
    // would earn a refusal for something the bot already knew about it.
    const found = parseSearchResults(fixture("search.json"));

    assert.ok(found.ok);
    assert.equal(found.results.some((result) => result.track.id === "R4d10L1v3St"), false, "a live stream");
    assert.equal(found.results.some((result) => result.track.id === "N0Dur4t10nX"), false, "a premiere");
  });

  it("rebuilds each link from the id rather than echoing the one it was handed", () => {
    // The same rule a pasted link goes through. The browser hands this string
    // straight back to play it, so it must be one the bot built.
    const found = parseSearchResults(JSON.stringify({
      entries: [{
        id: "aB3dE5gH7jK",
        title: "Nocturne",
        duration: 273,
        channel: "A Channel",
        url: "https://www.youtube.com/watch?v=aB3dE5gH7jK&list=PL0000000000&t=90"
      }]
    }));

    assert.equal(found.ok && found.results[0]?.url, "https://www.youtube.com/watch?v=aB3dE5gH7jK");
  });

  it("bounds how many results it will offer", () => {
    const many = Array.from({ length: musicSearchResultsMax + 6 }, (_unused, index) => ({
      id: `aB3dE5gH7j${index}`,
      title: `Nocturne ${index}`,
      duration: 100,
      channel: "A Channel"
    }));

    const found = parseSearchResults(JSON.stringify({ entries: many }));

    assert.equal(found.ok && found.results.length, musicSearchResultsMax);
  });

  it("bounds every string in the list, the way one Track's title is bounded", () => {
    const long = "x".repeat(musicTitleMaxLength + 500);
    const found = parseSearchResults(JSON.stringify({
      entries: [{ id: "aB3dE5gH7jK", title: long, duration: 100, channel: long }]
    }));

    assert.equal(found.ok && found.results[0]?.track.title.length, musicTitleMaxLength);
    assert.equal(found.ok && found.results[0]?.channel.length, musicTitleMaxLength);
  });

  it("offers a result whose channel the source did not name, rather than dropping it", () => {
    // The channel helps a member choose; a Track without one is still playable,
    // and a missing name is the panel's problem to lay out rather than a reason
    // to withhold the Track.
    const found = parseSearchResults(JSON.stringify({
      entries: [{ id: "aB3dE5gH7jK", title: "Nocturne", duration: 273 }]
    }));

    assert.equal(found.ok && found.results[0]?.channel, "");
  });

  it("falls back to the uploader when that is the name the source gave", () => {
    const found = parseSearchResults(JSON.stringify({
      entries: [{ id: "aB3dE5gH7jK", title: "Nocturne", duration: 273, uploader: "A Channel" }]
    }));

    assert.equal(found.ok && found.results[0]?.channel, "A Channel");
  });

  it("offers one video once, however many times the listing names it", () => {
    // A repeated row is a choice that is not a choice, and it costs a place a
    // different Track could have had.
    const found = parseSearchResults(JSON.stringify({
      entries: [
        { id: "aB3dE5gH7jK", title: "Nocturne", duration: 273, channel: "A Channel" },
        { id: "aB3dE5gH7jK", title: "Nocturne", duration: 273, channel: "A Channel" },
        { id: "qW8eR2tY6uI", title: "Nocturne op. 9 no. 2", duration: 261, channel: "A Third Channel" }
      ]
    }));

    assert.deepEqual(found.ok && found.results.map((result) => result.track.id), ["aB3dE5gH7jK", "qW8eR2tY6uI"]);
  });

  it("finds nothing rather than failing when the search matched nothing", () => {
    // A search that ran and matched nothing is an answer, not a refusal: there
    // is nothing wrong for the member to wait out, and the panel says so.
    assert.deepEqual(parseSearchResults(JSON.stringify({ entries: [] })), { ok: true, results: [] });
  });

  it("refuses output it cannot make sense of instead of inventing a list", () => {
    for (const output of ["", "not json", "null", "[]", JSON.stringify({ id: "x" })]) {
      assert.deepEqual(parseSearchResults(output), { ok: false, error: "extractor_failed" }, output);
    }
  });

  it("skips an entry it cannot read without losing the rest of the list", () => {
    const found = parseSearchResults(JSON.stringify({
      entries: [
        null,
        { id: "not-an-id", title: "Nocturne", duration: 100 },
        { id: "aB3dE5gH7jK", title: "   ", duration: 100 },
        { id: "qW8eR2tY6uI", title: "Nocturne op. 9 no. 2", duration: 261, channel: "A Third Channel" }
      ]
    }));

    assert.equal(found.ok && found.results.length, 1);
    assert.equal(found.ok && found.results[0]?.track.id, "qW8eR2tY6uI");
  });

  it("leaves room for a second search waiting behind the first", () => {
    // Nothing else is in this budget — a search does not Summon the bot, so no
    // join follows it — but searches take their turn among themselves, so a
    // member whose search arrives while another is running waits out two of
    // these. Over the server's 25s and they get "the bot did not answer" in
    // place of whatever the search actually found out.
    assert.ok(
      searchTimeoutMs * 2 <= 20_000,
      `searchTimeoutMs is ${searchTimeoutMs}ms; two of them must fit inside the server's botAckTimeoutMs of 25000ms`
    );
    // Shorter than a resolve, and strictly: a flat listing does no per-video
    // extraction, so a search still running when a resolve would have finished
    // is not one that is nearly done.
    assert.ok(searchTimeoutMs < resolveTimeoutMs, `searchTimeoutMs is ${searchTimeoutMs}ms`);
  });
});
