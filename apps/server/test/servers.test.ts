import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import Fastify from "fastify";
import { afkRoomName, DEFAULT_AFK_TIMEOUT_MINUTES } from "@voxly/shared";
import {
  afkTimeoutOf,
  createServerRoom,
  registerServerRoutes,
  roomNameSchema,
  serverNameSchema
} from "../src/servers.js";
import type { RealtimeModeration, RouteContext } from "../src/http.js";
import { defaultServerId, one, openDatabase, run, type VoxlyDatabase } from "../src/db/database.js";
import type { VoxlyIoServer } from "../src/socket.js";

type RoomRecord = { id: string; name: string; kind: string; position: number; is_afk: number };

describe("servers and the rooms inside them", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  async function open() {
    database = await openDatabase(":memory:");
    return database;
  }

  function storedRoom(db: VoxlyDatabase, roomId: string) {
    return one<RoomRecord>(db.sqlite, "select id, name, kind, position, is_afk from rooms where id = ?", [roomId]);
  }

  describe("creating a room", () => {
    it("keeps the legacy ids the default server's first two rooms have always had", async () => {
      const db = await open();
      // Startup already seeded them under exactly these ids; clearing them is
      // how the derivation itself gets asserted rather than the seed.
      run(db.sqlite, "delete from rooms where server_id = ?", [defaultServerId]);

      assert.equal(createServerRoom(db, defaultServerId, "general", "text", 10).id, "general");
      assert.equal(createServerRoom(db, defaultServerId, "Lobby", "voice", 20).id, "lobby");
    });

    it("gives every other room a uuid, so two servers can hold the same name", async () => {
      const db = await open();

      const elsewhere = createServerRoom(db, "another-server", "general", "text", 10);
      const differentKind = createServerRoom(db, defaultServerId, "general", "voice", 40);

      assert.notEqual(elsewhere.id, "general");
      assert.notEqual(differentKind.id, "general");
      assert.match(elsewhere.id, /^[0-9a-f-]{36}$/);
      assert.match(differentKind.id, /^[0-9a-f-]{36}$/);
    });

    it("persists the row it hands back, afk flag included", async () => {
      const db = await open();

      const afk = createServerRoom(db, "server-1", afkRoomName, "voice", 30, true);
      const ordinary = createServerRoom(db, "server-1", "Lobby", "voice", 20);

      assert.deepEqual(afk, {
        id: afk.id,
        serverId: "server-1",
        name: afkRoomName,
        kind: "voice",
        position: 30,
        isAfk: true
      });
      assert.equal(storedRoom(db, afk.id)?.is_afk, 1);
      assert.equal(storedRoom(db, ordinary.id)?.is_afk, 0);
      assert.equal(storedRoom(db, afk.id)?.position, 30);
    });
  });

  describe("the afk timeout a server reads back", () => {
    it("falls back to the default for a legacy row that carries no value", () => {
      assert.equal(afkTimeoutOf(null), DEFAULT_AFK_TIMEOUT_MINUTES);
      assert.equal(afkTimeoutOf(undefined), DEFAULT_AFK_TIMEOUT_MINUTES);
    });

    it("falls back to the default rather than handing out a value off the shared list", () => {
      assert.equal(afkTimeoutOf(7), DEFAULT_AFK_TIMEOUT_MINUTES);
      assert.equal(afkTimeoutOf(0), DEFAULT_AFK_TIMEOUT_MINUTES);
    });

    it("passes a supported value through untouched", () => {
      assert.equal(afkTimeoutOf(30), 30);
    });
  });

  describe("the names an owner may choose", () => {
    it("trims before measuring, so padding cannot pass for length", () => {
      assert.equal(serverNameSchema.parse("  The Basement  "), "The Basement");
      assert.equal(roomNameSchema.parse("  general  "), "general");
      assert.equal(serverNameSchema.safeParse("  a  ").success, false);
    });

    it("holds both names to 2 and 64 characters", () => {
      for (const schema of [serverNameSchema, roomNameSchema]) {
        assert.equal(schema.safeParse("a").success, false);
        assert.equal(schema.safeParse("ab").success, true);
        assert.equal(schema.safeParse("x".repeat(64)).success, true);
        assert.equal(schema.safeParse("x".repeat(65)).success, false);
      }
    });
  });

  describe("the routes it registers", () => {
    it("owns the server and room lifecycle, and nothing beyond it", async () => {
      const db = await open();
      const http = Fastify();
      const registered: string[] = [];
      http.addHook("onRoute", (route) => {
        registered.push(`${String(route.method)} ${route.url}`);
      });

      registerServerRoutes({
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
      // neighbouring group during tickets 17-19 fails here rather than silently.
      assert.deepEqual(registered.sort(), [
        "DELETE /api/servers/:serverId",
        "DELETE /api/servers/:serverId/rooms/:roomId",
        "GET /api/rooms",
        "GET /api/servers",
        "GET /api/servers/:serverId/rooms",
        "HEAD /api/rooms",
        "HEAD /api/servers",
        "HEAD /api/servers/:serverId/rooms",
        "PATCH /api/servers/:serverId",
        "PATCH /api/servers/:serverId/afk",
        "POST /api/servers",
        "POST /api/servers/:serverId/rooms"
      ]);
    });
  });
});
