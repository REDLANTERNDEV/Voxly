import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("Turnstile widget lifecycle", () => {
  it("does not replace the challenge when its parent rerenders", () => {
    const source = readFileSync("src/features/auth/InviteScreen.tsx", "utf8");

    // The recovery and link screens update their parent state when Turnstile
    // produces a token. Callback props therefore change as those screens
    // rerender. That must not remove the iframe that just produced the token.
    assert.match(source, /const onTokenRef = useRef\(onToken\);/);
    assert.match(source, /const onUnavailableRef = useRef\(onUnavailable\);/);
    assert.match(source, /\[resetKey, siteKey\]\);/);
    assert.doesNotMatch(source, /\[onToken, onUnavailable, resetKey, siteKey\]\);/);
  });
});
