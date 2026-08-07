import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackLandingView } from "../src/lib/analytics.js";

interface FakeScript {
  src: string;
  defer: boolean;
  dataset: Record<string, string>;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeWindow {
  umami?: { track(): void };
  dataLayer?: unknown[];
}

/**
 * The web workspace has no DOM in tests, so this installs the minimal script
 * and head surface the loader touches.
 */
function installDom() {
  const scripts: FakeScript[] = [];
  const window: FakeWindow = {};
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = window;
  globals.document = {
    createElement: (): FakeScript => ({ src: "", defer: false, dataset: {}, onload: null, onerror: null }),
    head: { append: (script: FakeScript) => scripts.push(script) }
  };
  return { scripts, window };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("landing analytics", () => {
  it("loads nothing when the deployment configured no provider", async () => {
    const dom = installDom();

    trackLandingView(null);
    await settled();

    assert.equal(dom.scripts.length, 0);
  });

  it("loads a Umami tag with automatic route tracking disabled and reports one view", async () => {
    const dom = installDom();
    let views = 0;

    trackLandingView({ provider: "umami", scriptUrl: "https://analytics.example.com/umami-one.js", websiteId: "site-1" });
    assert.equal(dom.scripts.length, 1);
    const script = dom.scripts[0];
    assert.equal(script.src, "https://analytics.example.com/umami-one.js");
    assert.equal(script.defer, true);
    assert.equal(script.dataset.websiteId, "site-1");
    // Auto tracking would report authenticated in-app paths once loaded.
    assert.equal(script.dataset.autoTrack, "false");
    // Unset, so the tracker keeps deriving the endpoint from its own URL.
    assert.equal(script.dataset.hostUrl, undefined);

    dom.window.umami = { track: () => { views += 1; } };
    script.onload?.();
    await settled();

    assert.equal(views, 1);
  });

  it("pins the Umami endpoint when the deployment reports one", () => {
    const dom = installDom();

    trackLandingView({
      provider: "umami",
      scriptUrl: "https://cloud.umami.is/umami-three.js",
      websiteId: "site-3",
      hostUrl: "https://gateway.umami.is"
    });

    // Otherwise the tracker picks its own endpoint and can miss the one the
    // Content-Security-Policy allows, which drops every event silently.
    assert.equal(dom.scripts[0].dataset.hostUrl, "https://gateway.umami.is");
  });

  it("survives a blocked or unreachable analytics host", async () => {
    const dom = installDom();

    trackLandingView({ provider: "umami", scriptUrl: "https://analytics.example.com/umami-two.js", websiteId: "site-2" });
    dom.scripts[0].onerror?.();
    await settled();
  });

  it("queues the Google page view before gtag.js loads and adds no inline snippet", async () => {
    const dom = installDom();

    trackLandingView({ provider: "google", scriptUrl: "https://www.googletagmanager.com/gtag/js?id=G-TEST123", websiteId: "G-TEST123" });

    const queued = (dom.window.dataLayer ?? []).map((entry) => Array.from(entry as IArguments));
    assert.equal(queued.length, 2);
    assert.equal(queued[0][0], "js");
    assert.deepEqual(queued[1], ["config", "G-TEST123", {}]);
    assert.equal(dom.scripts[0].src, "https://www.googletagmanager.com/gtag/js?id=G-TEST123");
    assert.equal(dom.scripts[0].dataset.websiteId, undefined);
  });

  it("points Google at a server-side tagging container when the deployment has one", () => {
    const dom = installDom();

    trackLandingView({
      provider: "google",
      scriptUrl: "https://www.googletagmanager.com/gtag/js?id=G-TEST123",
      websiteId: "G-TEST123",
      hostUrl: "https://gtm.example.com"
    });

    const queued = (dom.window.dataLayer ?? []).map((entry) => Array.from(entry as IArguments));
    assert.deepEqual(queued[1], ["config", "G-TEST123", { transport_url: "https://gtm.example.com" }]);
  });
});
