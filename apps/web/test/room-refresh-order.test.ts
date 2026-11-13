import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { latestRequests } from "../src/lib/latestRequest.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("room list refreshes", () => {
  it("keeps the newest answer when an older one arrives after it", async () => {
    // Two quick Channel access changes: the first refresh's answer arrives last.
    const gate = latestRequests<string>();
    let shown: string[] = [];
    const refresh = async (serverId: string, answer: Promise<string[]>) => {
      const isNewest = gate.begin(serverId);
      const rooms = await answer;
      if (isNewest()) shown = rooms;
    };
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const runs = [refresh("server", first.promise), refresh("server", second.promise)];
    second.resolve(["Ada", "Berk"]);
    await Promise.resolve();
    first.resolve(["Ada"]);
    await Promise.all(runs);
    assert.deepEqual(shown, ["Ada", "Berk"]);
  });

  it("never lets one Server's refresh cancel another's", async () => {
    const gate = latestRequests<string>();
    const viewed = gate.begin("viewed");
    gate.begin("other");
    assert.equal(viewed(), true);
  });

  it("applies a refreshed room list only when it is the newest for its Server", () => {
    const controller = readFileSync("src/app/useWorkspaceController.ts", "utf8");
    const refresh = controller.slice(
      controller.indexOf("const refreshRooms"),
      controller.indexOf("const refreshServersAfterDeletion")
    );
    assert.match(
      refresh,
      /const\s+isNewest\s*=\s*roomRefreshes\.current\.begin\(\s*serverId\s*\);\s*const\s+response\s*=\s*await\s+fetchServerRooms\(\s*serverId\s*\);/
    );
    assert.ok(refresh.indexOf("if (!isNewest()) return;") < refresh.indexOf("setRooms(response.rooms)"));
  });
});
