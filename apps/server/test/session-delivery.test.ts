import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import {
  authenticateSocket,
  authenticateWithoutRenewal,
  createSession,
  sessionCookieNameFor
} from "../src/auth/sessions.js";
import { applyCookies, cookieJar, sessionToken } from "./sessionCookies.js";

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
    try {
      const jar = cookieJar(
        await app.server.inject({
          method: "POST",
          url: "/api/bootstrap/owner",
          payload: { bootstrapToken: "local-test-only", nickname: "Local test" }
        })
      );
      const me = () => app.server.inject({ method: "GET", url: "/api/me", cookies: jar });
      t.mock.timers.tick(16 * 60_000);
      const delayed = await me();
      t.mock.timers.tick(121_000);
      const recovered = await me();
      assert.equal(recovered.statusCode, 200);
      applyCookies(jar, recovered);
      if (scenario.confirm) {
        assert.equal(
          (await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: jar })).statusCode,
          204
        );
      }
      if (scenario.late) applyCookies(jar, delayed);
      t.mock.timers.tick(121_000);
      const response = await me();
      assert.equal(response.statusCode, 200, "delayed response must not replace the current browser credential");
      assert.equal(app.sqlite.prepare("select revoked_at from sessions").get()?.revoked_at, null);
    } finally {
      await app.close();
    }
  });
}

test("a stale request rejects only its credential, not the current session", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-10T12:00:00Z") });
  const app = await createVoxlyApp({
    databasePath: ":memory:",
    ownerBootstrapToken: "local-test-only",
    allowHttpOwnerBootstrap: true,
    secureCookies: false
  });
  try {
    const original = cookieJar(
      await app.server.inject({
        method: "POST",
        url: "/api/bootstrap/owner",
        payload: { bootstrapToken: "local-test-only", nickname: "Local test" }
      })
    );
    t.mock.timers.tick(16 * 60_000);
    const current = cookieJar(await app.server.inject({ method: "GET", url: "/api/me", cookies: original }));
    t.mock.timers.tick(5 * 60_000 + 1_000);
    await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: current });
    t.mock.timers.tick(121_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const stale = await app.server.inject({ method: "GET", url: "/api/me", cookies: original });
      assert.equal(stale.statusCode, 401);
      assert.equal(stale.json().error, "session_reused");
      assert.equal(stale.cookies.length, 0, "a stale response must not delete current cookies");
    }
    assert.equal((await app.server.inject({ method: "GET", url: "/api/me", cookies: current })).statusCode, 200);
    const session = app.sqlite.prepare("select id, revoked_at from sessions").get();
    assert.equal(session?.revoked_at, null);
    const events = app.sqlite
      .prepare("select session_id from audit_events where action = 'session.stale_rejected'")
      .all();
    assert.deepEqual(
      events.map((event) => event.session_id),
      [session?.id]
    );
  } finally {
    await app.close();
  }
});

async function fixture(t: TestContext, secure = false) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-10T12:00:00Z") });
  const app = await createVoxlyApp({
    databasePath: ":memory:",
    ownerBootstrapToken: "local-test-only",
    allowHttpOwnerBootstrap: true,
    secureCookies: secure
  });
  t.after(() => app.close());
  const boot = await app.server.inject({
    method: "POST",
    url: "/api/bootstrap/owner",
    payload: { bootstrapToken: "local-test-only", nickname: "Local test" }
  });
  const jar = cookieJar(boot);
  const me = (cookies = jar) => app.server.inject({ method: "GET", url: "/api/me", cookies });
  return { app, jar, me, userId: boot.json().user.id as string };
}

test("a browser that restarts before persisting a confirmed replacement stays signed in", async (t) => {
  const { app, jar, me } = await fixture(t, true);
  const persisted = { ...jar };
  t.mock.timers.tick(16 * 60_000);
  const rotated = await me();
  assert.equal(rotated.headers["x-voxly-session-rotated"], "1");
  applyCookies(jar, rotated);
  // The replacement reached the browser's memory and came straight back.
  assert.equal(
    (await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: jar })).statusCode,
    204
  );
  // The process dies before the cookie store is written; only the old value survives.
  t.mock.timers.tick(121_000);
  const reopened = await me(persisted);
  assert.equal(reopened.statusCode, 200, "a lost cookie write must not sign the member out");
  assert.ok(
    reopened.cookies.some((cookie) => cookie.value),
    "recovery issues a fresh credential"
  );
  const stale = app.sqlite
    .prepare("select count(*) as count from audit_events where action = 'session.stale_rejected'")
    .get();
  assert.equal(stale?.count, 0);
});

