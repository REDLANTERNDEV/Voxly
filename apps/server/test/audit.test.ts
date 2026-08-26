import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { audit } from "../src/audit.js";
import { all, defaultServerId, openDatabase, type VoxlyDatabase } from "../src/db/database.js";

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_user_id: string | null;
  server_id: string | null;
  created_at: string;
};

describe("the audit log", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  async function open() {
    database = await openDatabase(":memory:");
    return database;
  }

  function events(db: VoxlyDatabase) {
    return all<AuditRow>(db.sqlite, "select * from audit_events order by rowid asc");
  }

  it("records who did what to whom, in which server", async () => {
    const db = await open();

    audit(db, "owner-1", "server.renamed", null, "server-1");
    audit(db, "owner-1", "member.banned", "member-2", "server-1");

    assert.deepEqual(
      events(db).map((event) => [event.actor_user_id, event.action, event.target_user_id, event.server_id]),
      [
        ["owner-1", "server.renamed", null, "server-1"],
        ["owner-1", "member.banned", "member-2", "server-1"]
      ]
    );
  });

  it("files an action with no server of its own under the default server", async () => {
    const db = await open();

    audit(db, "owner-1", "session.revoked", "member-2");

    assert.equal(events(db)[0]?.server_id, defaultServerId);
  });

  it("keeps each line separately addressable and timestamped", async () => {
    const db = await open();

    audit(db, null, "user.created", "member-2");
    audit(db, null, "user.created", "member-3");

    const [first, second] = events(db);
    assert.notEqual(first?.id, second?.id);
    assert.ok(first && !Number.isNaN(new Date(first.created_at).getTime()));
  });

  it("leaves the write to the caller's transaction rather than saving on its own", async () => {
    const db = await open();

    db.sqlite.exec("begin immediate");
    audit(db, "owner-1", "server.deleted", null, "server-1");
    db.sqlite.exec("rollback");

    assert.deepEqual(events(db), []);
  });
});
