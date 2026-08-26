import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { replyExcerptMaxLength } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { publicMessage, registerMessageRoutes, replyExcerpt, type MessageRow } from "../src/messages.js";
import type { RealtimeModeration, RouteContext } from "../src/http.js";
import { openDatabase, type VoxlyDatabase } from "../src/db/database.js";
import type { VoxlyIoServer } from "../src/socket.js";

function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "message-1",
    roomId: "general",
    userId: "user-1",
    nickname: "Deniz",
    body: "oyuna giriyorum",
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    suppressedEmbedKeysJson: null,
    replyToMessageId: null,
    replyToUserId: null,
    replyToNickname: null,
    replyToBody: null,
    ...overrides
  };
}

describe("messages", () => {
  describe("the shape a caller reads back", () => {
    it("reads a row with no suppression list as an empty one", () => {
      assert.deepEqual(publicMessage(messageRow()).suppressedEmbedKeys, []);
      assert.deepEqual(publicMessage(messageRow({ suppressedEmbedKeysJson: "[]" })).suppressedEmbedKeys, []);
    });

    it("answers with an empty list rather than throwing when the stored value is not JSON", () => {
      // A read of one bad row must not turn every read of that room's history
      // into a 500, so the parse is defensive rather than trusting.
      assert.deepEqual(publicMessage(messageRow({ suppressedEmbedKeysJson: "not json" })).suppressedEmbedKeys, []);
    });

    it("answers with an empty list when the stored value is valid JSON but not an array", () => {
      for (const stored of ['{"youtube":"a"}', '"youtube:a"', "42", "null"]) {
        assert.deepEqual(publicMessage(messageRow({ suppressedEmbedKeysJson: stored })).suppressedEmbedKeys, []);
      }
    });

    it("drops non-string entries rather than handing them to the client", () => {
      assert.deepEqual(
        publicMessage(messageRow({ suppressedEmbedKeysJson: '["youtube:a", 7, null, "x:b"]' })).suppressedEmbedKeys,
        ["youtube:a", "x:b"]
      );
    });

    it("clamps a stored list to the same ceiling the embeds route refuses past", () => {
      const stored = Array.from({ length: 40 }, (_, index) => `youtube:k${index}`);
      const read = publicMessage(messageRow({ suppressedEmbedKeysJson: JSON.stringify(stored) })).suppressedEmbedKeys;

      assert.equal(read.length, 16);
      assert.equal(read.at(-1), "youtube:k15");
    });

    it("carries a quote only while the quoted message is still live", () => {
      const quoted = publicMessage(messageRow({
        replyToMessageId: "message-0",
        replyToUserId: "user-0",
        replyToNickname: "Ada",
        replyToBody: "the original"
      }));
      assert.deepEqual(quoted.replyTo, {
        messageId: "message-0",
        userId: "user-0",
        nickname: "Ada",
        body: "the original"
      });

      // The target has since been deleted: the join finds nothing, the reply
      // itself stays, and only the excerpt goes.
      const orphaned = publicMessage(messageRow({ replyToMessageId: "message-0" }));
      assert.equal(orphaned.replyToMessageId, "message-0");
      assert.equal(orphaned.replyTo, null);
    });
  });

  describe("the excerpt behind a reply", () => {
    it("collapses the quote to one line", () => {
      assert.equal(replyExcerpt("  first\n\tsecond   third  "), "first second third");
    });

    it("trims a long body rather than sending it again behind every answer", () => {
      const excerpt = replyExcerpt("x".repeat(replyExcerptMaxLength + 50));

      assert.equal(excerpt.length, replyExcerptMaxLength + 1);
      assert.equal(excerpt.endsWith("…"), true);
    });

    it("leaves a body at the limit exactly as it is", () => {
      const body = "x".repeat(replyExcerptMaxLength);

      assert.equal(replyExcerpt(body), body);
    });
  });

  describe("the routes it registers", () => {
    let database: VoxlyDatabase | undefined;

    afterEach(() => {
      database?.close();
      database = undefined;
    });

    it("owns the message lifecycle, and nothing beyond it", async () => {
      database = await openDatabase(":memory:");
      const http = Fastify();
      const registered: string[] = [];
      http.addHook("onRoute", (route) => {
        registered.push(`${String(route.method)} ${route.url}`);
      });

      registerMessageRoutes({
        fastify: http,
        database,
        // Registration touches neither; the handlers that do are covered below
        // and by app.test.ts.
        io: {} as VoxlyIoServer,
        realtime: {} as RealtimeModeration,
        secureCookies: true
      } satisfies RouteContext);
      await http.close();

      // Fastify pairs a HEAD with every GET; the point of the assertion is the
      // set of paths this module claims, so a route that drifts in from a
      // neighbouring group during ticket 19 fails here rather than silently.
      assert.deepEqual(registered.sort(), [
        "DELETE /api/rooms/:roomId/messages/:messageId",
        "GET /api/rooms/:roomId/messages",
        "HEAD /api/rooms/:roomId/messages",
        "PATCH /api/rooms/:roomId/messages/:messageId",
        "PATCH /api/rooms/:roomId/messages/:messageId/embeds",
        "POST /api/rooms/:roomId/messages"
      ]);
    });
  });

  /**
   * The five routes do not share one preamble, and the differences are
   * observable. Reading, editing, suppressing and deleting treat a voice room
   * as a room with no such message in it — a 404 answered before membership is
   * even consulted. Posting is the one request worth refusing on its own terms,
   * so it answers a real room with a 400 and only after the caller has been
   * shown to belong there. These are the tests that fail if that asymmetry is
   * ever flattened into one shared guard.
   */
  describe("how a room that cannot hold the message is refused", () => {
    let app: VoxlyApp;

    beforeEach(async () => {
      app = await createVoxlyApp({
        databasePath: ":memory:",
        ownerBootstrapToken: "bootstrap-secret",
        allowHttpOwnerBootstrap: true,
        secureCookies: false
      });
    });

    afterEach(async () => {
      await app.close();
    });

    /** The rooms of a server nobody but the bootstrapped owner belongs to. */
    async function elsewhere(ownerCookies: Record<string, string>) {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/servers",
        cookies: ownerCookies,
        payload: { name: "Elsewhere" }
      });
      assert.equal(created.statusCode, 201);
      const serverId = created.json().server.id as string;

      const listed = await app.server.inject({
        method: "GET",
        url: `/api/servers/${serverId}/rooms`,
        cookies: ownerCookies
      });
      const rooms = listed.json().rooms as Array<{ id: string; kind: string }>;
      return {
        text: rooms.find((room) => room.kind === "text")?.id as string,
        voice: rooms.find((room) => room.kind === "voice")?.id as string
      };
    }

    /** The default server's voice room, which every member can see but none may post in. */
    async function defaultVoiceRoom(cookies: Record<string, string>) {
      const listed = await app.server.inject({ method: "GET", url: "/api/rooms", cookies });
      const rooms = listed.json().rooms as Array<{ id: string; kind: string }>;
      return rooms.find((room) => room.kind === "voice")?.id as string;
    }

    it("answers a member reading, editing, suppressing or deleting in a voice room with a 404", async () => {
      const owner = await bootstrapOwner(app);
      const member = await acceptInvite(app, owner.cookies, "Deniz");
      const voiceRoom = await defaultVoiceRoom(member.cookies);
      const messageId = "00000000-0000-4000-8000-000000000000";

      const attempts = await Promise.all([
        app.server.inject({ method: "GET", url: `/api/rooms/${voiceRoom}/messages`, cookies: member.cookies }),
        app.server.inject({
          method: "PATCH",
          url: `/api/rooms/${voiceRoom}/messages/${messageId}`,
          cookies: member.cookies,
          payload: { body: "olmamalı" }
        }),
        app.server.inject({
          method: "PATCH",
          url: `/api/rooms/${voiceRoom}/messages/${messageId}/embeds`,
          cookies: member.cookies,
          payload: { embedKey: "youtube:dQw4w9WgXcQ" }
        }),
        app.server.inject({ method: "DELETE", url: `/api/rooms/${voiceRoom}/messages/${messageId}`, cookies: member.cookies })
      ]);

      for (const attempt of attempts) {
        assert.equal(attempt.statusCode, 404);
        assert.equal(attempt.json().error, "room_not_found");
      }
    });

    it("refuses a post into a voice room for what it asks rather than for what it names", async () => {
      const owner = await bootstrapOwner(app);
      const member = await acceptInvite(app, owner.cookies, "Deniz");
      const voiceRoom = await defaultVoiceRoom(member.cookies);

      const response = await app.server.inject({
        method: "POST",
        url: `/api/rooms/${voiceRoom}/messages`,
        cookies: member.cookies,
        payload: { body: "olmamalı" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "messages_require_text_room");
    });

    it("tells an outsider a voice room is forbidden when they post, and missing when they read", async () => {
      const owner = await bootstrapOwner(app);
      const member = await acceptInvite(app, owner.cookies, "Deniz");
      const rooms = await elsewhere(owner.cookies);

      // Posting checks membership first, so someone with no business in that
      // server never reaches the 400 and never learns the room's kind.
      const posted = await app.server.inject({
        method: "POST",
        url: `/api/rooms/${rooms.voice}/messages`,
        cookies: member.cookies,
        payload: { body: "olmamalı" }
      });
      assert.equal(posted.statusCode, 403);
      assert.equal(posted.json().error, "server_forbidden");

      // Reading refuses the room kind first, so the same outsider gets a 404
      // there — the room has no history to forbid them.
      const read = await app.server.inject({
        method: "GET",
        url: `/api/rooms/${rooms.voice}/messages`,
        cookies: member.cookies
      });
      assert.equal(read.statusCode, 404);
      assert.equal(read.json().error, "room_not_found");

      // A text room they do not belong to is forbidden either way.
      const readText = await app.server.inject({
        method: "GET",
        url: `/api/rooms/${rooms.text}/messages`,
        cookies: member.cookies
      });
      assert.equal(readText.statusCode, 403);
      assert.equal(readText.json().error, "server_forbidden");
    });

    it("answers a post to a room that does not exist with a 404", async () => {
      const owner = await bootstrapOwner(app);

      const response = await app.server.inject({
        method: "POST",
        url: "/api/rooms/no-such-room/messages",
        cookies: owner.cookies,
        payload: { body: "olmamalı" }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "room_not_found");
    });

    it("answers a malformed body before it looks the room up at all", async () => {
      const owner = await bootstrapOwner(app);
      const messageId = "00000000-0000-4000-8000-000000000000";

      // Every one of these names a room that does not exist. The body is parsed
      // first, so the 400 outranks the 404 rather than the other way round.
      const attempts = await Promise.all([
        app.server.inject({
          method: "POST",
          url: "/api/rooms/no-such-room/messages",
          cookies: owner.cookies,
          payload: { body: "   " }
        }),
        app.server.inject({
          method: "PATCH",
          url: `/api/rooms/no-such-room/messages/${messageId}`,
          cookies: owner.cookies,
          payload: { body: "" }
        }),
        app.server.inject({
          method: "PATCH",
          url: `/api/rooms/no-such-room/messages/${messageId}/embeds`,
          cookies: owner.cookies,
          payload: { embedKey: "javascript:alert(1)" }
        })
      ]);

      for (const attempt of attempts) {
        assert.equal(attempt.statusCode, 400);
        assert.equal(attempt.json().error, "bad_request");
      }
    });

    it("refuses the key past the ceiling that publicMessage clamps to", async () => {
      const owner = await bootstrapOwner(app);
      const posted = await app.server.inject({
        method: "POST",
        url: "/api/rooms/general/messages",
        cookies: owner.cookies,
        payload: { body: "sixteen links walk into a bar" }
      });
      const messageId = posted.json().message.id as string;

      for (let index = 0; index < 16; index += 1) {
        const suppressed = await app.server.inject({
          method: "PATCH",
          url: `/api/rooms/general/messages/${messageId}/embeds`,
          cookies: owner.cookies,
          payload: { embedKey: `youtube:key${index}` }
        });
        assert.equal(suppressed.statusCode, 200);
      }

      const seventeenth = await app.server.inject({
        method: "PATCH",
        url: `/api/rooms/general/messages/${messageId}/embeds`,
        cookies: owner.cookies,
        payload: { embedKey: "youtube:key16" }
      });
      assert.equal(seventeenth.statusCode, 409);
      assert.equal(seventeenth.json().error, "embed_suppression_limit");

      // Repeating one already on the list is idempotent rather than a refusal,
      // so a full message can still be asked for what it already holds.
      const repeat = await app.server.inject({
        method: "PATCH",
        url: `/api/rooms/general/messages/${messageId}/embeds`,
        cookies: owner.cookies,
        payload: { embedKey: "youtube:key0" }
      });
      assert.equal(repeat.statusCode, 200);
      assert.equal(repeat.json().message.suppressedEmbedKeys.length, 16);
    });
  });
});

async function bootstrapOwner(app: VoxlyApp) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/bootstrap/owner",
    payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

async function acceptInvite(app: VoxlyApp, ownerCookies: Record<string, string>, nickname: string) {
  const inviteResponse = await app.server.inject({
    method: "POST",
    url: "/api/owner/invites",
    cookies: ownerCookies,
    payload: { label: `${nickname} invite` }
  });

  const response = await app.server.inject({
    method: "POST",
    url: "/api/invites/accept",
    payload: { inviteToken: inviteResponse.json().invite.token, nickname }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
