import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import type { VoiceJoinAck, VoiceMediaState } from "@voxly/shared";
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
    const onlinePromise = onceEvent<{ serverId: string; user: { nickname: string } }>(ownerSocket, "presence:serverOnline");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);

    const online = await onlinePromise;
    assert.equal(online.serverId, "the-basement");
    assert.equal(online.user.nickname, "Ece");

    const roomsResponse = await app.server.inject({
      method: "GET",
      url: "/api/rooms",
      cookies: member.cookies
    });
    const voiceRoom = roomsResponse.json().rooms.find((room: { kind: string }) => room.kind === "voice");

    const joinedPromise = onceEvent<{ roomId: string; user: { nickname: string } }>(ownerSocket, "voice:joined");
    await joinVoice(memberSocket, voiceRoom.id);
    const joined = await joinedPromise;
    assert.equal(joined.roomId, voiceRoom.id);
    assert.equal(joined.user.nickname, "Ece");
  });

  it("publishes server nickname updates only in scope and refreshes active voice", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Other Server" }
    });
    const otherServerId = createdServer.json().server.id as string;
    const otherInvite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${otherServerId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Other member", expiresInMinutes: 1440 }
    });
    const otherMemberResponse = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken: otherInvite.json().invite.token, nickname: "Other" }
    });
    const otherCookies = cookieJar(otherMemberResponse);

    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    const otherSocket = await connectSocket(baseUrl, otherCookies.voxly_session);
    sockets.push(ownerSocket, memberSocket, otherSocket);
    const initialSnapshotPromise = onceEvent(ownerSocket, "voice:snapshot");
    await joinVoice(memberSocket, "lobby");
    await initialSnapshotPromise;

    const updatedPromise = onceEvent<{
      serverId: string;
      user: { userId: string; nickname: string };
    }>(memberSocket, "server:memberUpdated");
    const snapshotPromise = onceEvent<{
      roomId: string;
      members: Array<{ user: { userId: string; nickname: string } }>;
    }>(ownerSocket, "voice:snapshot");

    const renamed = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/the-basement/members/${member.user.id}/nickname`,
      cookies: owner.cookies,
      payload: { nickname: "Basement Ece" }
    });
    assert.equal(renamed.statusCode, 200);

    const [updated, snapshot] = await Promise.all([updatedPromise, snapshotPromise]);
    assert.equal(updated.serverId, "the-basement");
    assert.equal(updated.user.nickname, "Basement Ece");
    assert.equal(
      snapshot.members.find((entry) => entry.user.userId === member.user.id)?.user.nickname,
      "Basement Ece"
    );
    await expectNoEvent(otherSocket, "server:memberUpdated");
  });

  it("publishes server name updates only to members of the renamed server", async () => {
    const owner = await bootstrapOwner(app);
    const outsider = await acceptInvite(app, owner.cookies, "Default member");
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Other Server" }
    });
    const serverId = createdServer.json().server.id as string;
    const invite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Scoped member", expiresInMinutes: 1440 }
    });
    const memberResponse = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken: invite.json().invite.token, nickname: "Scoped member" }
    });
    const memberCookies = cookieJar(memberResponse);

    const memberSocket = await connectSocket(baseUrl, memberCookies.voxly_session);
    const outsiderSocket = await connectSocket(baseUrl, outsider.cookies.voxly_session);
    sockets.push(memberSocket, outsiderSocket);
    const updatedPromise = onceEvent<{ serverId: string; name: string }>(memberSocket, "server:updated");

    const renamed = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${serverId}`,
      cookies: owner.cookies,
      payload: { name: "Onyx Lounge" }
    });
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(await updatedPromise, { serverId, name: "Onyx Lounge" });
    await expectNoEvent(outsiderSocket, "server:updated");
  });

  it("joins with the requested muted media in one authoritative snapshot", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Muted member");
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);

    const snapshotPromise = onceEvent<{
      roomId: string;
      members: Array<{ user: { userId: string }; media: VoiceMediaState }>;
    }>(ownerSocket, "voice:snapshot");
    const response = await joinVoice(memberSocket, "lobby", {
      ...defaultJoinMedia,
      mic: false,
      speaking: true
    });
    const snapshot = await snapshotPromise;

    assert.equal(response.ok, true);
    assert.equal(response.ok && response.state.media.mic, false);
    assert.equal(response.ok && response.state.media.speaking, false);
    const memberMedia = snapshot.members.find((entry) => entry.user.userId === member.user.id)?.media;
    assert.equal(memberMedia?.mic, false);
    assert.equal(memberMedia?.speaking, false);
    await expectNoEvent(ownerSocket, "voice:snapshot");
  });

  it("acknowledges missing and forbidden voice rooms without publishing membership", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Restricted member");
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Private voice server" }
    });
    const privateServerId = created.json().server.id as string;
    const rooms = (await app.server.inject({
      method: "GET",
      url: `/api/servers/${privateServerId}/rooms`,
      cookies: owner.cookies
    })).json().rooms as Array<{ id: string; kind: string }>;
    const privateVoiceRoom = rooms.find((room) => room.kind === "voice");
    assert.ok(privateVoiceRoom);

    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);

    assert.deepEqual(await joinVoice(memberSocket, "missing-room"), {
      ok: false,
      error: "room_not_found"
    });
    assert.deepEqual(await joinVoice(memberSocket, privateVoiceRoom.id), {
      ok: false,
      error: "forbidden"
    });
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

    await Promise.all(socketsForMembers.map((socket) => joinVoice(socket, "lobby")));

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

  it("notifies only a visual publisher when a viewer changes subscriptions", async () => {
    const owner = await bootstrapOwner(app);
    const publisher = await acceptInvite(app, owner.cookies, "Publisher");
    const viewer = await acceptInvite(app, owner.cookies, "Viewer");
    const outsider = await acceptInvite(app, owner.cookies, "Outsider");

    const publisherSocket = await connectSocket(baseUrl, publisher.cookies.voxly_session);
    const viewerSocket = await connectSocket(baseUrl, viewer.cookies.voxly_session);
    const outsiderSocket = await connectSocket(baseUrl, outsider.cookies.voxly_session);
    sockets.push(publisherSocket, viewerSocket, outsiderSocket);

    await Promise.all([
      joinVoice(publisherSocket, "lobby"),
      joinVoice(viewerSocket, "lobby")
    ]);
    await emitWithAck(viewerSocket, "voice:snapshot", "lobby");
    await emitWithAck(publisherSocket, "voice:setMediaState", {
      roomId: "lobby",
      media: { screen: true }
    });

    const subscribed = await onceEvent<{
      roomId: string;
      viewerUserId: string;
      subscribedKinds: string[];
    }>(publisherSocket, "voice:visualSubscriberState", () => {
      viewerSocket.emit("voice:setVisualSubscriptions", {
        roomId: "lobby",
        targets: [{ publisherUserId: publisher.user.id, kind: "screen" }]
      });
    });
    assert.deepEqual(subscribed, {
      roomId: "lobby",
      viewerUserId: viewer.user.id,
      subscribedKinds: ["screen"]
    });

    const cleared = await onceEvent<{
      roomId: string;
      viewerUserId: string;
      subscribedKinds: string[];
    }>(publisherSocket, "voice:visualSubscriberState", () => {
      viewerSocket.emit("voice:setVisualSubscriptions", { roomId: "lobby", targets: [] });
    });
    assert.deepEqual(cleared.subscribedKinds, []);

    const rejected = await emitWithAck<{ ok: boolean; error: string }>(outsiderSocket, "voice:setVisualSubscriptions", {
      roomId: "lobby",
      targets: [{ publisherUserId: publisher.user.id, kind: "screen" }]
    });
    assert.deepEqual(rejected, { ok: false, error: "not_in_voice_room" });

    const malformed = await emitWithAck<{ ok: boolean; error: string }>(viewerSocket, "voice:setVisualSubscriptions", {
      roomId: "lobby",
      targets: null
    });
    assert.deepEqual(malformed, { ok: false, error: "invalid_payload" });
  });

  it("clears a publisher's visual subscription when a viewer leaves", async () => {
    const owner = await bootstrapOwner(app);
    const publisher = await acceptInvite(app, owner.cookies, "Publisher");
    const viewer = await acceptInvite(app, owner.cookies, "Viewer");

    const publisherSocket = await connectSocket(baseUrl, publisher.cookies.voxly_session);
    const viewerSocket = await connectSocket(baseUrl, viewer.cookies.voxly_session);
    sockets.push(publisherSocket, viewerSocket);
    await Promise.all([
      joinVoice(publisherSocket, "lobby"),
      joinVoice(viewerSocket, "lobby")
    ]);
    await emitWithAck(publisherSocket, "voice:setMediaState", { roomId: "lobby", media: { screen: true } });

    await onceEvent(publisherSocket, "voice:visualSubscriberState", () => {
      viewerSocket.emit("voice:setVisualSubscriptions", {
        roomId: "lobby",
        targets: [{ publisherUserId: publisher.user.id, kind: "screen" }]
      });
    });

    const cleared = await onceEvent<{
      roomId: string;
      viewerUserId: string;
      subscribedKinds: string[];
    }>(publisherSocket, "voice:visualSubscriberState", () => {
      viewerSocket.emit("voice:leave", "lobby");
    });
    assert.deepEqual(cleared, {
      roomId: "lobby",
      viewerUserId: viewer.user.id,
      subscribedKinds: []
    });
  });

  it("notifies a publisher for every viewer and when a viewer retries a selected screen", async () => {
    const owner = await bootstrapOwner(app);
    const publisher = await acceptInvite(app, owner.cookies, "Publisher");
    const firstViewer = await acceptInvite(app, owner.cookies, "First viewer");
    const secondViewer = await acceptInvite(app, owner.cookies, "Second viewer");
    const publisherSocket = await connectSocket(baseUrl, publisher.cookies.voxly_session);
    const firstViewerSocket = await connectSocket(baseUrl, firstViewer.cookies.voxly_session);
    const secondViewerSocket = await connectSocket(baseUrl, secondViewer.cookies.voxly_session);
    sockets.push(publisherSocket, firstViewerSocket, secondViewerSocket);

    await Promise.all([
      joinVoice(publisherSocket, "lobby"),
      joinVoice(firstViewerSocket, "lobby"),
      joinVoice(secondViewerSocket, "lobby")
    ]);
    await emitWithAck(publisherSocket, "voice:setMediaState", { roomId: "lobby", media: { screen: true } });
    const target = [{ publisherUserId: publisher.user.id, kind: "screen" }];

    const firstSubscription = onceEvent<{ viewerUserId: string; subscribedKinds: string[] }>(publisherSocket, "voice:visualSubscriberState", () => {
      firstViewerSocket.emit("voice:setVisualSubscriptions", { roomId: "lobby", targets: target });
    });
    assert.deepEqual(await firstSubscription, { roomId: "lobby", viewerUserId: firstViewer.user.id, subscribedKinds: ["screen"] });

    const secondSubscription = onceEvent<{ viewerUserId: string; subscribedKinds: string[] }>(publisherSocket, "voice:visualSubscriberState", () => {
      secondViewerSocket.emit("voice:setVisualSubscriptions", { roomId: "lobby", targets: target });
    });
    assert.deepEqual(await secondSubscription, { roomId: "lobby", viewerUserId: secondViewer.user.id, subscribedKinds: ["screen"] });

    const retry = onceEvent<{ viewerUserId: string; subscribedKinds: string[] }>(publisherSocket, "voice:visualSubscriberState", () => {
      firstViewerSocket.emit("voice:setVisualSubscriptions", { roomId: "lobby", targets: target });
    });
    assert.deepEqual(await retry, { roomId: "lobby", viewerUserId: firstViewer.user.id, subscribedKinds: ["screen"] });
  });

  it("broadcasts deafened and speaking state while deafen forces mic off", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");

    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    await joinVoice(memberSocket, "lobby");
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

    await joinVoice(memberSocket, "lobby");
    const snapshotPromise = onceEvent<{ roomId: string; members: Array<{ user: { nickname: string }; media: VoiceMediaState }> }>(
      observerSocket,
      "voice:snapshot"
    );
    await emitWithAck(memberSocket, "voice:setMediaState", { roomId: "lobby", media: { speaking: true } });
    const snapshot = await snapshotPromise;

    assert.equal(snapshot.roomId, "lobby");
    assert.equal(snapshot.members.find((item) => item.user.nickname === "Viewer")?.media.speaking, false);

    const memberSnapshot = await emitWithAck<{
      roomId: string;
      members: Array<{ user: { nickname: string }; media: VoiceMediaState }>;
    }>(memberSocket, "voice:snapshot", "lobby");
    assert.equal(memberSnapshot.members.find((item) => item.user.nickname === "Viewer")?.media.speaking, true);
  });

  it("enforces persistent owner mute while keeping owner deafen independent", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Moderated");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);

    const moderated = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/the-basement/members/${member.user.id}/voice-moderation`,
      cookies: owner.cookies,
      payload: { muted: true, deafened: true }
    });
    assert.equal(moderated.statusCode, 200);

    const joined = await joinVoice(memberSocket, "lobby", { ...defaultJoinMedia, mic: true, screen: true });
    assert.equal(joined.ok, true);
    assert.equal(joined.ok && joined.state.media.mic, false);
    assert.equal(joined.ok && joined.state.media.screen, true);
    assert.deepEqual(joined.ok && joined.state.moderation, { muted: true, deafened: true });

    const bypass = await emitWithAck<{
      ok: boolean;
      state: { media: VoiceMediaState; moderation: { muted: boolean; deafened: boolean } };
    }>(memberSocket, "voice:setMediaState", {
      roomId: "lobby",
      media: { mic: true, speaking: true }
    });
    assert.equal(bypass.state.media.mic, false);
    assert.equal(bypass.state.media.speaking, false);
    assert.equal(bypass.state.moderation.deafened, true);

    const ownerDeafenOnly = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/the-basement/members/${member.user.id}/voice-moderation`,
      cookies: owner.cookies,
      payload: { muted: false }
    });
    assert.deepEqual(ownerDeafenOnly.json(), { moderation: { muted: false, deafened: true } });

    const speaking = await emitWithAck<{
      state: { media: VoiceMediaState };
    }>(memberSocket, "voice:setMediaState", {
      roomId: "lobby",
      media: { mic: true, speaking: true }
    });
    assert.equal(speaking.state.media.mic, true);
    assert.equal(speaking.state.media.speaking, true);
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

    await Promise.all([
      joinVoice(senderSocket, "lobby"),
      joinVoice(receiverSocket, "lobby")
    ]);
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

  it("enforces server voice membership and keeps an account in one room globally", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Aylin");
    const outsider = await acceptInvite(app, owner.cookies, "Bora");
    const serverResponse = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Weekend Crew" }
    });
    const secondServerId = serverResponse.json().server.id as string;
    const secondServerRooms = await app.server.inject({
      method: "GET",
      url: `/api/servers/${secondServerId}/rooms`,
      cookies: owner.cookies
    });
    const secondLobbyId = secondServerRooms.json().rooms.find((room: { kind: string }) => room.kind === "voice").id as string;
    const inviteResponse = await app.server.inject({
      method: "POST",
      url: `/api/servers/${secondServerId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Aylin weekend", expiresInMinutes: 1440 }
    });
    await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: inviteResponse.json().invite.token }
    });

    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    const outsiderSocket = await connectSocket(baseUrl, outsider.cookies.voxly_session);
    sockets.push(memberSocket, outsiderSocket);

    await joinVoice(memberSocket, "lobby");
    await emitWithAck(memberSocket, "voice:snapshot", "lobby");
    await joinVoice(memberSocket, secondLobbyId);
    const defaultLobby = await emitWithAck<{ members: Array<{ user: { userId: string } }> }>(memberSocket, "voice:snapshot", "lobby");
    assert.equal(defaultLobby.members.some((entry) => entry.user.userId === member.user.id), false);

    assert.deepEqual(await joinVoice(outsiderSocket, secondLobbyId), {
      ok: false,
      error: "forbidden"
    });
    const protectedLobby = await emitWithAck<{ members: Array<{ user: { userId: string } }> }>(outsiderSocket, "voice:snapshot", secondLobbyId);
    assert.equal(protectedLobby.members.some((entry) => entry.user.userId === outsider.user.id), false);
  });

  it("joins an existing user's live sockets to a newly accepted server", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Aylin");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    const serverResponse = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Weekend Crew" }
    });
    const serverId = serverResponse.json().server.id as string;
    const inviteResponse = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Aylin weekend", expiresInMinutes: 1440 }
    });
    const snapshotPromise = onceEvent<{ serverId: string; users: Array<{ userId: string }> }>(
      memberSocket,
      "presence:serverSnapshot"
    );

    const joined = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: inviteResponse.json().invite.token }
    });
    const snapshot = await snapshotPromise;

    assert.equal(joined.statusCode, 200);
    assert.equal(snapshot.serverId, serverId);
    assert.equal(snapshot.users.some((user) => user.userId === member.user.id), true);
  });

  it("removes a member from voice immediately when an owner disconnects or bans them", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);

    await Promise.all([
      joinVoice(ownerSocket, "lobby"),
      joinVoice(memberSocket, "lobby")
    ]);
    await emitWithAck(memberSocket, "voice:snapshot", "lobby");

    const disconnected = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/voice/lobby/members/${member.user.id}/disconnect`,
      cookies: owner.cookies
    });
    assert.equal(disconnected.statusCode, 204);
    const afterDisconnect = await emitWithAck<{ members: Array<{ user: { userId: string } }> }>(ownerSocket, "voice:snapshot", "lobby");
    assert.equal(afterDisconnect.members.some((entry) => entry.user.userId === member.user.id), false);

    await joinVoice(memberSocket, "lobby");
    await emitWithAck(memberSocket, "voice:snapshot", "lobby");
    const offlinePromise = onceEvent<{ serverId: string; userId: string }>(ownerSocket, "presence:serverOffline");
    const banned = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/members/${member.user.id}/ban`,
      cookies: owner.cookies
    });
    const offline = await offlinePromise;
    assert.equal(banned.statusCode, 204);
    assert.deepEqual(offline, { serverId: "the-basement", userId: member.user.id });
    const afterBan = await emitWithAck<{ members: Array<{ user: { userId: string } }> }>(ownerSocket, "voice:snapshot", "lobby");
    assert.equal(afterBan.members.some((entry) => entry.user.userId === member.user.id), false);
  });

  it("stops kicked and banned members from receiving future text-room messages", async () => {
    const owner = await bootstrapOwner(app);
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    ownerSocket.emit("room:join", "general");
    await waitForSocketRoom(app, ownerSocket, "room:general");

    for (const action of ["kick", "ban"] as const) {
      const member = await acceptInvite(app, owner.cookies, `${action} target`);
      const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
      sockets.push(memberSocket);
      memberSocket.emit("room:join", "general");
      await waitForSocketRoom(app, memberSocket, "room:general");

      const moderationResponse = await app.server.inject({
        method: "POST",
        url: `/api/servers/the-basement/members/${member.user.id}/${action}`,
        cookies: owner.cookies
      });
      assert.equal(moderationResponse.statusCode, 204);

      const ownerMessage = onceEvent<{ body: string }>(ownerSocket, "message:new");
      const removedMemberMessage = expectNoEvent(memberSocket, "message:new");
      const messageResponse = await app.server.inject({
        method: "POST",
        url: "/api/rooms/general/messages",
        cookies: owner.cookies,
        payload: { body: `${action} must not receive this` }
      });

      assert.equal(messageResponse.statusCode, 201);
      assert.equal((await ownerMessage).body, `${action} must not receive this`);
      await removedMemberMessage;
    }
  });

  it("notifies server members about messages in rooms they have not opened", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Unread listener");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);

    const messagePromise = onceEvent<{ roomId: string; body: string }>(memberSocket, "message:new");
    const messageResponse = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: owner.cookies,
      payload: { body: "Count this while another channel is open" }
    });

    assert.equal(messageResponse.statusCode, 201);
    assert.deepEqual(await messagePromise, {
      ...messageResponse.json().message,
      roomId: "general",
      body: "Count this while another channel is open"
    });
  });

  it("publishes embed suppression to everyone viewing the text room", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Embed author");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    memberSocket.emit("room:join", "general");
    await waitForSocketRoom(app, memberSocket, "room:general");

    const created = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: member.cookies,
      payload: { body: "https://youtu.be/dQw4w9WgXcQ" }
    });
    const updatedPromise = onceEvent<{ id: string; suppressedEmbedKeys: string[] }>(memberSocket, "message:updated");
    const suppressed = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${created.json().message.id}/embeds`,
      cookies: owner.cookies,
      payload: { embedKey: "youtube:dQw4w9WgXcQ" }
    });

    assert.equal(suppressed.statusCode, 200);
    assert.deepEqual((await updatedPromise).suppressedEmbedKeys, ["youtube:dQw4w9WgXcQ"]);
  });

  it("invalidates member directories after an offline member is unbanned", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Offline unban");
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);

    const bannedChanged = onceEvent<{ serverId: string }>(ownerSocket, "server:directoryChanged");
    const banned = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/members/${member.user.id}/ban`,
      cookies: owner.cookies
    });
    assert.equal(banned.statusCode, 204);
    assert.deepEqual(await bannedChanged, { serverId: "the-basement" });

    const unbannedChanged = onceEvent<{ serverId: string }>(ownerSocket, "server:directoryChanged");
    const unbanned = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/members/${member.user.id}/unban`,
      cookies: owner.cookies
    });
    assert.equal(unbanned.statusCode, 204);
    assert.deepEqual(await unbannedChanged, { serverId: "the-basement" });
  });

  it("forces members out and invalidates room lists when an active voice channel is deleted", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);
    await joinVoice(memberSocket, "lobby");
    await waitForSocketRoom(app, memberSocket, "voice:lobby");

    const forced = onceEvent<{ roomId: string; reason: string }>(memberSocket, "voice:forceLeave");
    const changed = onceEvent<{ serverId: string; deletedRoomId: string }>(ownerSocket, "server:roomsChanged");
    const response = await app.server.inject({
      method: "DELETE",
      url: "/api/servers/the-basement/rooms/lobby",
      cookies: owner.cookies
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(await forced, { roomId: "lobby", reason: "room_deleted" });
    assert.deepEqual(await changed, { serverId: "the-basement", deletedRoomId: "lobby" });
    assert.equal(app.io.sockets.sockets.get(memberSocket.id ?? "")?.rooms.has("voice:lobby"), false);
  });

  it("forces voice cleanup and notifies every affected client when a server is deleted", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Temporary" }
    });
    const serverId = created.json().server.id as string;
    const invite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Temporary access" }
    });
    await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: invite.json().invite.token }
    });
    const rooms = (await app.server.inject({
      method: "GET",
      url: `/api/servers/${serverId}/rooms`,
      cookies: member.cookies
    })).json().rooms as Array<{ id: string; kind: string }>;
    const voiceRoom = rooms.find((room) => room.kind === "voice");
    assert.ok(voiceRoom);

    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);
    await joinVoice(memberSocket, voiceRoom.id);
    await waitForSocketRoom(app, memberSocket, `voice:${voiceRoom.id}`);

    const ownerDeleted = onceEvent<{ serverId: string }>(ownerSocket, "server:deleted");
    const memberDeleted = onceEvent<{ serverId: string }>(memberSocket, "server:deleted");
    const forced = onceEvent<{ roomId: string; reason: string }>(memberSocket, "voice:forceLeave");
    const response = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${serverId}`,
      cookies: owner.cookies
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(await forced, { roomId: voiceRoom.id, reason: "server_deleted" });
    assert.deepEqual(await ownerDeleted, { serverId });
    assert.deepEqual(await memberDeleted, { serverId });
    assert.equal(app.io.sockets.sockets.get(memberSocket.id ?? "")?.rooms.has(`voice:${voiceRoom.id}`), false);
  });

  it("rejects a malformed session cookie without killing the process", async () => {
    // `decodeURIComponent` throws on `%ZZ`. This parser runs in the handshake
    // middleware before any session exists, so an unguarded throw was an
    // unauthenticated remote kill.
    await assert.rejects(connectSocket(baseUrl, "%ZZ"), /connect_error/);
    await assert.rejects(connectSocket(baseUrl, "%E0%A4%A"), /connect_error/);

    // Still serving: a valid session connects and the HTTP side answers.
    const owner = await bootstrapOwner(app);
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
  });

  it("survives malformed socket payloads on every event", async () => {
    const owner = await bootstrapOwner(app);
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);

    // Each of these previously threw inside the listener — an unvalidated payload
    // dereference, or an ack the client simply omitted — and Socket.IO does not
    // catch listener exceptions.
    ownerSocket.emit("voice:setMediaState", { roomId: "nope", media: {} });
    ownerSocket.emit("voice:setMediaState", null);
    ownerSocket.emit("voice:snapshot", "lobby");
    ownerSocket.emit("rtc:signal", null);
    ownerSocket.emit("room:join", { toString: 1 });
    ownerSocket.emit("room:join", 123);
    ownerSocket.emit("voice:leave", null);
    ownerSocket.emit("voice:setVisualSubscriptions", null);

    await new Promise((resolve) => setTimeout(resolve, 150));

    // The connection and the process are both still up.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("probe never acked")), 1000);
      ownerSocket.emit("connection:probe", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
  });

  it("terminates a live socket when the member is banned globally", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Mallory");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);

    const voiceRoom = { id: "lobby" };
    assert.equal((await joinVoice(memberSocket, voiceRoom.id)).ok, true);

    const disconnected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("socket was never disconnected")), 1000);
      memberSocket.once("disconnect", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const ban = await app.server.inject({
      method: "POST",
      url: `/api/owner/users/${member.user.id}/ban`,
      cookies: owner.cookies
    });
    assert.equal(ban.statusCode, 204);

    // A ban that leaves the realtime connection alive is not a ban: the member
    // otherwise keeps receiving messages and relaying WebRTC signals.
    await disconnected;
    assert.equal(app.io.sockets.sockets.get(memberSocket.id ?? ""), undefined);

    // The revoked session cannot be used to reconnect either.
    await assert.rejects(connectSocket(baseUrl, member.cookies.voxly_session), /connect_error/);
  });

  it("blocks realtime access for a globally banned member that is still connected", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Mallory");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);

    // Ban directly in the database so the socket is not evicted — this isolates
    // the per-event authorization check from the eviction path.
    app.sqlite.prepare("update users set banned_at = ? where id = ?").run(new Date().toISOString(), member.user.id);

    const join = await joinVoice(memberSocket, "lobby");
    assert.equal(join.ok, false);

    const snapshot = await emitWithAck<{ roomId: string; members: unknown[] }>(memberSocket, "voice:snapshot", "lobby");
    assert.deepEqual(snapshot.members, []);
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

const defaultJoinMedia: VoiceMediaState = {
  mic: true,
  camera: false,
  screen: false,
  deafened: false,
  speaking: false
};

function joinVoice(
  socket: Socket,
  roomId: string,
  media: VoiceMediaState = defaultJoinMedia
): Promise<VoiceJoinAck> {
  return emitWithAck<VoiceJoinAck>(socket, "voice:join", { roomId, media });
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

function expectNoEvent(socket: Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, 250);
    const onEvent = () => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected ${event} event`));
    };
    socket.once(event, onEvent);
  });
}

async function waitForSocketRoom(app: VoxlyApp, socket: Socket, room: string) {
  const socketId = socket.id;
  assert.ok(socketId, "Connected socket must have an id");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (app.io.sockets.sockets.get(socketId)?.rooms.has(room)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Socket did not join ${room}`);
}