test("a confirmation after the persistence window makes the predecessor stale", async (t) => {
  const { app, jar, me } = await fixture(t);
  const original = { ...jar };
  t.mock.timers.tick(16 * 60_000);
  applyCookies(jar, await me());
  t.mock.timers.tick(5 * 60_000 + 1_000);
  assert.equal(
    (await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: jar })).statusCode,
    204
  );
  t.mock.timers.tick(121_000);
  const stale = await me(original);
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.json().error, "session_reused");
  assert.equal((await me(jar)).statusCode, 200);
});

test("a delayed renewal cannot overwrite a later confirmed rotation", async (t) => {
  const { app, jar, me } = await fixture(t);
  t.mock.timers.tick(16 * 60_000);
  await me(); // Lost first rotation.
  t.mock.timers.tick(121_000);
  applyCookies(jar, await me());
  await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: jar });
  t.mock.timers.tick(13 * 60_000);
  const renewal = await me(); // Touch renewal, but this token is not 15 minutes old.
  assert.equal(renewal.headers["x-voxly-session-rotated"], undefined);
  assert.ok(renewal.cookies.some((cookie) => cookie.value));
  t.mock.timers.tick(3 * 60_000);
  applyCookies(jar, await me());
  await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: jar });
  applyCookies(jar, renewal);
  t.mock.timers.tick(121_000);
  assert.equal((await me()).statusCode, 200);
});

test("a grace response cannot delete the browser's only recovery credential", async (t) => {
  const { jar, me } = await fixture(t);
  const original = { ...jar };
  t.mock.timers.tick(16 * 60_000);
  await me(); // Drop the replacement response.
  const concurrent = await me();
  applyCookies(jar, concurrent);
  assert.deepEqual(jar, original);
  t.mock.timers.tick(121_000);
  applyCookies(jar, await me());
  assert.equal((await me()).statusCode, 200);
});

test("all transports prefer the current token regardless of cookie order", async (t) => {
  const { app, jar, me, userId } = await fixture(t, true);
  const predecessor = { ...jar };
  t.mock.timers.tick(16 * 60_000);
  applyCookies(jar, await me());
  await me();
  t.mock.timers.tick(121_000);
  for (const cookies of [
    { ...predecessor, ...jar },
    { ...jar, ...predecessor }
  ]) {
    assert.equal((await me(cookies)).json().user.id, userId);
    assert.equal(
      authenticateSocket(
        databaseOf(app),
        Object.entries(cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join("; ")
      )?.id,
      userId
    );
    const request = { cookies, headers: {} } as Parameters<typeof authenticateWithoutRenewal>[1];
    assert.equal(authenticateWithoutRenewal(databaseOf(app), request)?.id, userId);
  }
  assert.equal(
    app.sqlite.prepare("select count(*) as n from audit_events where action = 'session.stale_rejected'").get()?.n,
    0
  );
});

test("legacy HTTP authentication upgrades without ending its Session", async (t) => {
  const { app, jar, me } = await fixture(t, true);
  const token = sessionToken(jar);
  const legacy = { "__Host-voxly_session": token };
  const response = await me(legacy);
  assert.equal(response.statusCode, 200);
  assert.equal(sessionToken(cookieJar(response)), token);
  assert.equal(app.sqlite.prepare("select count(*) as n from sessions").get()?.n, 1);
  assert.equal((await me(cookieJar(response))).statusCode, 200);
});

test("malformed protected candidates cannot be replaced by unprotected credentials", async (t) => {
  const { jar, me } = await fixture(t);
  const token = sessionToken(jar);
  assert.equal((await me({ ...jar, [`__Host-voxly_session_${"0".repeat(64)}`]: token })).statusCode, 401);
  assert.equal((await me({ ...jar, "__Host-voxly_session": "unknown" })).statusCode, 401);
});

test("the newest represented Session wins even at identical creation times", async (t) => {
  const { app, jar, me, userId } = await fixture(t);
  const token = createSession(databaseOf(app), userId);
  const mixed = { ...jar, [sessionCookieNameFor(token, false)]: token };
  const response = await me(mixed);
  assert.equal(response.statusCode, 200);
  const newest = app.sqlite.prepare("select id from sessions order by rowid desc limit 1").get();
  app.sqlite.prepare("update sessions set revoked_at = ? where id = ?").run(new Date().toISOString(), newest!.id!);
  assert.equal((await me(mixed)).statusCode, 401, "must not fall back to an older Session");
  assert.equal((await me(jar)).statusCode, 200);
});

test("rotation cleanup keeps the browser cookie jar bounded", async (t) => {
  const { jar, me } = await fixture(t);
  for (let count = 0; count < 40; count++) {
    t.mock.timers.tick(16 * 60_000);
    applyCookies(jar, await me());
    assert.equal(Object.keys(jar).length, 1);
    assert.equal((await me()).statusCode, 200);
  }
});

test("logout closes every accepted presented Session and preserves other Devices", async (t) => {
  const { app, jar, me, userId } = await fixture(t);
  const second = createSession(databaseOf(app), userId);
  const bystander = createSession(databaseOf(app), userId);
  const presented = { ...jar, [sessionCookieNameFor(second, false)]: second };
  const response = await app.server.inject({ method: "POST", url: "/api/logout", cookies: presented });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(applyCookies(presented, response), {});
  assert.equal((await me(jar)).statusCode, 401);
  assert.equal((await me({ [sessionCookieNameFor(second, false)]: second })).statusCode, 401);
  assert.equal((await me({ [sessionCookieNameFor(bystander, false)]: bystander })).statusCode, 200);
  const events = app.sqlite.prepare("select session_id from audit_events where action = 'session.logged_out'").all();
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => typeof event.session_id === "string"));
});

