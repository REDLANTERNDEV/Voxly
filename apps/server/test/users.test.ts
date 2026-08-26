import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createUser, nicknameSchema, publicUser } from "../src/users.js";
import { all, one, openDatabase, type VoxlyDatabase } from "../src/db/database.js";

describe("user accounts", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  async function open() {
    database = await openDatabase(":memory:");
    return database;
  }

  describe("the name an account may carry", () => {
    it("trims before measuring, so padding cannot pass for length", () => {
      assert.equal(nicknameSchema.parse("  Rae  "), "Rae");
      assert.equal(nicknameSchema.safeParse("  a  ").success, false);
    });

    it("holds the name to 2 and 32 characters", () => {
      assert.equal(nicknameSchema.safeParse("a").success, false);
      assert.equal(nicknameSchema.safeParse("ab").success, true);
      assert.equal(nicknameSchema.safeParse("x".repeat(32)).success, true);
      assert.equal(nicknameSchema.safeParse("x".repeat(33)).success, false);
    });
  });

  describe("creating one", () => {
    it("gives it a uuid and records the creation in the audit log", async () => {
      const db = await open();

      const user = createUser(db, "Rae", "member");

      assert.match(user.id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(user, { id: user.id, nickname: "Rae", role: "member", bannedAt: null });
      assert.equal(one<{ nickname: string }>(db.sqlite, "select nickname from users where id = ?", [user.id])?.nickname, "Rae");
      assert.deepEqual(
        all<{ action: string; actor_user_id: string }>(
          db.sqlite,
          "select action, actor_user_id from audit_events where target_user_id = ?",
          [user.id]
        ).map((event) => [event.action, event.actor_user_id]),
        [["user.created", user.id]]
      );
    });

    it("starts an account unbanned, whatever role it is given", async () => {
      const db = await open();

      assert.equal(createUser(db, "Rae", "owner").bannedAt, null);
      assert.equal(one<{ banned_at: string | null }>(db.sqlite, "select banned_at from users where nickname = ?", ["Rae"])?.banned_at, null);
    });
  });

  describe("the shape a caller is shown", () => {
    it("exposes the four public fields and drops everything else on the row", () => {
      const shown = publicUser({
        id: "user-1",
        nickname: "Rae",
        role: "member",
        bannedAt: null,
        // A session carries more than this; none of it is the caller's to see.
        sessionId: "session-1",
        expiresAt: "2099-01-01T00:00:00.000Z"
      } as Parameters<typeof publicUser>[0]);

      assert.deepEqual(shown, { id: "user-1", nickname: "Rae", role: "member", bannedAt: null });
    });

    it("carries the global ban, which is the only ban an account itself holds", () => {
      const bannedAt = "2026-01-01T00:00:00.000Z";

      assert.equal(publicUser({ id: "user-1", nickname: "Rae", role: "member", bannedAt }).bannedAt, bannedAt);
    });
  });
});
