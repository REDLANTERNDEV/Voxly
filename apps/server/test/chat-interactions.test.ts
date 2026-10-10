import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io as createClient, type Socket } from "socket.io-client";
import {
  chatEmojiCatalog,
  type ChatMessage,
  type MessageMentionInput,
  type MessageReactionsEvent,
  type PresenceUser
} from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";

type Identity = { id: string; cookies: Record<string, string> };
const serverId = "the-basement";
describe("chat interactions", () => {
  let app: VoxlyApp;
  let owner: Identity, member: Identity;
  let sockets: Socket[];
  beforeEach(async () => {
    sockets = [];
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "test",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    const response = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "test", nickname: "Owner" }
    });
    owner = identity(response);
    member = await invite("Ahmet");
  });
  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  });
  async function invite(nickname: string) {
    const created = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies: owner.cookies,
      payload: { label: "chat test" }
    });
    const accepted = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { nickname, inviteToken: created.json().invite.token }
    });
    assert.equal(accepted.statusCode, 201);
    return identity(accepted);
  }
  async function post(body = "hello", mentions: MessageMentionInput[] = [], author = owner) {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: author.cookies,
      payload: { body, mentions }
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().message as ChatMessage;
  }
  async function directory() {
    return (await app.server.inject({ url: `/api/servers/${serverId}/directory`, cookies: owner.cookies })).json()
      .members as PresenceUser[];
  }
  async function react(
    messageId: string,
    emoji: string,
    person = owner,
    method: "PUT" | "DELETE" = "PUT",
    suffix = ""
  ) {
    return app.server.inject({
      method,
      url: `/api/rooms/general/messages/${messageId}/reactions/${encodeURIComponent(emoji)}${suffix}`,
      cookies: person.cookies
    });
  }
  it("enforces the shared eight-kind ceiling while allowing joins, repeats and released slots", async () => {
    const message = await post();
    const emojis = chatEmojiCatalog.slice(0, 9).map(([emoji]) => emoji);
    for (const emoji of emojis.slice(0, 8)) assert.equal((await react(message.id, emoji)).statusCode, 200);
    const refused = await react(message.id, emojis[8], member);
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, "reaction_limit");
    const joined = await react(message.id, emojis[0], member);
    assert.equal(joined.statusCode, 200);
    const snapshot = joined.json() as MessageReactionsEvent;
    assert.equal(snapshot.reactions.length, 8);
    assert.equal(snapshot.reactions.find((reaction) => reaction.emoji === emojis[0])!.userIds.length, 2);
    assert.equal((await react(message.id, emojis[0], member)).json().version, snapshot.version);
    await react(message.id, emojis[0], member, "DELETE");
    assert.equal((await react(message.id, emojis[8])).statusCode, 409);
    await react(message.id, emojis[0], owner, "DELETE");
    assert.equal((await react(message.id, emojis[8], member)).statusCode, 200);
    assert.equal((await react(message.id, "not-an-emoji")).statusCode, 400);
  });
  it("admits only one of two simultaneous new kinds when one slot remains", async () => {
    const message = await post();
    for (const [emoji] of chatEmojiCatalog.slice(0, 7)) await react(message.id, emoji);
    const responses = await Promise.all([
      react(message.id, chatEmojiCatalog[7][0]),
      react(message.id, chatEmojiCatalog[8][0], member)
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    const history = await app.server.inject({ url: "/api/rooms/general/messages", cookies: member.cookies });
    assert.equal(history.json().messages[0].reactionState.reactions.length, 8);
  });
  it("lets only the Server owner clear a whole emoji group or all reactions", async () => {
    const message = await post("member's message", [], member);
    await react(message.id, "👍", owner);
    await react(message.id, "👍", member);
    await react(message.id, "❤️", member);
    assert.equal((await react(message.id, "👍", member, "DELETE", "/all")).statusCode, 403);
    assert.equal(
      (
        await app.server.inject({
          method: "DELETE",
          url: `/api/rooms/general/messages/${message.id}/reactions`,
          cookies: member.cookies
        })
      ).statusCode,
      403
    );
    const removed = await react(message.id, "👍", owner, "DELETE", "/all");
    assert.deepEqual(
      removed.json().reactions.map((reaction: { emoji: string }) => reaction.emoji),
      ["❤️"]
    );
    const cleared = await app.server.inject({
      method: "DELETE",
      url: `/api/rooms/general/messages/${message.id}/reactions`,
      cookies: owner.cookies
    });
    assert.deepEqual(cleared.json().reactions, []);
    assert.ok(cleared.json().version > removed.json().version);
  });
  it("distinguishes duplicate names and preserves targets through rename, replies, edits and deletion", async () => {
    const other = await invite("Ahmet");
    const people = await directory();
    const target = people.find((person) => person.userId === member.id)!;
    assert.match(target.mentionCode!, /^[A-F0-9]{6}$/);
    assert.notEqual(target.mentionCode, people.find((person) => person.userId === other.id)!.mentionCode);
    const label = `@${target.nickname} · #${target.mentionCode}`;
    const input: MessageMentionInput = { kind: "person", userId: member.id, start: 3, end: 3 + label.length };
    const message = await post(`hi ${label}`, [input]);
    assert.deepEqual(message.mentions[0].recipientIds, [member.id]);
    await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${serverId}/members/${member.id}/nickname`,
      cookies: owner.cookies,
      payload: { nickname: "Deniz" }
    });
    const renamed = (await directory()).find((person) => person.userId === member.id)!;
    assert.equal(renamed.mentionCode, target.mentionCode);
    const reply = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: owner.cookies,
      payload: { body: "reply", replyToMessageId: message.id }
    });
    assert.equal(reply.json().message.replyTo.mentions[0].userId, member.id);
    assert.ok(reply.json().message.replyTo.body.includes("Deniz"));
    const current = (
      await app.server.inject({ url: `/api/rooms/general/messages/${message.id}/context`, cookies: owner.cookies })
    )
      .json()
      .messages.find((item: ChatMessage) => item.id === message.id) as ChatMessage;
    const edit = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${message.id}`,
      cookies: owner.cookies,
      payload: { body: current.body + "!", mentions: current.mentions }
    });
    assert.equal(edit.statusCode, 200);
    assert.equal(edit.json().message.mentions[0].userId, member.id);
    app.sqlite
      .prepare("update users set nickname = '', deleted_at = ? where id = ?")
      .run(new Date().toISOString(), member.id);
    app.sqlite.prepare("update server_members set nickname = null where user_id = ?").run(member.id);
    const history = (await app.server.inject({ url: "/api/rooms/general/messages", cookies: owner.cookies })).json()
      .messages as ChatMessage[];
    const deleted = history.find((item) => item.id === message.id)!;
    assert.equal(deleted.mentions[0].authorDeleted, true);
    assert.equal(deleted.mentions[0].nickname, "");
    assert.ok(!deleted.body.includes("Ahmet") && !deleted.body.includes("Deniz"));
  });
  it("freezes everyone recipients and refuses out-of-server, Bot and invalid-range mentions", async () => {
    const message = await post("@everyone", [{ kind: "everyone", start: 0, end: 9 }], member);
    assert.deepEqual(new Set(message.mentions[0].recipientIds), new Set([owner.id, member.id]));
    const newcomer = await invite("Newcomer");
    const edited = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${message.id}`,
      cookies: member.cookies,
      payload: { body: "@everyone!", mentions: message.mentions }
    });
    assert.equal(edited.statusCode, 200);
    assert.ok(!edited.json().message.mentions[0].recipientIds.includes(newcomer.id));
    const twoLabels = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${message.id}`,
      cookies: member.cookies,
      payload: {
        body: "@everyone @everyone",
        mentions: [message.mentions[0], { kind: "everyone", start: 10, end: 19 }]
      }
    });
    assert.equal(twoLabels.statusCode, 200);
    assert.ok(!twoLabels.json().message.mentions[0].recipientIds.includes(newcomer.id));
    assert.ok(twoLabels.json().message.mentions[1].recipientIds.includes(newcomer.id));
    assert.notEqual(twoLabels.json().message.mentions[0].id, twoLabels.json().message.mentions[1].id);
    for (const mentions of [
      [{ kind: "person", userId: crypto.randomUUID(), start: 0, end: 2 }],
      [{ kind: "everyone", start: 0, end: 99 }],
      [{ kind: "here", start: 0, end: 9 }]
    ]) {
      assert.equal(
        (
          await app.server.inject({
            method: "POST",
            url: "/api/rooms/general/messages",
            cookies: owner.cookies,
            payload: { body: "@everyone", mentions }
          })
        ).statusCode,
        400
      );
    }
    app.sqlite.prepare("update users set is_bot = 1 where id = ?").run(newcomer.id);
    const bot = (await directory()).find((person) => person.userId === newcomer.id)!;
    const label = `@${bot.nickname} · #${bot.mentionCode}`;
    assert.equal(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/rooms/general/messages",
          cookies: owner.cookies,
          payload: { body: label, mentions: [{ kind: "person", userId: bot.userId, start: 0, end: label.length }] }
        })
      ).statusCode,
      400
    );
  });
  it("freezes here recipients from live connections and scopes reaction delivery to the room", async () => {
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
    const socket = createClient(url, {
      transports: ["websocket"],
      extraHeaders: {
        Cookie: Object.entries(member.cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join("; ")
      }
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    socket.emit("room:join", "general");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const message = await post("@here", [{ kind: "here", start: 0, end: 5 }]);
    assert.deepEqual(message.mentions[0].recipientIds, [member.id]);
    const received = new Promise<MessageReactionsEvent>((resolve) => socket.once("message:reactions", resolve));
    await react(message.id, "👍");
    assert.equal((await received).roomId, "general");
    socket.disconnect();
    const current = (await app.server.inject({ url: "/api/rooms/general/messages", cookies: owner.cookies })).json()
      .messages[0];
    assert.deepEqual(current.mentions[0].recipientIds, [member.id]);
  });
  it("loads old pins with 50 neighbors each side without a read watermark, and clears dependencies on delete", async () => {
    const insert = app.sqlite.prepare(
      "insert into messages (id, room_id, user_id, body, created_at, sequence) values (?, 'general', ?, ?, ?, ?)"
    );
    const ids = Array.from({ length: 260 }, () => crypto.randomUUID());
    ids.forEach((id, index) => insert.run(id, owner.id, `message ${index}`, "2026-01-01T00:00:00.000Z", index + 1));
    app.sqlite.prepare("update rooms set message_sequence = 260 where id = 'general'").run();
    const target = ids[60];
    const path = `/api/rooms/general/messages/${target}/pin`;
    assert.equal((await app.server.inject({ method: "PUT", url: path, cookies: member.cookies })).statusCode, 403);
    const pinned = await app.server.inject({ method: "PUT", url: path, cookies: owner.cookies });
    assert.equal(pinned.statusCode, 200);
    const firstPinnedAt = pinned.json().message.pinnedAt;
    assert.equal(
      (await app.server.inject({ method: "PUT", url: path, cookies: owner.cookies })).json().message.pinnedAt,
      firstPinnedAt
    );
    const pins = await app.server.inject({ url: "/api/rooms/general/pins", cookies: member.cookies });
    assert.equal(pins.json().messages[0].id, target);
    assert.equal(pins.json().readThroughSequence, undefined);
    const context = await app.server.inject({
      url: `/api/rooms/general/messages/${target}/context`,
      cookies: member.cookies
    });
    assert.equal(context.json().messages.length, 101);
    assert.equal(context.json().messages[50].id, target);
    assert.equal(context.json().readThroughSequence, undefined);
    assert.equal(
      (await app.server.inject({ url: "/api/rooms/general/messages", cookies: member.cookies }))
        .json()
        .messages.some((message: ChatMessage) => message.id === target),
      false
    );
    await react(target, "👍");
    await app.server.inject({ method: "DELETE", url: `/api/rooms/general/messages/${target}`, cookies: owner.cookies });
    assert.equal(
      app.sqlite.prepare("select count(*) as count from message_reactions where message_id = ?").get(target)!.count,
      0
    );
    assert.deepEqual(
      (await app.server.inject({ url: "/api/rooms/general/pins", cookies: member.cookies })).json().messages,
      []
    );
    assert.equal(
      (await app.server.inject({ url: `/api/rooms/general/messages/${target}/context`, cookies: member.cookies }))
        .statusCode,
      404
    );
  });
});

describe("chat migration persistence", () => {
  it("backfills missing codes once and keeps codes, reactions and pins across restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "voxly-chat-"));
    const databasePath = join(directory, "chat.sqlite");
    let app = await createVoxlyApp({
      databasePath,
      ownerBootstrapToken: "test",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    try {
      const response = await app.server.inject({
        method: "POST",
        url: "/api/bootstrap/owner",
        payload: { bootstrapToken: "test", nickname: "Owner" }
      });
      const owner = identity(response);
      const message = (
        await app.server.inject({
          method: "POST",
          url: "/api/rooms/general/messages",
          cookies: owner.cookies,
          payload: { body: "saved" }
        })
      ).json().message as ChatMessage;
      await app.server.inject({
        method: "PUT",
        url: `/api/rooms/general/messages/${message.id}/pin`,
        cookies: owner.cookies
      });
      await app.server.inject({
        method: "PUT",
        url: `/api/rooms/general/messages/${message.id}/reactions/${encodeURIComponent("👍")}`,
        cookies: owner.cookies
      });
      app.sqlite.prepare("update server_members set mention_code = null where user_id = ?").run(owner.id);
      await app.close();
      app = await createVoxlyApp({ databasePath, secureCookies: false });
      const code = app.sqlite
        .prepare("select mention_code from server_members where user_id = ?")
        .get(owner.id)!.mention_code;
      assert.match(String(code), /^[A-F0-9]{6}$/);
      const saved = (await app.server.inject({ url: "/api/rooms/general/pins", cookies: owner.cookies })).json()
        .messages[0] as ChatMessage;
      assert.equal(saved.id, message.id);
      assert.equal(saved.reactionState.reactions[0].emoji, "👍");
      await app.close();
      app = await createVoxlyApp({ databasePath, secureCookies: false });
      assert.equal(
        app.sqlite.prepare("select mention_code from server_members where user_id = ?").get(owner.id)!.mention_code,
        code
      );
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function identity(response: {
  json(): { user: { id: string } };
  cookies: Array<{ name: string; value: string }>;
}): Identity {
  return {
    id: response.json().user.id,
    cookies: Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]))
  };
}