test("a rejected stale credential cannot revoke its successor through logout", async (t) => {
  const { app, jar, me } = await fixture(t);
  const original = { ...jar };
  t.mock.timers.tick(16 * 60_000);
  applyCookies(jar, await me());
  t.mock.timers.tick(5 * 60_000 + 1_000);
  await me();
  t.mock.timers.tick(121_000);
  await app.server.inject({ method: "POST", url: "/api/logout", cookies: original });
  assert.equal((await me()).statusCode, 200);
  assert.equal(
    app.sqlite.prepare("select count(*) as n from audit_events where action = 'session.stale_rejected'").get()?.n,
    1
  );
  assert.equal(
    app.sqlite.prepare("select count(*) as n from audit_events where action = 'session.logged_out'").get()?.n,
    0
  );
});

function databaseOf(app: VoxlyApp) {
  return { sqlite: app.sqlite, save() {}, close: () => app.sqlite.close() };
}

for (const legacyName of ["voxly_session", "__Host-voxly_session"]) {
  test(`upgrades legacy ${legacyName} and removes only presented names`, async (t) => {
    const { jar, me } = await fixture(t, true);
    const token = sessionToken(jar);
    const presented = { [legacyName]: token, unrelated: "preserve" };
    const response = await me(presented);
    assert.equal(response.statusCode, 200);
    const issued = cookieJar(response);
    assert.equal(sessionToken(issued), token);
    assert.deepEqual(
      response.cookies.filter((cookie) => !cookie.value).map((cookie) => cookie.name),
      [legacyName]
    );
    assert.equal(
      response.cookies.some((cookie) => cookie.name === "unrelated"),
      false
    );
  });
}

test("multiple Accounts use the newest represented Session without falling back after rejection", async (t) => {
  const { app, jar, me } = await fixture(t);
  app.sqlite.prepare("insert into users (id, nickname, role) values ('other', 'Other', 'member')").run();
  const token = createSession(databaseOf(app), "other");
  const newest = { [sessionCookieNameFor(token, false)]: token };
  for (const mixed of [
    { ...newest, ...jar },
    { ...jar, ...newest }
  ]) {
    assert.equal((await me(mixed)).json().user.id, "other");
    const header = Object.entries(mixed)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    assert.equal(authenticateSocket(databaseOf(app), header)?.id, "other");
  }
  app.sqlite.prepare("update users set banned_at = ? where id = 'other'").run(new Date().toISOString());
  const mixed = { ...jar, ...newest };
  assert.equal((await me(mixed)).statusCode, 401);
  assert.equal(
    authenticateSocket(
      databaseOf(app),
      Object.entries(mixed)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ")
    ),
    null
  );
  assert.equal((await me(jar)).statusCode, 200);
});

for (const deniedBy of ["expiry", "revocation", "ban", "deletion"]) {
  test(`${deniedBy} denies current and retired credentials on HTTP and Socket.IO`, async (t) => {
    const { app, jar, me, userId } = await fixture(t);
    const predecessor = { ...jar };
    t.mock.timers.tick(16 * 60_000);
    applyCookies(jar, await me());
    await me();
    if (deniedBy === "expiry") app.sqlite.prepare("update sessions set expires_at = ?").run(new Date().toISOString());
    if (deniedBy === "revocation")
      app.sqlite.prepare("update sessions set revoked_at = ?").run(new Date().toISOString());
    if (deniedBy === "ban")
      app.sqlite.prepare("update users set banned_at = ? where id = ?").run(new Date().toISOString(), userId);
    if (deniedBy === "deletion")
      app.sqlite.prepare("update users set deleted_at = ? where id = ?").run(new Date().toISOString(), userId);
    for (const cookies of [jar, predecessor, { ...predecessor, ...jar }]) {
      assert.equal((await me(cookies)).statusCode, 401);
      assert.equal(
        authenticateSocket(
          databaseOf(app),
          Object.entries(cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join("; ")
        ),
        null
      );
    }
  });
}
