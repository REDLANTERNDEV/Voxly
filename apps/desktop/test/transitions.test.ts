import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { createQuitRequest, needsConfirmation, performTransition, type CallState } from "../src/transitions.js";

const idle: CallState = {
  version: 1,
  inVoice: false,
  microphone: false,
  camera: false,
  screen: false,
  computerAudio: false,
  capture: false,
  pendingJoin: false,
  pendingCapture: false,
  microphoneTest: false
};

describe("quit request coalescing", () => {
  it("shares one confirmation and accepts a fresh request after cancellation", async () => {
    let prompts = 0;
    let cancel!: () => void;
    const quit = createQuitRequest(async () => {
      prompts++;
      await new Promise<void>((resolve) => {
        cancel = resolve;
      });
    });
    const first = quit();
    assert.equal(quit(), first);
    await Promise.resolve();
    assert.equal(prompts, 1);
    cancel();
    await first;
    const second = quit();
    await Promise.resolve();
    assert.equal(prompts, 2);
    cancel();
    await second;
  });

  it("releases a failed quit request for retry", async () => {
    let attempts = 0;
    const quit = createQuitRequest(async () => {
      if (++attempts === 1) throw Error("window_failed");
    });
    await assert.rejects(quit(), /window_failed/);
    await quit();
    assert.equal(attempts, 2);
  });
});

describe("call-aware shell transitions", () => {
  it("confirms missing state and every media/pending flag, including muted calls", () => {
    assert.equal(needsConfirmation(true, idle, false), false);
    assert.equal(needsConfirmation(true, null, false), true);
    assert.equal(needsConfirmation(false, null, false), false);
    assert.equal(needsConfirmation(false, null, true), true);
    for (const key of Object.keys(idle).filter((key) => key !== "version")) {
      assert.equal(needsConfirmation(true, { ...idle, [key]: true }, false), true, key);
    }
  });
  it("cancellation leaves all capture and the installation intact", async () => {
    let stopped = false;
    let acted = false;
    assert.equal(
      await performTransition({
        active: true,
        report: async () => ({ ...idle, pendingJoin: true }),
        localMedia: () => false,
        confirm: async () => false,
        stop: () => {
          stopped = true;
        },
        action: async () => {
          acted = true;
        }
      }),
      undefined
    );
    assert.equal(stopped, false);
    assert.equal(acted, false);
  });
  it("fresh idle state skips confirmation; native can detect a join during health check", async () => {
    const events: string[] = [];
    const result = await performTransition({
      active: true,
      report: async () => idle,
      localMedia: () => false,
      confirm: async (report) => {
        assert.equal(report, null);
        events.push("confirm");
        return true;
      },
      stop: () => events.push("stop"),
      action: async (confirmed) => {
        events.push(`action:${confirmed}`);
        if (!confirmed) throw "confirmation_required";
        return "replaced";
      }
    });
    assert.equal(result, "replaced");
    assert.deepEqual(events, ["stop", "action:false", "confirm", "stop", "action:true"]);
  });
  it("failed health checks do not retry or prompt as a confirmation error", async () => {
    await assert.rejects(
      performTransition({
        active: true,
        report: async () => idle,
        localMedia: () => false,
        confirm: async () => {
          assert.fail("unexpected confirmation");
        },
        stop: () => {},
        action: async () => {
          throw new Error("unreachable");
        }
      }),
      /unreachable/
    );
  });
  it("failed state transport prompts conservatively and cancellation prevents native work", async () => {
    let stopped = false;
    await performTransition({
      active: true,
      report: async () => {
        throw new Error("bridge missing");
      },
      localMedia: () => false,
      confirm: async (report) => {
        assert.equal(report, null);
        return false;
      },
      stop: () => {
        stopped = true;
      },
      action: async () => {
        assert.fail("cancelled");
      }
    });
    assert.equal(stopped, false);
  });
  it("cancelling after native detects new media preserves the installation", async () => {
    let actions = 0;
    await performTransition({
      active: true,
      report: async () => idle,
      localMedia: () => false,
      confirm: async () => false,
      stop: () => {},
      action: async () => {
        actions++;
        throw "confirmation_required";
      }
    });
    assert.equal(actions, 1);
  });
  it("confirmed transitions end chooser capture before awaiting native work", async () => {
    let stopped = false;
    await performTransition({
      active: false,
      report: async () => {
        assert.fail("no installation");
      },
      localMedia: () => true,
      confirm: async () => true,
      stop: () => {
        stopped = true;
      },
      action: async (confirmed) => {
        assert.equal(confirmed, true);
        assert.equal(stopped, true);
      }
    });
  });
});

interface StateBridge {
  version: number;
  subscribe(provider: () => unknown): () => void;
  request(id: number): void;
}
const bootstrap = readFileSync("src-tauri/src/call-state.js", "utf8");
function boot(origin = "https://chat.example", top = true) {
  const calls: { command: string; args: { request: number; report: CallState } }[] = [];
  const window = {
    location: { origin },
    top: null as unknown,
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: { request: number; report: CallState }) => {
        calls.push({ command, args });
        return Promise.resolve();
      }
    },
    __VOXLY_DESKTOP_STATE_V1__: undefined as StateBridge | undefined
  };
  window.top = top ? window : {};
  runInNewContext(`${bootstrap}("https://chat.example");`, { window });
  return { window, calls };
}

describe("finite call-state bootstrap", () => {
  it("reports only requested finite booleans from the exact-origin top frame", () => {
    const { window, calls } = boot();
    const bridge = window.__VOXLY_DESKTOP_STATE_V1__!;
    bridge.request(1);
    assert.equal(calls.length, 0);
    bridge.subscribe(() => ({ ...idle, privatePath: "/private", roomId: "secret" }));
    bridge.request(2);
    assert.equal(calls[0].command, "report_call_state");
    assert.equal(calls[0].args.request, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args.report)), idle);
    window.location.origin = "https://other.example";
    bridge.request(3);
    assert.equal(calls.length, 1);
    assert.equal(boot("https://evil.example").window.__VOXLY_DESKTOP_STATE_V1__, undefined);
    assert.equal(boot("https://chat.example", false).window.__VOXLY_DESKTOP_STATE_V1__, undefined);
  });
  it("rejects invalid state, versions and request ids; cleanup keeps the latest lease", () => {
    const { window, calls } = boot();
    const bridge = window.__VOXLY_DESKTOP_STATE_V1__!;
    const old = bridge.subscribe(() => idle);
    bridge.subscribe(() => ({ ...idle, pendingJoin: "false" }));
    old();
    bridge.request(1);
    bridge.subscribe(() => ({ ...idle, version: 2 }));
    bridge.request(2);
    const cleanup = bridge.subscribe(() => idle);
    for (const id of [0, -1, NaN, 1.5, 4294967296]) bridge.request(id);
    assert.equal(calls.length, 0);
    bridge.request(3);
    assert.equal(calls.length, 1);
    cleanup();
    bridge.request(4);
    assert.equal(calls.length, 1);
  });
});
