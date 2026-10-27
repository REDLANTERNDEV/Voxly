import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FastifyReply } from "fastify";
import { defaultServerId, openDatabase, run, type VoxlyDatabase } from "../src/db/database.js";
import type { PresenceChoiceState, PresenceUser } from "@voxly/shared";
import {
  activeServerIds,
  activeServerMembership,
  isServerOwner,
  mayCreateInvites,
  hasActiveServerMembership,
  requireServerInviter,
  requireServerMember,
  requireServerOwner,
  publicPresence,
  isVisiblyOnline,
  presenceChoiceFor,
  presenceStatusOf,
  readPresenceChoice,
  serverPresenceUsers,
  writePresenceChoice,
  type OnlineRegistry
} from "../src/members.js";

const joinedAt = "2026-01-01T00:00:00.000Z";

interface MemberOptions {
  role?: "owner" | "member";
  /** Banned from this server; the account itself stays usable elsewhere. */
  bannedAt?: string;
  /** Kicked from this server. */
  removedAt?: string;
  /** Banned globally, which must override every server membership. */
  globallyBannedAt?: string;
  canInvite?: boolean;
  /** An account with no row in `server_members` at all. */
  membership?: false;
}

/** Captures what a guard sent so a refusal can be asserted without an HTTP round trip. */
function replyDouble() {
  const sent: { statusCode: number | null; body: unknown } = { statusCode: null, body: null };
  const reply = {
    code(statusCode: number) {
      sent.statusCode = statusCode;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    }
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

describe("server membership", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  async function seed(members: Record<string, MemberOptions>): Promise<VoxlyDatabase> {
    const opened = await openDatabase(":memory:");
    database = opened;
    for (const [userId, options] of Object.entries(members)) {
      const role = options.role ?? "member";
      run(opened.sqlite, "insert into users (id, nickname, role, banned_at) values (?, ?, ?, ?)", [
        userId,
        userId,
        role,
        options.globallyBannedAt ?? null
      ]);
      if (options.membership === false) continue;
      run(
        opened.sqlite,
        `insert into server_members (server_id, user_id, role, banned_at, removed_at, can_invite, joined_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          defaultServerId,
          userId,
          role,
          options.bannedAt ?? null,
          options.removedAt ?? null,
          options.canInvite ? 1 : 0,
          joinedAt
        ]
      );
    }
    return opened;
  }

  describe("active membership", () => {
    it("returns the membership row of an active member", async () => {
      const { sqlite } = await seed({ member: {} });

      const membership = activeServerMembership(sqlite, defaultServerId, "member");

      assert.equal(membership?.user_id, "member");
      assert.equal(membership?.role, "member");
      assert.equal(hasActiveServerMembership(sqlite, defaultServerId, "member"), true);
    });

    it("denies banned, kicked, globally banned and unknown accounts", async () => {
      const { sqlite } = await seed({
        banned: { bannedAt: joinedAt },
        kicked: { removedAt: joinedAt },
        globallyBanned: { globallyBannedAt: joinedAt },
        stranger: { membership: false }
      });

      for (const userId of ["banned", "kicked", "globallyBanned", "stranger", "ghost"]) {
        assert.equal(
          activeServerMembership(sqlite, defaultServerId, userId),
          null,
          `${userId} must have no active membership`
        );
        assert.equal(hasActiveServerMembership(sqlite, defaultServerId, userId), false, `${userId} must be refused`);
      }
    });

    it("lists only the servers a user actively belongs to", async () => {
      const { sqlite } = await seed({ member: {} });
      for (const [serverId, membership] of [
        ["joined", ""],
        ["kicked-from", "removed_at"],
        ["banned-from", "banned_at"]
      ] as const) {
        run(sqlite, "insert into servers (id, name, created_at) values (?, ?, ?)", [serverId, serverId, joinedAt]);
        run(
          sqlite,
          `insert into server_members (server_id, user_id, role, ${membership || "banned_at"}, joined_at)
           values (?, ?, 'member', ?, ?)`,
          [serverId, "member", membership ? joinedAt : null, joinedAt]
        );
      }

      assert.deepEqual(activeServerIds(sqlite, "member").sort(), [defaultServerId, "joined"].sort());
      assert.deepEqual(activeServerIds(sqlite, "ghost"), []);
    });

    it("recognises only an active owner as the server owner", async () => {
      const { sqlite } = await seed({
        owner: { role: "owner" },
        formerOwner: { role: "owner", removedAt: joinedAt },
        bannedOwner: { role: "owner", bannedAt: joinedAt },
        member: {}
      });

      assert.equal(isServerOwner(sqlite, defaultServerId, "owner"), true);
      assert.equal(isServerOwner(sqlite, defaultServerId, "formerOwner"), false);
      assert.equal(isServerOwner(sqlite, defaultServerId, "bannedOwner"), false);
      assert.equal(isServerOwner(sqlite, defaultServerId, "member"), false);
      assert.equal(isServerOwner(sqlite, defaultServerId, "ghost"), false);
    });
  });

  describe("request guards", () => {
    it("admits an active member and refuses removed or banned ones", async () => {
      const db = await seed({ member: {}, kicked: { removedAt: joinedAt }, banned: { bannedAt: joinedAt } });

      const admitted = replyDouble();
      assert.equal(requireServerMember(db, defaultServerId, "member", admitted.reply)?.user_id, "member");
      assert.equal(admitted.sent.statusCode, null);

      for (const userId of ["kicked", "banned", "ghost"]) {
        const refused = replyDouble();
        assert.equal(requireServerMember(db, defaultServerId, userId, refused.reply), null);
        assert.equal(refused.sent.statusCode, 403);
        assert.deepEqual(refused.sent.body, { error: "server_forbidden" });
      }
    });

    it("reserves owner actions for the owner", async () => {
      const db = await seed({
        owner: { role: "owner" },
        member: {},
        formerOwner: { role: "owner", removedAt: joinedAt }
      });

      const admitted = replyDouble();
      assert.equal(requireServerOwner(db, defaultServerId, "owner", admitted.reply)?.role, "owner");
      assert.equal(admitted.sent.statusCode, null);

      const member = replyDouble();
      assert.equal(requireServerOwner(db, defaultServerId, "member", member.reply), null);
      assert.equal(member.sent.statusCode, 403);
      assert.deepEqual(member.sent.body, { error: "forbidden" });

      // A removed owner is not a member at all, so membership fails before the role does.
      const formerOwner = replyDouble();
      assert.equal(requireServerOwner(db, defaultServerId, "formerOwner", formerOwner.reply), null);
      assert.deepEqual(formerOwner.sent.body, { error: "server_forbidden" });
    });

    it("treats an owner as able to invite whether or not the grant is set", () => {
      assert.equal(mayCreateInvites("owner", 0), true);
      assert.equal(mayCreateInvites("member", 0), false);
      assert.equal(mayCreateInvites("member", 1), true);
    });

    it("admits an owner or a granted inviter, but not a plain member", async () => {
      const db = await seed({ owner: { role: "owner" }, inviter: { canInvite: true }, member: {} });

      for (const userId of ["owner", "inviter"]) {
        const admitted = replyDouble();
        assert.equal(requireServerInviter(db, defaultServerId, userId, admitted.reply)?.user_id, userId);
        assert.equal(admitted.sent.statusCode, null, `${userId} may create invites`);
      }

      const refused = replyDouble();
      assert.equal(requireServerInviter(db, defaultServerId, "member", refused.reply), null);
      assert.equal(refused.sent.statusCode, 403);
      assert.deepEqual(refused.sent.body, { error: "forbidden" });
    });
  });

  describe("presence", () => {
    function registry(
      entries: Record<string, { sockets: string[]; idleSockets?: string[]; choice?: PresenceChoiceState }>
    ): OnlineRegistry {
      const online: OnlineRegistry = new Map();
      for (const [userId, entry] of Object.entries(entries)) {
        online.set(userId, {
          user: { userId, nickname: userId, role: "member" },
          sockets: new Set(entry.sockets),
          idleSockets: new Set(entry.idleSockets ?? []),
          choice: entry.choice ?? { status: "online", until: null }
        });
      }
      return online;
    }

    it("reads a member as idle only when every one of their tabs is idle", () => {
      const online = registry({
        away: { sockets: ["a", "b"], idleSockets: ["a", "b"] },
        working: { sockets: ["c", "d"], idleSockets: ["c"] },
        fresh: { sockets: ["e"] }
      });

      assert.equal(presenceStatusOf(online, "away"), "idle");
      assert.equal(presenceStatusOf(online, "working"), "online");
      assert.equal(presenceStatusOf(online, "fresh"), "online");
      // A user with no entry is not connected at all; "online" is the neutral
      // default the shared contract gives an absent status.
      assert.equal(presenceStatusOf(online, "offline"), "online");
    });

    it("lists the connected members of a server with their status", async () => {
      const { sqlite } = await seed({
        owner: { role: "owner" },
        idler: {},
        offline: {},
        kicked: { removedAt: joinedAt }
      });
      const online = registry({
        owner: { sockets: ["a"] },
        idler: { sockets: ["b"], idleSockets: ["b"] },
        kicked: { sockets: ["c"] }
      });

      const users = serverPresenceUsers(sqlite, online, defaultServerId, "owner");

      assert.deepEqual(
        users.map((user) => ({ userId: user.userId, role: user.role, status: user.status })),
        [
          { userId: "idler", role: "member", status: "idle" },
          { userId: "owner", role: "owner", status: "online" }
        ]
      );
    });

    it("lets a picked Status outrank what the connections measured", () => {
      const online = registry({
        busy: { sockets: ["a"], choice: { status: "dnd", until: null } },
        resting: { sockets: ["b"], choice: { status: "idle", until: null } },
        busyButIdle: { sockets: ["c"], idleSockets: ["c"], choice: { status: "dnd", until: null } },
        hiding: { sockets: ["d"], choice: { status: "invisible", until: null } },
        lapsed: { sockets: ["e"], choice: { status: "dnd", until: "2026-01-01T00:00:00.000Z" } }
      });
      const now = Date.parse("2026-06-01T00:00:00.000Z");

      assert.equal(presenceStatusOf(online, "busy", now), "dnd");
      assert.equal(presenceStatusOf(online, "resting", now), "idle");
      assert.equal(presenceStatusOf(online, "busyButIdle", now), "dnd");
      assert.equal(presenceStatusOf(online, "lapsed", now), "online");
      assert.equal(isVisiblyOnline(online, "hiding", now), false);
      assert.equal(isVisiblyOnline(online, "busy", now), true);
      assert.equal(isVisiblyOnline(online, "nobody", now), false);
    });

    it("lists an invisible member only to themselves", async () => {
      const { sqlite } = await seed({ owner: { role: "owner" }, hider: {} });
      const online = registry({
        owner: { sockets: ["a"] },
        hider: { sockets: ["b"], choice: { status: "invisible", until: null } }
      });

      assert.deepEqual(
        serverPresenceUsers(sqlite, online, defaultServerId, "owner").map((user) => user.userId),
        ["owner"]
      );
      assert.deepEqual(
        serverPresenceUsers(sqlite, online, defaultServerId, "hider").map((user) => user.userId),
        ["hider", "owner"]
      );
    });

    it("stores a picked Status with its expiry and reads a lapsed one as Online", async () => {
      const { sqlite } = await seed({ owner: { role: "owner" } });
      const now = Date.parse("2026-06-01T00:00:00.000Z");

      const timed = presenceChoiceFor({ status: "dnd", duration: { mode: "timed", durationMinutes: 60 } }, now);
      assert.deepEqual(timed, { status: "dnd", until: "2026-06-01T01:00:00.000Z" });
      writePresenceChoice(sqlite, "owner", timed);
      assert.deepEqual(readPresenceChoice(sqlite, "owner", now), timed);
      assert.deepEqual(readPresenceChoice(sqlite, "owner", now + 60 * 60_000), { status: "online", until: null });

      const forever = presenceChoiceFor({ status: "invisible", duration: { mode: "indefinite" } }, now);
      writePresenceChoice(sqlite, "owner", forever);
      assert.deepEqual(readPresenceChoice(sqlite, "owner", now + 365 * 24 * 60 * 60_000), {
        status: "invisible",
        until: null
      });
      assert.deepEqual(readPresenceChoice(sqlite, "nobody", now), { status: "online", until: null });
    });

    it("builds the socket identity from the authenticated session", () => {
      const presence: PresenceUser = publicPresence({
        id: "user-1",
        nickname: "Red Lantern",
        role: "owner",
        isBot: false
      });

      assert.deepEqual(presence, { userId: "user-1", nickname: "Red Lantern", role: "owner", isBot: false });
    });
  });
});
