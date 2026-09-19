import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  clientUpdatePollMs,
  clientUpdateRequired,
  clientUpdateUrl,
  claimClientUpdateAttempt,
  loadedClientVersion
} from "../src/lib/useClientUpdate.js";

describe("long-lived client updates", () => {
  it("identifies the hashed entry script already running in this window", () => {
    const page = {
      querySelector: () => ({ src: "https://voxly.example.com/assets/index-old.js" })
    } as unknown as Document;

    assert.equal(loadedClientVersion(page, "https://voxly.example.com/app/text/general"), "/assets/index-old.js");
  });

  it("does not trust a cross-origin module as the Voxly version", () => {
    const page = {
      querySelector: () => ({ src: "https://cdn.example.com/index.js" })
    } as unknown as Document;

    assert.equal(loadedClientVersion(page, "https://voxly.example.com/"), null);
  });

  it("requires an update only when two known versions differ", () => {
    assert.equal(clientUpdateRequired("/assets/index-a.js", "/assets/index-a.js"), false);
    assert.equal(clientUpdateRequired("/assets/index-a.js", "/assets/index-b.js"), true);
    assert.equal(clientUpdateRequired(null, "/assets/index-b.js"), false);
    assert.equal(clientUpdateRequired("/assets/index-a.js", null), false);
  });

  it("preserves the route and adds a cache-busting deployment version", () => {
    const next = new URL(clientUpdateUrl(
      "https://voxly.example.com/app/server/one/text/two?panel=open#message",
      "/assets/index-new.js"
    ));

    assert.equal(next.pathname, "/app/server/one/text/two");
    assert.equal(next.searchParams.get("panel"), "open");
    assert.equal(next.searchParams.get("voxly-client"), "/assets/index-new.js");
    assert.equal(next.hash, "#message");
  });

  it("prevents a stale intermediary from causing an automatic reload loop", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }
    };

    assert.equal(claimClientUpdateAttempt(storage, "old", "new"), true);
    assert.equal(claimClientUpdateAttempt(storage, "old", "new"), false);
    assert.equal(claimClientUpdateAttempt(storage, "new", "newer"), true);
  });

  it("polls at a bounded interval and checks again when the app returns", () => {
    const source = readFileSync("src/lib/useClientUpdate.ts", "utf8");

    assert.equal(clientUpdatePollMs, 5 * 60_000);
    assert.match(source, /fetchConfig\(\{ cache: "no-store" \}\)/);
    assert.match(source, /visibilitychange/);
    assert.match(source, /window\.location\.replace/);
    assert.match(source, /window\.addEventListener\("online"/);
  });
});
