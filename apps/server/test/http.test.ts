import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  requireJoinedServer,
  requireOwnedServer,
  roomIdParam,
  serverIdParam,
  userIdParam,
  type RouteContext
} from "../src/http.js";
import { createSession, sessionCookieName } from "../src/auth/sessions.js";
import { activateServerMembership } from "../src/members.js";
import { openDatabase, run, type VoxlyDatabase } from "../src/db/database.js";
import type { VoxlyIoServer } from "../src/socket.js";

const serverId = "server-1";
const memberId = "11111111-1111-4111-8111-111111111111";

/** Captures what a guard answered, without an HTTP round trip. */
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

function requestDouble(token: string | null, params: Record<string, string>) {
  return { cookies: token ? { [sessionCookieName]: token } : {}, params } as unknown as FastifyRequest;
}

describe("the shared route preamble", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  /** An account holding a live session, and the membership it holds in `server-1`. */
  async function seed(role: "owner" | "member", membership: "active" | "banned" | "none" = "active") {
    const db = await openDatabase(":memory:");
    database = db;
    run(db.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", [memberId, "Ada", role]);
    run(db.sqlite, "insert into servers (id, name, created_by_user_id, created_at) values (?, ?, ?, ?)", [
      serverId,
      "The Basement",
      memberId,
      new Date().toISOString()
    ]);
    if (membership !== "none") {
      activateServerMembership(db, serverId, memberId, role, new Date().toISOString());
    }
    if (membership === "banned") {
      run(db.sqlite, "update server_members set banned_at = ? where server_id = ? and user_id = ?", [
        new Date().toISOString(),
        serverId,
        memberId
      ]);
    }
    const token = createSession(db, memberId);
    const context = {
      database: db,
      secureCookies: true,
      // The preamble reads neither; the handlers that do are covered elsewhere.
      fastify: {} as RouteContext["fastify"],
      io: {} as VoxlyIoServer,
      realtime: {} as RouteContext["realtime"]
    } satisfies RouteContext;
    return { db, token, context };
  }

  describe("who it lets past", () => {
    it("hands an active owner their account and the path it named", async () => {
      const { token, context } = await seed("owner");
      const { reply, sent } = replyDouble();

      const scope = requireOwnedServer(context, requestDouble(token, { serverId }), reply);

      assert.equal(scope?.serverId, serverId);
      assert.equal(scope?.owner.id, memberId);
      assert.equal(sent.statusCode, null);
    });

    it("lets an ordinary member through the member scope but not the owner scope", async () => {
      const { token, context } = await seed("member");
      const asMember = replyDouble();
      const asOwner = replyDouble();

      assert.ok(requireJoinedServer(context, requestDouble(token, { serverId }), asMember.reply));
      assert.equal(requireOwnedServer(context, requestDouble(token, { serverId }), asOwner.reply), null);
      assert.equal(asOwner.sent.statusCode, 403);
    });
  });

  describe("who it turns away, and with which answer", () => {
    it("answers a caller with no session 401, before it looks at the path at all", async () => {
      const { context } = await seed("owner");
      const { reply, sent } = replyDouble();

      // A path that would not parse, so a 400 here would prove the order wrong.
      assert.equal(requireOwnedServer(context, requestDouble(null, {}), reply), null);
      assert.equal(sent.statusCode, 401);
    });

    it("answers a session with no business in that server 403", async () => {
      const { token, context } = await seed("owner", "none");
      const { reply, sent } = replyDouble();

      assert.equal(requireOwnedServer(context, requestDouble(token, { serverId }), reply), null);
      assert.equal(sent.statusCode, 403);
      assert.deepEqual(sent.body, { error: "server_forbidden" });
    });

    it("turns away a banned membership even though the session is still live", async () => {
      const { token, context } = await seed("member", "banned");
      const { reply, sent } = replyDouble();

      assert.equal(requireJoinedServer(context, requestDouble(token, { serverId }), reply), null);
      assert.equal(sent.statusCode, 403);
    });
  });

  describe("the path vocabulary", () => {
    it("parses the extra parameters a route names alongside the server", async () => {
      const { token, context } = await seed("owner");
      const { reply } = replyDouble();

      const scope = requireOwnedServer(
        context,
        requestDouble(token, { serverId, roomId: "lobby", userId: memberId }),
        reply,
        { roomId: roomIdParam, userId: userIdParam }
      );

      assert.equal(scope?.roomId, "lobby");
      assert.equal(scope?.userId, memberId);
    });

    it("refuses a member id that is not a uuid, so a readable one cannot be moderated past", async () => {
      // A bot account is given a UUID precisely so this holds; see AGENTS.md.
      assert.equal(userIdParam.safeParse("voxly-music-bot").success, false);
      assert.equal(userIdParam.safeParse(memberId).success, true);
    });

    it("accepts the legacy fixed room and server ids the default server still uses", () => {
      assert.equal(roomIdParam.safeParse("general").success, true);
      assert.equal(serverIdParam.safeParse("the-basement").success, true);
      assert.equal(serverIdParam.safeParse("").success, false);
    });

    it("raises a parse failure rather than answering it, so the error handler sends the 400", async () => {
      const { token, context } = await seed("owner");
      const { reply, sent } = replyDouble();

      assert.throws(
        () => requireOwnedServer(context, requestDouble(token, { serverId, userId: "not-a-uuid" }), reply, {
          userId: userIdParam
        }),
        z.ZodError
      );
      assert.equal(sent.statusCode, null);
    });
  });
});
