import { cookieJar } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { welcomeWaveBody, type ChatMessage } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";

type Identity = { id: string; cookies: Record<string, string> };
const serverId = "the-basement";

describe("Welcome notices", () => {
  let app: VoxlyApp;
  let owner: Identity;
  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "test",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    owner = identity(
      await app.server.inject({
        method: "POST",
        url: "/api/bootstrap/owner",
        payload: { bootstrapToken: "test", nickname: "Owner" }
      })
    );
  });
  afterEach(async () => {
    await app.close();
  });

  async function invite(nickname: string, cookies?: Record<string, string>) {
    const created = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies: owner.cookies,
      payload: { label: "welcome test" }
    });
    const accepted = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies,
      payload: { nickname, inviteToken: created.json().invite.token }
    });
    assert.ok(accepted.statusCode === 200 || accepted.statusCode === 201, accepted.body);
    return identity(accepted, cookies);
  }
  async function history(roomId = "general", who = owner): Promise<ChatMessage[]> {
    const response = await app.server.inject({ url: `/api/rooms/${roomId}/messages`, cookies: who.cookies });
    assert.equal(response.statusCode, 200);
    return response.json().messages;
  }
  async function notices(roomId = "general") {
    return (await history(roomId)).filter((message) => message.kind === "memberJoined");
  }
  async function setWelcome(welcomeNotices: boolean, welcomeRoomId: string | null, who = owner) {
    return app.server.inject({
      method: "PATCH",
      url: `/api/servers/${serverId}/welcome`,
      cookies: who.cookies,
      payload: { welcomeNotices, welcomeRoomId }
    });
  }
  async function createRoom(name: string, kind: "text" | "voice") {
    const response = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/rooms`,
      cookies: owner.cookies,
      payload: { name, kind }
    });
    assert.equal(response.statusCode, 201);
    return response.json().room.id as string;
  }
  async function wave(notice: ChatMessage, who: Identity) {
    return app.server.inject({
      method: "POST",
      url: `/api/rooms/${notice.roomId}/messages/${notice.id}/wave`,
      cookies: who.cookies
    });
  }
  async function serverSettings(who = owner) {
    const response = await app.server.inject({ url: "/api/servers", cookies: who.cookies });
    const server = (
      response.json().servers as Array<{ id: string; welcomeNotices: boolean; welcomeRoomId: string | null }>
    ).find((candidate) => candidate.id === serverId)!;
    return { welcomeNotices: server.welcomeNotices, welcomeRoomId: server.welcomeRoomId };
  }

  it("posts one in the top text channel, in the new member's name, with nothing stored to translate", async () => {
    assert.deepEqual(await serverSettings(), { welcomeNotices: true, welcomeRoomId: null });
    const deniz = await invite("Deniz");
    const [notice, ...rest] = await notices();
    assert.equal(rest.length, 0);
    assert.equal(notice.userId, deniz.id);
    assert.equal(notice.nickname, "Deniz");
    assert.equal(notice.body, "");
    assert.ok(Date.parse(notice.createdAt) > 0);
  });

  it("goes to the owner's chosen channel, and back to the top one once that channel is gone", async () => {
    const lobby = await createRoom("lobby", "text");
    const voice = await createRoom("talk", "voice");
    assert.equal((await setWelcome(true, voice)).statusCode, 400);
    assert.equal((await setWelcome(true, "no-such-room")).statusCode, 400);
    assert.deepEqual((await setWelcome(true, lobby)).json(), { welcomeNotices: true, welcomeRoomId: lobby });
    await invite("Deniz");
    assert.equal((await notices(lobby)).length, 1);
    assert.equal((await notices()).length, 0);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${serverId}/rooms/${lobby}`,
      cookies: owner.cookies
    });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(await serverSettings(), { welcomeNotices: true, welcomeRoomId: null });
    await invite("Ece");
    assert.equal((await notices()).length, 1);
  });

  it("stops new notices when switched off and keeps the ones already posted", async () => {
    await invite("Deniz");
    assert.equal((await setWelcome(false, null)).statusCode, 200);
    await invite("Ece");
    const posted = await notices();
    assert.deepEqual(
      posted.map((notice) => notice.nickname),
      ["Deniz"]
    );
    assert.deepEqual(await serverSettings(), { welcomeNotices: false, welcomeRoomId: null });
  });

  it("is the owner's setting alone", async () => {
    const deniz = await invite("Deniz");
    assert.equal((await setWelcome(false, null, deniz)).statusCode, 403);
    assert.equal((await serverSettings(deniz)).welcomeNotices, true);
  });

  it("welcomes a member again when they rejoin after a kick", async () => {
    const deniz = await invite("Deniz");
    const kicked = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/members/${deniz.id}/kick`,
      cookies: owner.cookies
    });
    assert.equal(kicked.statusCode, 204);
    await invite("Deniz", deniz.cookies);
    assert.equal((await notices()).length, 2);
  });

  it("lets every other member wave once, as a reply anyone can read", async () => {
    const deniz = await invite("Deniz");
    const ece = await invite("Ece");
    const [toDeniz] = await notices();

    assert.equal((await wave(toDeniz, deniz)).statusCode, 400);
    const waved = await wave(toDeniz, ece);
    assert.equal(waved.statusCode, 201);
    const reply = waved.json().message as ChatMessage;
    assert.equal(reply.kind, "message");
    assert.equal(reply.body, welcomeWaveBody);
    assert.equal(reply.userId, ece.id);
    assert.equal(reply.replyTo?.kind, "memberJoined");
    assert.equal(reply.replyTo?.nickname, "Deniz");
    assert.equal((await wave(toDeniz, ece)).statusCode, 409);
    assert.equal((await wave(toDeniz, owner)).statusCode, 201);

    const read = (await history("general", deniz)).find((message) => message.id === reply.id);
    assert.equal(read?.replyTo?.kind, "memberJoined");
  });

  it("waves only at a Welcome notice", async () => {
    const deniz = await invite("Deniz");
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: owner.cookies,
      payload: { body: "hello" }
    });
    const ordinary = posted.json().message as ChatMessage;
    assert.equal((await wave(ordinary, deniz)).statusCode, 400);
  });

  it("cannot be edited, even by the member it welcomes", async () => {
    const deniz = await invite("Deniz");
    const [notice] = await notices();
    const edited = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${notice.id}`,
      cookies: deniz.cookies,
      payload: { body: "rewritten" }
    });
    assert.equal(edited.statusCode, 400);
    assert.equal(edited.json().error, "message_not_editable");
  });
});

function identity(
  response: { json(): { user: { id: string } }; cookies: Array<{ name: string; value: string }> },
  fallback?: Record<string, string>
): Identity {
  const cookies = cookieJar(response);
  return { id: response.json().user.id, cookies: Object.keys(cookies).length ? cookies : (fallback ?? cookies) };
}
