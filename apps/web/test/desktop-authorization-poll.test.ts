import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pollDesktopAuthorization, type DesktopAuthorizationPoll } from "../src/lib/desktopAuthorizationPoll.js";

/**
 * One effect run of the desktop window's sign-in poll, as the component runs
 * it. `restart` is what React does when the parent re-renders with a new
 * `onLinked`: the old run stops being live and a new run starts on the same
 * request.
 */
function harness(collect: DesktopAuthorizationPoll["collect"], remember?: DesktopAuthorizationPoll["remember"]) {
  const timers: Array<() => void> = [];
  let held = true;
  let linked = 0;
  const outcomes: string[] = [];
  const request = { id: "id", secret: "secret", expiresInSeconds: 90 };
  const start = () => {
    let live = true;
    const stop = pollDesktopAuthorization({
      request,
      collect,
      remember: remember ?? (async () => {}),
      restore: async () => {},
      onLinked: () => linked++,
      onOutcome: (outcome) => outcomes.push(outcome),
      isLive: () => live,
      isMounted: () => true,
      holdsRequest: () => held,
      releaseRequest: () => {
        held = false;
      },
      schedule: (run) => {
        timers.push(run);
        return () => {};
      },
      now: () => 0
    });
    return () => {
      live = false;
      stop();
    };
  };
  const flush = async () => {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  };
  return {
    start,
    tick: async () => {
      timers.shift()?.();
      await flush();
    },
    flush,
    linked: () => linked,
    outcomes
  };
}

describe("desktop window sign-in after browser approval", () => {
  it("signs in even when the page re-renders while the approval is being completed", async () => {
    let finishRemember = () => {};
    const poll = harness(
      async () => ({ status: "approved" }),
      () =>
        new Promise<void>((resolve) => {
          finishRemember = resolve;
        })
    );
    const stopFirst = poll.start();
    await poll.tick(); // The server answers "approved" and sets the session cookie.
    // The window is restored and focused; the parent re-renders mid-completion.
    stopFirst();
    poll.start();
    finishRemember();
    await poll.flush();
    await poll.tick(); // The restarted run polls once.
    assert.equal(poll.linked(), 1, "the approved desktop must leave the code card");
  });

  it("does not wait forever on a native call that never answers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const poll = harness(
      async () => ({ status: "approved" }),
      () => new Promise<void>(() => {})
    );
    poll.start();
    await poll.tick();
    t.mock.timers.tick(5_000);
    await poll.flush();
    assert.equal(poll.linked(), 1);
  });

  it("keeps polling while pending and reports a refusal", async () => {
    const answers = ["pending", "refused"];
    const poll = harness(async () => ({ status: answers.shift()! }));
    poll.start();
    await poll.tick();
    await poll.tick();
    assert.deepEqual(poll.outcomes, ["refused"]);
    assert.equal(poll.linked(), 0);
  });

  it("is what the desktop sign-in component runs, with a stable onLinked", () => {
    const source = readFileSync("src/features/auth/DesktopBrowserSignIn.tsx", "utf8");
    assert.match(source, /pollDesktopAuthorization\(\{/);
    assert.match(source, /const linked = useEffectEvent\(onLinked\)/);
    assert.match(source, /\}, \[request, outcome\]\);/);
  });
});
