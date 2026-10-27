import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import Fastify from "fastify";
import {
  accountInviteTrail,
  activeInviteCount,
  createInviteForServer,
  deleteUnusedPastInvites,
  inviteBodySchema,
  inviteUseCount,
  isExpired,
  registerInviteRoutes,
  revokeInvitesCreatedBy,
  serverInvites
} from "../src/invites.js";
import type { RealtimeModeration, RouteContext } from "../src/http.js";
import { all, defaultServerId, one, openDatabase, run, type VoxlyDatabase } from "../src/db/database.js";
import { hashToken } from "../src/auth/tokens.js";
import { activateServerMembership } from "../src/members.js";
import { createUser } from "../src/users.js";
import type { VoxlyIoServer } from "../src/socket.js";

type InviteRow = {
  id: string;
  token_hash: string;
  expires_at: string | null;
  max_uses: number | null;
  revoked_at: string | null;
};

describe("invites and access links", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  async function open() {
    database = await openDatabase(":memory:");
    return database;
  }

  function storedInvite(db: VoxlyDatabase, inviteId: string) {
    return one<InviteRow>(
      db.sqlite,
      "select id, token_hash, expires_at, max_uses, revoked_at from invites where id = ?",
      [inviteId]
    );
  }

  describe("what an owner may ask for", () => {
    it("accepts only the offered expiry and capacity values, so a link cannot be given an arbitrary life", () => {
      assert.equal(inviteBodySchema.safeParse({ label: "Friends", expiresInMinutes: 1440 }).success, true);
      assert.equal(inviteBodySchema.safeParse({ label: "Friends", maxUses: 25 }).success, true);
      assert.equal(inviteBodySchema.safeParse({ label: "Friends", expiresInMinutes: 90 }).success, false);
      assert.equal(inviteBodySchema.safeParse({ label: "Friends", maxUses: 3 }).success, false);
    });

    it("treats expiry and capacity as independent limits, each nullable on its own", () => {
      assert.equal(inviteBodySchema.safeParse({ label: "Friends", expiresInMinutes: null, maxUses: 10 }).success, true);
      assert.equal(inviteBodySchema.safeParse({ label: "Friends", expiresInMinutes: 60, maxUses: null }).success, true);
    });

    it("refuses the removed hours shape rather than quietly ignoring it", () => {
      assert.equal(inviteBodySchema.safeParse({ label: "Friends", expiresInHours: 24 }).success, false);
    });
  });

  describe("minting a link", () => {
    it("bounds an omitted expiry rather than making it permanent, and admits one person", async () => {
      const db = await open();
      const before = Date.now();

      const invite = createInviteForServer(db, "server-1", "owner-1", { label: "Friends" });

      assert.equal(invite.maxUses, 1);
      assert.notEqual(invite.expiresAt, null);
      // The seven-day default. The deadline is taken inside the call, so it can
      // only sit at or after seven days from the reading above, never before.
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const life = new Date(invite.expiresAt as string).getTime() - before;
      assert.ok(life >= sevenDays && life < sevenDays + 60_000, `expiry ${life}ms away, expected about ${sevenDays}ms`);
    });

    it("makes a link permanent only when an owner asks for it in so many words", async () => {
      const db = await open();

      const invite = createInviteForServer(db, "server-1", "owner-1", { label: "Standing", expiresInMinutes: null });

      assert.equal(invite.expiresAt, null);
      assert.equal(storedInvite(db, invite.id)?.expires_at, null);
    });

    it("stores the token only as a hash, and hands the raw one back exactly once", async () => {
      const db = await open();

      const invite = createInviteForServer(db, "server-1", "owner-1", { label: "Friends" });

      assert.equal(storedInvite(db, invite.id)?.token_hash, hashToken(invite.token));
      assert.notEqual(storedInvite(db, invite.id)?.token_hash, invite.token);
      assert.equal(all(db.sqlite, "select id from invites where token_hash = ?", [invite.token]).length, 0);
    });
  });

  describe("a nullable deadline", () => {
    it("reads no deadline as no limit rather than as expired", () => {
      assert.equal(isExpired(null), false);
    });

    it("counts a deadline that has already come as passed", () => {
      assert.equal(isExpired(new Date(Date.now() - 1000).toISOString()), true);
      assert.equal(isExpired(new Date(Date.now() + 60_000).toISOString()), false);
    });
  });

  describe("what a member still has outstanding", () => {
    it("counts neither revoked nor expired links, and only that member's own", async () => {
      const db = await open();
      const mine = createInviteForServer(db, "server-1", "member-1", { label: "Mine" });
      createInviteForServer(db, "server-1", "member-2", { label: "Theirs" });
      const expired = createInviteForServer(db, "server-1", "member-1", { label: "Old", expiresInMinutes: 30 });
      run(db.sqlite, "update invites set expires_at = ? where id = ?", [
        new Date(Date.now() - 1000).toISOString(),
        expired.id
      ]);
      const revoked = createInviteForServer(db, "server-1", "member-1", { label: "Gone" });
      run(db.sqlite, "update invites set revoked_at = ? where id = ?", [new Date().toISOString(), revoked.id]);

      assert.equal(activeInviteCount(db.sqlite, "server-1", "member-1"), 1);
      assert.equal(activeInviteCount(db.sqlite, "server-2", "member-1"), 0);
      assert.equal(storedInvite(db, mine.id)?.revoked_at, null);
    });

    it("counts one use per account, from the uses table rather than the legacy first-use columns", async () => {
      const db = await open();
      const invite = createInviteForServer(db, "server-1", "owner-1", { label: "Friends", maxUses: 10 });

      assert.equal(inviteUseCount(db.sqlite, invite.id), 0);
      run(db.sqlite, "insert into invite_uses (invite_id, user_id, used_at) values (?, ?, ?)", [
        invite.id,
        "user-1",
        new Date().toISOString()
      ]);
      run(db.sqlite, "insert into invite_uses (invite_id, user_id, used_at) values (?, ?, ?)", [
        invite.id,
        "user-2",
        new Date().toISOString()
      ]);

      assert.equal(inviteUseCount(db.sqlite, invite.id), 2);
    });
  });

  describe("taking a member's outstanding links with them", () => {
    it("revokes what they still have live on that server, and nothing on another", async () => {
      const db = await open();
      const here = createInviteForServer(db, "server-1", "member-1", { label: "Here" });
      const elsewhere = createInviteForServer(db, "server-2", "member-1", { label: "Elsewhere" });
      const someoneElse = createInviteForServer(db, "server-1", "member-2", { label: "Not theirs" });
      const now = new Date().toISOString();

      revokeInvitesCreatedBy(db, "server-1", "member-1", now);

      assert.equal(storedInvite(db, here.id)?.revoked_at, now);
      assert.equal(storedInvite(db, elsewhere.id)?.revoked_at, null);
      assert.equal(storedInvite(db, someoneElse.id)?.revoked_at, null);
    });

    it("leaves an already-revoked or already-expired row its original timestamps, so the trail keeps them", async () => {
      const db = await open();
      const alreadyRevoked = createInviteForServer(db, "server-1", "member-1", { label: "Old" });
      const earlier = new Date(Date.now() - 60_000).toISOString();
      run(db.sqlite, "update invites set revoked_at = ? where id = ?", [earlier, alreadyRevoked.id]);
      const expired = createInviteForServer(db, "server-1", "member-1", { label: "Lapsed", expiresInMinutes: 30 });
      run(db.sqlite, "update invites set expires_at = ? where id = ?", [earlier, expired.id]);

      revokeInvitesCreatedBy(db, "server-1", "member-1", new Date().toISOString());

      assert.equal(storedInvite(db, alreadyRevoked.id)?.revoked_at, earlier);
      assert.equal(storedInvite(db, expired.id)?.revoked_at, null);
    });
  });

  describe("the list an owner reads back", () => {
    it("reports each link's use count and stays inside the one server", async () => {
      const db = await open();
      const invite = createInviteForServer(db, "server-1", "owner-1", { label: "Friends", maxUses: 10 });
      createInviteForServer(db, "server-2", "owner-1", { label: "Elsewhere" });
      run(db.sqlite, "insert into invite_uses (invite_id, user_id, used_at) values (?, ?, ?)", [
        invite.id,
        "user-1",
        new Date().toISOString()
      ]);

      const listed = serverInvites(db.sqlite, "server-1") as { id: string; label: string; usedCount: number }[];

      assert.deepEqual(
        listed.map((row) => [row.id, row.label, row.usedCount]),
        [[invite.id, "Friends", 1]]
      );
    });

    it("never hands the token back, only what the link is and how much of it is left", async () => {
      const db = await open();
      const invite = createInviteForServer(db, defaultServerId, "owner-1", { label: "Friends" });

      const [listed] = serverInvites(db.sqlite, defaultServerId) as Record<string, unknown>[];

      assert.ok(listed);
      assert.equal(Object.values(listed).includes(invite.token), false);
      assert.equal("tokenHash" in listed, false);
    });
  });

  describe("the Invite trail", () => {
    const day = 24 * 60 * 60 * 1000;

    async function server() {
      const db = await open();
      const owner = createUser(db, "Owner", "owner");
      activateServerMembership(db, defaultServerId, owner.id, "owner", new Date().toISOString());
      return { db, owner };
    }

    function join(db: VoxlyDatabase, inviteId: string, nickname: string, at = new Date().toISOString()) {
      const person = createUser(db, nickname, "member");
      activateServerMembership(db, defaultServerId, person.id, "member", at);
      run(db.sqlite, "insert into invite_uses (invite_id, user_id, used_at) values (?, ?, ?)", [
        inviteId,
        person.id,
        at
      ]);
      return person;
    }

    type Listed = {
      id: string;
      createdBy: { userId: string; nickname: string | null; mentionCode: string | null; state: string };
      uses: Array<{
        userId: string;
        nickname: string | null;
        mentionCode: string | null;
        state: string;
        joinedAt: string;
      }>;
      inactiveSince: string | null;
    };
    const listed = (db: VoxlyDatabase) => serverInvites(db.sqlite, defaultServerId) as Listed[];

    it("names each invite's creator by their nickname here and Mention code, and a deleted one by neither", async () => {
      const { db, owner } = await server();
      const ownInvite = createInviteForServer(db, defaultServerId, owner.id, { label: "Owner's" });
      const ada = join(db, ownInvite.id, "Ada");
      run(db.sqlite, "update server_members set nickname = 'Ada here', can_invite = 1 where user_id = ?", [ada.id]);
      const delegated = createInviteForServer(db, defaultServerId, ada.id, { label: "Ada's" });
      const gone = join(db, ownInvite.id, "Gone");
      const fromGone = createInviteForServer(db, defaultServerId, gone.id, { label: "Gone's" });
      run(db.sqlite, "update users set nickname = '', deleted_at = ? where id = ?", [
        new Date().toISOString(),
        gone.id
      ]);

      const byId = new Map(listed(db).map((invite) => [invite.id, invite.createdBy]));
      const code = (userId: string) =>
        one<{ mention_code: string }>(db.sqlite, "select mention_code from server_members where user_id = ?", [userId])
          ?.mention_code;

      assert.deepEqual(byId.get(ownInvite.id), {
        userId: owner.id,
        nickname: "Owner",
        mentionCode: code(owner.id),
        state: "active"
      });
      assert.deepEqual(byId.get(delegated.id), {
        userId: ada.id,
        nickname: "Ada here",
        mentionCode: code(ada.id),
        state: "active"
      });
      assert.deepEqual(byId.get(fromGone.id), { userId: gone.id, nickname: null, mentionCode: null, state: "deleted" });
    });

    it("lists who joined through an invite, newest first, each with their own state", async () => {
      const { db, owner } = await server();
      const invite = createInviteForServer(db, defaultServerId, owner.id, { label: "Many", maxUses: 10 });
      const at = (offset: number) => new Date(Date.now() - offset * 60_000).toISOString();
      const active = join(db, invite.id, "Active", at(4));
      const kicked = join(db, invite.id, "Kicked", at(3));
      const banned = join(db, invite.id, "Banned", at(2));
      const deleted = join(db, invite.id, "Deleted", at(1));
      run(db.sqlite, "update server_members set removed_at = ? where user_id = ?", [at(0), kicked.id]);
      run(db.sqlite, "update server_members set banned_at = ? where user_id = ?", [at(0), banned.id]);
      run(db.sqlite, "update users set nickname = '', deleted_at = ? where id = ?", [at(0), deleted.id]);
      run(db.sqlite, "update server_members set nickname = null, removed_at = ? where user_id = ?", [
        at(0),
        deleted.id
      ]);

      const [trail] = listed(db);

      assert.deepEqual(
        trail?.uses.map((use) => [use.userId, use.nickname, use.state]),
        [
          [deleted.id, null, "deleted"],
          [banned.id, "Banned", "banned"],
          [kicked.id, "Kicked", "kicked"],
          [active.id, "Active", "active"]
        ]
      );
      assert.equal(trail?.uses[0]?.mentionCode, null);
    });

    it("says when an invite stopped being active: revoked, expired, or its last use filled it", async () => {
      const { db, owner } = await server();
      const live = createInviteForServer(db, defaultServerId, owner.id, { label: "Live" });
      const usedUp = createInviteForServer(db, defaultServerId, owner.id, { label: "Used up" });
      const filledAt = new Date(Date.now() - 5000).toISOString();
      join(db, usedUp.id, "Ada", filledAt);
      const revoked = createInviteForServer(db, defaultServerId, owner.id, { label: "Revoked" });
      const revokedAt = new Date(Date.now() - 3000).toISOString();
      run(db.sqlite, "update invites set revoked_at = ? where id = ?", [revokedAt, revoked.id]);

      const since = new Map(listed(db).map((invite) => [invite.id, invite.inactiveSince]));

      assert.equal(since.get(live.id), null);
      assert.equal(since.get(usedUp.id), filledAt);
      assert.equal(since.get(revoked.id), revokedAt);
    });

    it("deletes an unused past invite 30 days after it stopped being active, and never one anybody used", async () => {
      const { db, owner } = await server();
      const now = Date.now();
      const ago = (days: number) => new Date(now - days * day).toISOString();
      const invite = (label: string, change: string, value: string, maxUses: 1 | 5 = 1) => {
        const created = createInviteForServer(db, defaultServerId, owner.id, { label, maxUses });
        run(db.sqlite, `update invites set ${change} = ? where id = ?`, [value, created.id]);
        return created.id;
      };
      const expiredLongAgo = invite("expired 30", "expires_at", ago(30));
      const expiredRecently = invite("expired 29", "expires_at", ago(29));
      const revokedLongAgo = invite("revoked 30", "revoked_at", ago(30));
      const revokedRecently = invite("revoked 29", "revoked_at", ago(29));
      const expiredUsed = invite("expired used", "expires_at", ago(90), 5);
      join(db, expiredUsed, "Ada", ago(100));
      const revokedUsed = invite("revoked used", "revoked_at", ago(90), 5);
      join(db, revokedUsed, "Bea", ago(100));
      const usedUp = invite("used up", "created_at", ago(120));
      join(db, usedUp, "Cem", ago(100));
      const live = createInviteForServer(db, defaultServerId, owner.id, { label: "Live" }).id;

      assert.equal(deleteUnusedPastInvites(db.sqlite, defaultServerId, now), 2);

      const remaining = new Set(all<{ id: string }>(db.sqlite, "select id from invites").map((row) => row.id));
      assert.equal(remaining.has(expiredLongAgo), false);
      assert.equal(remaining.has(revokedLongAgo), false);
      for (const kept of [expiredRecently, revokedRecently, expiredUsed, revokedUsed, usedUp, live]) {
        assert.equal(remaining.has(kept), true);
      }
    });

    it("cleans up only the Server whose list is read", async () => {
      const { db, owner } = await server();
      const elsewhere = createInviteForServer(db, "server-2", owner.id, { label: "Elsewhere" });
      run(db.sqlite, "update invites set revoked_at = ? where id = ?", [
        new Date(Date.now() - 60 * day).toISOString(),
        elsewhere.id
      ]);

      assert.equal(deleteUnusedPastInvites(db.sqlite, defaultServerId), 0);
      assert.equal(storedInvite(db, elsewhere.id)?.id, elsewhere.id);
    });

    it("shows one Account how it joined each Server and whom its own invites brought in", async () => {
      const { db, owner } = await server();
      const first = createInviteForServer(db, defaultServerId, owner.id, { label: "For Ada" });
      const ada = join(db, first.id, "Ada", new Date(Date.now() - 60_000).toISOString());
      const adas = createInviteForServer(db, defaultServerId, ada.id, { label: "Ada's", maxUses: 5 });
      const bea = join(db, adas.id, "Bea", new Date(Date.now() - 30_000).toISOString());
      const cem = join(db, adas.id, "Cem");

      const forAda = accountInviteTrail(db.sqlite, ada.id);
      assert.equal(forAda.joined.get(defaultServerId)?.inviteId, first.id);
      assert.equal(forAda.joined.get(defaultServerId)?.label, "For Ada");
      assert.equal(forAda.joined.get(defaultServerId)?.inviter.userId, owner.id);
      assert.deepEqual(
        forAda.invited.map((group) => [
          group.serverId,
          group.people.map((person) => [person.userId, person.inviteLabel])
        ]),
        [
          [
            defaultServerId,
            [
              [cem.id, "Ada's"],
              [bea.id, "Ada's"]
            ]
          ]
        ]
      );

      const forOwner = accountInviteTrail(db.sqlite, owner.id);
      assert.equal(forOwner.joined.size, 0, "the founder joined through no invite");
    });
  });

  describe("the routes it registers", () => {
    it("owns both ways into a server and nothing beyond them", async () => {
      const db = await open();
      const http = Fastify();
      const registered: string[] = [];
      http.addHook("onRoute", (route) => {
        registered.push(`${String(route.method)} ${route.url}`);
      });

      registerInviteRoutes({
        fastify: http,
        database: db,
        // Registration touches neither; the handlers that do are covered by app.test.ts.
        io: {} as VoxlyIoServer,
        realtime: {} as RealtimeModeration,
        secureCookies: true
      } satisfies RouteContext);
      await http.close();

      // Fastify pairs a HEAD with every GET; the point of the assertion is the
      // set of paths this module claims, so a route that drifts in from a
      // neighbouring group during tickets 18 and 19 fails here rather than
      // silently. `POST /api/setup/owner/claim` is deliberately absent: it is
      // owner recovery, and `auth/ownerClaims.ts` owns it.
      assert.deepEqual(registered.sort(), [
        "GET /api/owner/invites",
        "GET /api/servers/:serverId/invites",
        "HEAD /api/owner/invites",
        "HEAD /api/servers/:serverId/invites",
        "POST /api/access/claim",
        "POST /api/invites/accept",
        "POST /api/invites/preview",
        "POST /api/owner/invites",
        "POST /api/owner/invites/:inviteId/revoke",
        "POST /api/servers/:serverId/invites",
        "POST /api/servers/:serverId/invites/:inviteId/revoke",
        "POST /api/servers/:serverId/members/:userId/access-links"
      ]);
    });
  });
});
