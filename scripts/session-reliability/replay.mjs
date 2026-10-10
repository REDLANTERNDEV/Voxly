import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoxlyApp } from "../../apps/server/dist/src/app.js";

// Standalone research replay, also covered by session-delivery.test.ts. Build the
// server first. This models response delivery order using the real HTTP routes;
// it does not simulate Chrome's networking. No credentials leave memory.
// All three response orders must keep the browser signed in.
const scenarios = [
  { name: "recovery without a late response", late: false, confirm: true },
  { name: "late response without confirmed replacement", late: true, confirm: false },
  { name: "late response after confirmed recovery", late: true, confirm: true }
];

for (const scenario of scenarios) {
  test(`${scenario.name} keeps the same browser signed in`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-10T12:00:00Z") });
    const app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "local-test-only",
      allowHttpOwnerBootstrap: true,
      secureCookies: true,
      publicUrl: "https://voxly.example.com"
    });
    const jar = {};
    const deliver = (response) => {
      for (const cookie of response.cookies) {
        if (cookie.value) jar[cookie.name] = cookie.value;
        else delete jar[cookie.name];
      }
    };
    const me = () => app.server.inject({ method: "GET", url: "/api/me", cookies: jar });
    try {
      deliver(
        await app.server.inject({
          method: "POST",
          url: "/api/bootstrap/owner",
          payload: { bootstrapToken: "local-test-only", nickname: "Local test" }
        })
      );
      t.mock.timers.tick(16 * 60_000);
      const delayed = await me(); // Withhold this response's cookie.
      assert.equal(delayed.headers["x-voxly-session-rotated"], "1");

      t.mock.timers.tick(121_000);
      const recovered = await me();
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.headers["x-voxly-session-rotated"], "1");
      deliver(recovered);

      if (scenario.confirm) {
        assert.equal(
          (await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: jar })).statusCode,
          204
        );
      }
      if (scenario.late) deliver(delayed);
      assert.equal((await me()).statusCode, 200); // Concurrency grace still admits it.

      t.mock.timers.tick(121_000);
      const response = await me();
      const session = app.sqlite.prepare("select revoked_at from sessions").get();
      const audit = app.sqlite
        .prepare("select count(*) as count from audit_events where action = 'session.stale_rejected'")
        .get();
      console.log(
        JSON.stringify({
          scenario: scenario.name,
          status: response.statusCode,
          error: response.json().error ?? null,
          revoked: Boolean(session.revoked_at),
          staleRejectionAuditCount: audit.count
        })
      );
      assert.equal(response.statusCode, 200, "Same browser was falsely signed out after response reordering");
      assert.equal(session.revoked_at, null);
      assert.equal(audit.count, 0);
    } finally {
      await app.close();
    }
  });
}
