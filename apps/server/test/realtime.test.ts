import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";

describe("Voxly realtime MVP", () => {
  let app: VoxlyApp;
  let baseUrl: string;
  let sockets: Socket[] = [];

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    sockets = [];
    await app.close();
  });

  it("rejects socket connections without a valid session", async () => {
    await assert.rejects(connectSocket(baseUrl, "bad-token"), /connect_error/);
  });

  it("emits presence and voice room membership for authenticated sessions", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");

    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const onlinePromise = onceEvent<{ nickname: string }>(ownerSocket, "presence:online");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);

    const online = await onlinePromise;
    assert.equal(online.nickname, "Ece");

    const roomsResponse = await app.server.inject({
      method: "GET",
      url: "/api/rooms",
      cookies: member.cookies
    });
    const voiceRoom = roomsResponse.json().rooms.find((room: { kind: string }) => room.kind === "voice");

    const joined = await onceEvent<{ roomId: string; user: { nickname: string } }>(ownerSocket, "voice:joined", () => {
      memberSocket.emit("voice:join", voiceRoom.id);
    });
    assert.equal(joined.roomId, voiceRoom.id);
    assert.equal(joined.user.nickname, "Ece");
  });

  it("tracks voice media state and enforces the visual publisher limit", async () => {
    const owner = await bootstrapOwner(app);
    const members = await Promise.all([
      acceptInvite(app, owner.cookies, "Aylin"),
      acceptInvite(app, owner.cookies, "Bora"),
      acceptInvite(app, owner.cookies, "Cem"),
      acceptInvite(app, owner.cookies, "Derya")
    ]);
    const socketsForMembers = await Promise.all(
      members.map((member) => connectSocket(baseUrl, member.cookies.voxly_session))
    );
    sockets.push(...socketsForMembers);

    for (const socket of socketsForMembers) {
      socket.emit("voice:join", "lobby");
    }

    const firstThree = await Promise.all(
      socketsForMembers.slice(0, 3).map((socket) =>
        emitWithAck<{ ok: boolean; state: { camera: boolean } }>(socket, "voice:setMediaState", {
          roomId: "lobby",
          media: { camera: true }
        })
      )
    );
    assert.equal(firstThree.every((response) => response.ok), true);

    const fourth = await emitWithAck<{ ok: boolean; error: string }>(
      socketsForMembers[3],
      "voice:setMediaState",
      { roomId: "lobby", media: { screen: true } }
    );
    assert.deepEqual(fourth, { ok: false, error: "visual_limit_reached" });

    const snapshot = await emitWithAck<{
      roomId: string;
      members: Array<{ userId: string; media: { camera: boolean; screen: boolean } }>;
    }>(socketsForMembers[0], "voice:snapshot", "lobby");
    assert.equal(snapshot.roomId, "lobby");
    assert.equal(snapshot.members.filter((member) => member.media.camera || member.media.screen).length, 3);
  });

  it("broadcasts deafened and speaking state while deafen forces mic off", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");

    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    memberSocket.emit("voice:join", "lobby");
    await emitWithAck(memberSocket, "voice:snapshot", "lobby");

    const speaking = await emitWithAck<{
      ok: boolean;
      state: { media: { mic: boolean; deafened: boolean; speaking: boolean } };
    }>(memberSocket, "voice:setMediaState", {
      roomId: "lobby",
      media: { speaking: true }
    });
    assert.equal(speaking.ok, true);
    assert.equal(speaking.state.media.mic, true);
    assert.equal(speaking.state.media.deafened, false);
    assert.equal(speaking.state.media.speaking, true);

    const deafened = await emitWithAck<{
      ok: boolean;
      state: { media: { mic: boolean; deafened: boolean; speaking: boolean } };
    }>(memberSocket, "voice:setMediaState", {
      roomId: "lobby",
      media: { deafened: true, mic: true, speaking: true }
    });
    assert.equal(deafened.ok, true);
    assert.equal(deafened.state.media.mic, false);
    assert.equal(deafened.state.media.deafened, true);
    assert.equal(deafened.state.media.speaking, false);

    const snapshot = await emitWithAck<{
      members: Array<{ media: { mic: boolean; deafened: boolean; speaking: boolean } }>;
    }>(memberSocket, "voice:snapshot", "lobby");
    assert.deepEqual(snapshot.members[0]?.media, {
      mic: false,
      camera: false,
      screen: false,
      deafened: true,
      speaking: false
    });

    const undeafened = await emitWithAck<{
      ok: boolean;
      state: { media: { mic: boolean; deafened: boolean } };
    }>(memberSocket, "voice:setMediaState", {
      roomId: "lobby",
      media: { deafened: false }
    });
    assert.equal(undeafened.ok, true);
    assert.equal(undeafened.state.media.mic, false);
    assert.equal(undeafened.state.media.deafened, false);
  });

  it("broadcasts voice snapshots to clients viewing the app but not joined to voice", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Viewer");

    const observerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(observerSocket, memberSocket);

    const snapshot = await onceEvent<{ roomId: string; members: Array<{ user: { nickname: string } }> }>(
      observerSocket,
      "voice:snapshot",
      () => {
        memberSocket.emit("voice:join", "lobby");
      }
    );

    assert.equal(snapshot.roomId, "lobby");
    assert.equal(snapshot.members.some((item) => item.user.nickname === "Viewer"), true);
  });

  it("forwards RTC signals only between users in the same voice room", async () => {
    const owner = await bootstrapOwner(app);
    const sender = await acceptInvite(app, owner.cookies, "Sender");
    const receiver = await acceptInvite(app, owner.cookies, "Receiver");
    const outsider = await acceptInvite(app, owner.cookies, "Outsider");

    const senderSocket = await connectSocket(baseUrl, sender.cookies.voxly_session);
    const receiverSocket = await connectSocket(baseUrl, receiver.cookies.voxly_session);
    const outsiderSocket = await connectSocket(baseUrl, outsider.cookies.voxly_session);
    sockets.push(senderSocket, receiverSocket, outsiderSocket);

    senderSocket.emit("voice:join", "lobby");
    receiverSocket.emit("voice:join", "lobby");
    await emitWithAck(receiverSocket, "voice:snapshot", "lobby");
    await emitWithAck(senderSocket, "voice:snapshot", "lobby");

    const forwarded = await onceEvent<{ roomId: string; fromUserId: string; signal: { type: string } }>(
      receiverSocket,
      "rtc:signal",
      () => {
        senderSocket.emit("rtc:signal", {
          roomId: "lobby",
          toUserId: receiver.user.id,
          signal: { type: "offer" }
        });
      }
    );
    assert.equal(forwarded.roomId, "lobby");
    assert.equal(forwarded.fromUserId, sender.user.id);
    assert.deepEqual(forwarded.signal, { type: "offer" });

    const rejected = await emitWithAck<{ ok: boolean; error: string }>(senderSocket, "rtc:signal", {
      roomId: "lobby",
      toUserId: outsider.user.id,
      signal: { type: "offer" }
    });
    assert.deepEqual(rejected, { ok: false, error: "target_not_in_voice_room" });
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

function emitWithAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: T) => resolve(response));
  });
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}

function connectSocket(baseUrl: string, sessionToken: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(baseUrl, {
      transports: ["websocket"],
      extraHeaders: {
        cookie: `voxly_session=${sessionToken}`
      },
      reconnection: false
    });

    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(new Error(`connect_error: ${error.message}`));
    });
  });
}

function onceEvent<T>(socket: Socket, event: string, trigger?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 1000);
    socket.once(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
    trigger?.();
  });
}
