import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceLabel } from "../src/auth/deviceLabel.js";

/**
 * The list exists so a member can answer "is that one mine?". These pin the two
 * ways that fails: a string reduced to nothing, and a browser named as whatever
 * it is impersonating.
 */
describe("device label", () => {
  it("names the common browsers rather than what they claim to be", () => {
    // Every one of these also says "Chrome" or "Safari" somewhere.
    assert.equal(
      deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"),
      "Edge on Windows"
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0"),
      "Opera on Windows"
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/130.0.0.0 Mobile Safari/537.36"),
      "Samsung Internet on Android"
    );
  });

  it("names an iPhone an iPhone, not a Mac", () => {
    // The iOS string contains "Mac OS X", and iOS Chrome calls itself CriOS.
    assert.equal(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"),
      "Safari on iPhone"
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1"),
      "Chrome on iPhone"
    );
  });

  it("keeps the ordinary cases plain", () => {
    assert.equal(
      deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"),
      "Safari on macOS"
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"),
      "Firefox on Linux"
    );
  });

  it("carries no version, so an update does not look like a stranger", () => {
    const before = deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36");
    const after = deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");

    assert.equal(before, after);
    assert.doesNotMatch(before, /\d/);
  });

  it("always yields something signable-out, whatever arrives", () => {
    // A Device nobody can see is worse than one with a dull name.
    for (const input of [undefined, "", "   ", "🙂", "curl/8.7.1"]) {
      assert.ok(deviceLabel(input).length > 0, `empty label for ${JSON.stringify(input)}`);
    }
    assert.equal(deviceLabel(undefined), "Unknown device");
  });

  it("does not keep an unbounded header", () => {
    assert.ok(deviceLabel(`Firefox/1 ${"x".repeat(100_000)} Windows`).length < 64);
  });
});
