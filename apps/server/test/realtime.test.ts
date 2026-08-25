import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import { musicBotNickname, musicIdentifierMaxLength, musicSetLogMaxLines } from "@voxly/shared";
import type { MusicCommand, MusicCommandAck, MusicControlAck, MusicPublishAck, MusicQueueState, VoiceJoinAck, VoiceMediaState, VoiceSetMediaAck, VoiceSnapshot } from "@voxly/shared";
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

  it("leaves another server's voice room alone when a member loses access to one server", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Selin");
    const serverResponse = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Weekend Crew" }
    });
    const secondServerId = serverResponse.json().server.id as string;
    const inviteResponse = await app.server.inject({
      method: "POST",
      url: `/api/servers/${secondServerId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Selin weekend", expiresInMinutes: 1440 }
    });
    await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: inviteResponse.json().invite.token }
    });

    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);

    // The member is talking in the default server, and holds no voice
    // membership at all in the server they are about to be kicked from.
    await joinVoice(memberSocket, "lobby");
    await emitWithAck(memberSocket, "voice:snapshot", "lobby");

    const stayedInVoice = expectNoEvent(memberSocket, "voice:forceLeave");
    const kicked = await app.server.inject({
      method: "POST",
      url: `/api/servers/${secondServerId}/members/${member.user.id}/kick`,
      cookies: owner.cookies
    });
    assert.equal(kicked.statusCode, 204);
    await stayedInVoice;

    const lobby = await emitWithAck<{ members: Array<{ user: { userId: string } }> }>(ownerSocket, "voice:snapshot", "lobby");
    assert.equal(lobby.members.some((entry) => entry.user.userId === member.user.id), true);
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

  it("mutes on entry to the AFK room, whatever the joiner asked for", async () => {
    // A member parked by their own idle timer is not the one making the
    // request, so the mute cannot be left to the client to apply.
    const owner = await bootstrapOwner(app);
    const socket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(socket);
    const afkRoom = app.sqlite
      .prepare("select id from rooms where server_id = ? and is_afk = 1")
      .all("the-basement")[0] as { id: string } | undefined;
    assert.ok(afkRoom, "the server has an AFK room");

    const joined = await joinVoice(socket, afkRoom.id, { ...defaultJoinMedia, mic: true });

    assert.equal(joined.ok, true);
    assert.equal(joined.ok && joined.state.media.mic, false);
  });

  it("moves a member the owner sends to another voice channel", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    await joinVoice(memberSocket, "lobby");

    const moved = onceEvent<{ roomId: string }>(memberSocket, "voice:moveTo");
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers/the-basement/rooms",
      cookies: owner.cookies,
      payload: { name: "second", kind: "voice" }
    });
    const targetRoomId = created.json().room.id as string;
    const response = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/voice/members/${member.user.id}/move`,
      cookies: owner.cookies,
      payload: { roomId: targetRoomId }
    });

    assert.equal(response.statusCode, 204);
    // The server cannot join for them, so the move arrives as an instruction.
    assert.deepEqual(await moved, { roomId: targetRoomId });
  });

  it("refuses to move a member who is not in voice", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");

    const response = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/voice/members/${member.user.id}/move`,
      cookies: owner.cookies,
      payload: { roomId: "lobby" }
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "member_not_in_voice");
  });

  it("refuses a move for anyone but the server owner", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");
    const other = await acceptInvite(app, owner.cookies, "Ada");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    await joinVoice(memberSocket, "lobby");

    const response = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/voice/members/${member.user.id}/move`,
      cookies: other.cookies,
      payload: { roomId: "lobby" }
    });

    assert.ok(response.statusCode === 403 || response.statusCode === 401);
  });

  it("refuses a move into another server's room", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    await joinVoice(memberSocket, "lobby");
    const otherServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Elsewhere" }
    });
    const otherServerId = otherServer.json().server.id as string;
    const foreign = await app.server.inject({
      method: "POST",
      url: `/api/servers/${otherServerId}/rooms`,
      cookies: owner.cookies,
      payload: { name: "far", kind: "voice" }
    });

    const response = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/voice/members/${member.user.id}/move`,
      cookies: owner.cookies,
      payload: { roomId: foreign.json().room.id }
    });

    assert.equal(response.statusCode, 404);
  });

  it("refuses an unmute from inside the AFK room, including from the owner", async () => {
    // Regression: entry mute alone was not enough. `voice:setMediaState` let the
    // member turn the microphone straight back on, so the room muted nobody.
    const owner = await bootstrapOwner(app);
    const socket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(socket);
    const afkRoom = app.sqlite
      .prepare("select id from rooms where server_id = ? and is_afk = 1")
      .all("the-basement")[0] as { id: string } | undefined;
    assert.ok(afkRoom);
    await joinVoice(socket, afkRoom.id, { ...defaultJoinMedia, mic: false });

    const ack = await new Promise<VoiceSetMediaAck>((resolve) => {
      socket.emit("voice:setMediaState", { roomId: afkRoom.id, media: { mic: true } }, resolve);
    });

    assert.equal(ack.ok, true, "the request is accepted rather than errored");
    assert.equal(ack.ok && ack.state.media.mic, false, "but the microphone stays closed");
  });

  it("restores the microphone once the member leaves the AFK room", async () => {
    // The mute belongs to the room, so leaving is how you get it back.
    const owner = await bootstrapOwner(app);
    const socket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(socket);
    const afkRoom = app.sqlite
      .prepare("select id from rooms where server_id = ? and is_afk = 1")
      .all("the-basement")[0] as { id: string } | undefined;
    assert.ok(afkRoom);
    await joinVoice(socket, afkRoom.id, { ...defaultJoinMedia, mic: true });

    const moved = await joinVoice(socket, "lobby", { ...defaultJoinMedia, mic: true });

    assert.equal(moved.ok && moved.state.media.mic, true);
  });

  it("leaves an ordinary voice room's microphone request alone", async () => {
    const owner = await bootstrapOwner(app);
    const socket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(socket);

    const joined = await joinVoice(socket, "lobby", { ...defaultJoinMedia, mic: true });

    assert.equal(joined.ok && joined.state.media.mic, true);
  });

  it("publishes an away status to the server without dropping the member offline", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);
    await waitForSocketRoom(app, ownerSocket, "server:the-basement");

    const idle = onceEvent<{ serverId: string; userId: string; status: string }>(ownerSocket, "presence:serverStatus");
    memberSocket.emit("presence:setStatus", "idle");
    assert.deepEqual(await idle, { serverId: "the-basement", userId: member.user.id, status: "idle" });

    const back = onceEvent<{ status: string }>(ownerSocket, "presence:serverStatus");
    memberSocket.emit("presence:setStatus", "online");
    assert.equal((await back).status, "online");
  });

  it("keeps a member online while any of their connections is still active", async () => {
    // Two tabs, one idle: the person is at the keyboard.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const firstTab = await connectSocket(baseUrl, member.cookies.voxly_session);
    const secondTab = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, firstTab, secondTab);
    await waitForSocketRoom(app, ownerSocket, "server:the-basement");

    let statuses: string[] = [];
    ownerSocket.on("presence:serverStatus", (payload: { status: string }) => { statuses.push(payload.status); });
    firstTab.emit("presence:setStatus", "idle");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(statuses, [], "one idle tab does not make the member away");

    const idle = onceEvent<{ status: string }>(ownerSocket, "presence:serverStatus");
    secondTab.emit("presence:setStatus", "idle");
    assert.equal((await idle).status, "idle", "every connection idle means the member is away");
  });

  it("tells existing members about a new channel instead of waiting for their next reload", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(memberSocket);
    await waitForSocketRoom(app, memberSocket, "server:the-basement");

    const changed = onceEvent<{ serverId: string; deletedRoomId?: string }>(memberSocket, "server:roomsChanged");
    const response = await app.server.inject({
      method: "POST",
      url: "/api/servers/the-basement/rooms",
      cookies: owner.cookies,
      payload: { name: "announcements", kind: "text" }
    });

    assert.equal(response.statusCode, 201);
    // Creation carries no room id: it is a refresh signal, not a forced move.
    assert.deepEqual(await changed, { serverId: "the-basement" });
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

describe("music bot presence", () => {
  const botToken = "test-bot-token-that-is-long-enough";
  let app: VoxlyApp;
  let baseUrl: string;
  let sockets: Socket[] = [];

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: false,
      bot: { token: botToken }
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    sockets = [];
    await app.close();
  });

  it("appears online to the rest of the server, marked as a bot", async () => {
    const owner = await bootstrapOwner(app);
    const exchange = await app.server.inject({
      method: "POST",
      url: "/api/bot/sessions",
      headers: { authorization: `Bearer ${botToken}` }
    });
    const [botSession] = exchange.json().sessions as Array<{ serverId: string; userId: string; token: string }>;

    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const onlinePromise = onceEvent<{ serverId: string; user: { userId: string; nickname: string; isBot?: boolean } }>(
      ownerSocket,
      "presence:serverOnline"
    );
    const botSocket = await connectSocket(baseUrl, botSession.token);
    sockets.push(ownerSocket, botSocket);

    const online = await onlinePromise;
    assert.equal(online.serverId, botSession.serverId);
    assert.equal(online.user.userId, botSession.userId);
    assert.equal(online.user.nickname, musicBotNickname);
    assert.equal(online.user.isBot, true);
  });

  it("marks the bot and no one else", async () => {
    const owner = await bootstrapOwner(app);
    const exchange = await app.server.inject({
      method: "POST",
      url: "/api/bot/sessions",
      headers: { authorization: `Bearer ${botToken}` }
    });
    const [botSession] = exchange.json().sessions as Array<{ token: string }>;

    const botSocket = await connectSocket(baseUrl, botSession.token);
    const onlinePromise = onceEvent<{ user: { userId: string; isBot?: boolean } }>(botSocket, "presence:serverOnline");
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(botSocket, ownerSocket);

    const online = await onlinePromise;
    assert.equal(online.user.userId, owner.user.id);
    assert.equal(online.user.isBot, false, "a person must never be presented as a bot");
  });

  it("takes the bot's microphone away when an owner mutes it, exactly as for a person", async () => {
    // This is the fact the bot reads in order to enforce its own silence.
    // Media is peer-to-peer, so a mute the server records and never puts in
    // front of the bot is a mute nobody stops hearing — and `media.mic` is
    // where an owner's mute *and* the AFK room's forced mute both end up, which
    // is why the bot reads the microphone rather than the flag beside it.
    // ADR-0009.
    const owner = await bootstrapOwner(app);
    const exchange = await app.server.inject({
      method: "POST",
      url: "/api/bot/sessions",
      headers: { authorization: `Bearer ${botToken}` }
    });
    const [botSession] = exchange.json().sessions as Array<{ serverId: string; userId: string; token: string }>;
    const botSocket = await connectSocket(baseUrl, botSession.token);
    sockets.push(botSocket);
    await joinVoice(botSocket, "lobby", { mic: true, camera: false, screen: false, deafened: false, speaking: true });

    // Waiting for the snapshot that carries the mute rather than the next one:
    // joining publishes one of its own, and which of the two arrives first is
    // not something this test is about.
    const muted = nextSnapshotWhere(botSocket, (snapshot) => snapshot.members
      .some((member) => member.user.userId === botSession.userId && member.moderation.muted));
    const patched = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${botSession.serverId}/members/${botSession.userId}/voice-moderation`,
      cookies: owner.cookies,
      payload: { muted: true, deafened: false }
    });
    assert.equal(patched.statusCode, 200);

    const self = (await muted).members.find((member) => member.user.userId === botSession.userId);
    assert.equal(self?.moderation.muted, true);
    assert.equal(self?.media.mic, false, "the bot is told, in its own member state, that it may not transmit");
    assert.equal(self?.media.speaking, false);
  });

  it("takes the bot's microphone away in the AFK room, where nobody muted it by name", async () => {
    // The other half of the same fact. The AFK room's mute is a property of the
    // room rather than of the member, so `moderation` stays clear and only the
    // microphone says so — which is why the bot reads the microphone and not
    // the flag beside it. ADR-0009 §6.
    //
    // Nothing in the product puts the bot in here: a Summon into an AFK room is
    // refused at the door and the bot does not follow a move. This asserts the
    // rule rather than a journey anybody can currently take.
    const exchange = await app.server.inject({
      method: "POST",
      url: "/api/bot/sessions",
      headers: { authorization: `Bearer ${botToken}` }
    });
    const [botSession] = exchange.json().sessions as Array<{ serverId: string; userId: string; token: string }>;
    const botSocket = await connectSocket(baseUrl, botSession.token);
    sockets.push(botSocket);

    const ack = await joinVoice(botSocket, `afk-${botSession.serverId}`, {
      mic: true,
      camera: false,
      screen: false,
      deafened: false,
      speaking: true
    });

    assert.ok(ack.ok, "joining the AFK room is allowed; being heard in it is not");
    assert.equal(ack.state.media.mic, false, "the room took the microphone");
    assert.equal(ack.state.media.speaking, false);
    assert.equal(ack.state.moderation.muted, false, "and no owner muted anyone to do it");
  });

  it("refuses to move the bot, and tells the owner rather than moving nothing", async () => {
    // The bot goes where it is summoned and nowhere else (ADR-0010). Left
    // unrefused this route emits `voice:moveTo` at a process that has no
    // handler for it, answers 204, and writes a `voice.moved` audit row for a
    // move that never happened.
    const owner = await bootstrapOwner(app);
    const exchange = await app.server.inject({
      method: "POST",
      url: "/api/bot/sessions",
      headers: { authorization: `Bearer ${botToken}` }
    });
    const [botSession] = exchange.json().sessions as Array<{ serverId: string; userId: string; token: string }>;
    const botSocket = await connectSocket(baseUrl, botSession.token);
    sockets.push(botSocket);
    await joinVoice(botSocket, "lobby");

    const unmoved = expectNoEvent(botSocket, "voice:moveTo");
    const response = await app.server.inject({
      method: "POST",
      url: `/api/servers/${botSession.serverId}/voice/members/${botSession.userId}/move`,
      cookies: owner.cookies,
      payload: { roomId: `afk-${botSession.serverId}` }
    });

    assert.equal(response.statusCode, 409, "refused even though the move would otherwise have worked");
    assert.equal(response.json().error, "cannot_moderate_bot");
    await unmoved;
    const audited = app.sqlite
      .prepare("select count(*) as count from audit_events where action = 'voice.moved'")
      .get() as { count: number };
    assert.equal(audited.count, 0, "and nothing was written down as having happened");
  });
});

describe("music bot control", () => {
  const botToken = "test-bot-token-that-is-long-enough";
  let app: VoxlyApp;
  let baseUrl: string;
  let sockets: Socket[] = [];

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: false,
      bot: { token: botToken }
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    sockets = [];
    await app.close();
  });

  /**
   * A bot double. It answers every command, because the real one does and the
   * member's acknowledgement is now relayed from that answer — a double that
   * stayed silent would make every test here wait out the bot timeout.
   */
  async function connectBot(answer: MusicCommandAck = { ok: true, kind: "track", track: null }) {
    const exchange = await app.server.inject({
      method: "POST",
      url: "/api/bot/sessions",
      headers: { authorization: `Bearer ${botToken}` }
    });
    const [botSession] = exchange.json().sessions as Array<{ serverId: string; userId: string; token: string }>;
    const botSocket = await connectSocket(baseUrl, botSession.token);
    const received: Array<{ roomId: string; command: MusicCommand; requestedByUserId: string }> = [];
    botSocket.on("music:command", (payload: typeof received[number], ack: (response: MusicCommandAck) => void) => {
      received.push(payload);
      ack(answer);
    });
    sockets.push(botSocket);
    return { botSession, botSocket, received };
  }

  it("forwards a pasted link from a member who is in the voice room", async () => {
    const owner = await bootstrapOwner(app);
    const track = { id: "aB3dE5gH7jK", title: "Nocturne in E-flat major", durationSeconds: 273 };
    const { received } = await connectBot({ ok: true, kind: "track", track });
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    const command = { kind: "add", input: "https://www.youtube.com/watch?v=aB3dE5gH7jK" } as const;
    const ack = await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command });

    // The input travels through untouched: which links are playable — and
    // whether this is a link at all rather than a name to search for — is the
    // bot's knowledge, and the server holds no second opinion about it.
    assert.deepEqual(received, [{ roomId: "lobby", command, requestedByUserId: owner.user.id }]);
    assert.deepEqual(ack, { ok: true, kind: "track", track }, "and the Track it resolved comes back to the asker");
  });

  it("relays the bot's refusal rather than reporting a success it did not have", async () => {
    // Only the bot can tell that a link resolves to nothing. Absorbing that
    // answer would leave the member watching a room where nothing happens.
    const owner = await bootstrapOwner(app);
    await connectBot({ ok: false, error: "track_unavailable" });
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    const ack = await emitWithAck<MusicControlAck>(ownerSocket, "music:control", {
      roomId: "lobby",
      command: { kind: "add", input: "https://www.youtube.com/watch?v=G0n3F0r3v3r" }
    });

    assert.deepEqual(ack, { ok: false, error: "track_unavailable" });
  });

  it("hands a search's results to the member who asked, and to nobody else", async () => {
    // The first thing on this wire that is not the room's. Everyone in a voice
    // room sees one Queue; a list of Results belongs to the one member still
    // deciding, so it travels on the acknowledgement and never as an event to
    // the room. ADR-0007.
    const owner = await bootstrapOwner(app);
    const results = [{
      track: { id: "aB3dE5gH7jK", title: "Nocturne in E-flat major", durationSeconds: 273 },
      channel: "A Channel",
      url: "https://www.youtube.com/watch?v=aB3dE5gH7jK"
    }];
    const { received } = await connectBot({ ok: true, kind: "results", results });
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    const quiet = expectNoEvent(ownerSocket, "music:queue");
    const command = { kind: "add", input: "nocturne in e flat" } as const;
    const ack = await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command });

    assert.deepEqual(ack, { ok: true, kind: "results", results });
    assert.deepEqual(received.map((entry) => entry.command), [command], "a name travels on the same verb a link does");
    await quiet;
  });

  it("forwards the commands that carry no link", async () => {
    const owner = await bootstrapOwner(app);
    const { received } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    for (const kind of ["play", "stop", "leave"] as const) {
      assert.deepEqual(
        await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command: { kind } }),
        { ok: true, kind: "track", track: null },
        kind
      );
    }
    assert.deepEqual(received.map((entry) => entry.command.kind), ["play", "stop", "leave"]);
  });

  it("forwards a skip and a removal with the entry they name", async () => {
    // The server does not know what an `entryId` refers to and must not: which
    // entry is at the head of the Queue is the bot's knowledge, and a stale one
    // is a request the bot succeeds at without moving, not a refusal here.
    const owner = await bootstrapOwner(app);
    const { received } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    for (const command of [{ kind: "skip", entryId: "entry-1" }, { kind: "remove", entryId: "entry-2" }] as const) {
      assert.deepEqual(
        await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command }),
        { ok: true, kind: "track", track: null },
        command.kind
      );
    }
    assert.deepEqual(received.map((entry) => entry.command), [
      { kind: "skip", entryId: "entry-1" },
      { kind: "remove", entryId: "entry-2" }
    ]);
  });

  it("refuses a member who is in the server but not in that voice room", async () => {
    const owner = await bootstrapOwner(app);
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);

    const silence = expectNoEvent(botSocket, "music:command");
    const ack = await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command: { kind: "play" } });

    assert.deepEqual(ack, { ok: false, error: "not_in_voice_room" });
    await silence;
  });

  it("refuses the AFK room, where nothing the bot sent could be wanted", async () => {
    const owner = await bootstrapOwner(app);
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    const afkRoomId = "afk-the-basement";
    await joinVoice(ownerSocket, afkRoomId);

    const silence = expectNoEvent(botSocket, "music:command");
    const ack = await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: afkRoomId, command: { kind: "play" } });

    assert.deepEqual(ack, { ok: false, error: "afk_room" });
    await silence;
  });

  it("says the bot is offline rather than dropping the request silently", async () => {
    const owner = await bootstrapOwner(app);
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    const ack = await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command: { kind: "play" } });

    assert.deepEqual(ack, { ok: false, error: "bot_offline" });
  });

  it("refuses a command it does not know, a link that is not a string, and a room that is not voice", async () => {
    const owner = await bootstrapOwner(app);
    await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    assert.deepEqual(
      await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command: { kind: "drop-the-bass" } }),
      { ok: false, error: "room_not_found" }
    );
    assert.deepEqual(
      await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "general", command: { kind: "play" } }),
      { ok: false, error: "room_not_found" }
    );
    assert.deepEqual(
      await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command: { kind: "add" } }),
      { ok: false, error: "room_not_found" },
      "an add with nothing on it is not an add"
    );
    assert.deepEqual(
      await emitWithAck<MusicControlAck>(ownerSocket, "music:control", {
        roomId: "lobby",
        command: { kind: "add", input: "x".repeat(4_000) }
      }),
      { ok: false, error: "room_not_found" },
      "and what a member typed is bounded before it reaches another process"
    );
    assert.deepEqual(
      await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command: { kind: "skip" } }),
      { ok: false, error: "room_not_found" },
      "a skip that names no entry is not a skip"
    );
    assert.deepEqual(
      await emitWithAck<MusicControlAck>(ownerSocket, "music:control", {
        roomId: "lobby",
        command: { kind: "remove", entryId: "e".repeat(musicIdentifierMaxLength + 1) }
      }),
      { ok: false, error: "room_not_found" },
      "and an entry id is bounded like every other opaque identifier on this wire"
    );
  });

  it("gives the whole room the Queue the bot published", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);
    await joinVoice(ownerSocket, "lobby");
    await joinVoice(memberSocket, "lobby");
    await joinVoice(botSocket, "lobby");

    const state = {
      playing: true,
      entries: [{
        entryId: "entry-1",
        requestedByUserId: owner.user.id,
        track: { id: "aB3dE5gH7jK", title: "Nocturne in E-flat major", durationSeconds: 273 }
      }],
      // The Set log travels with the Queue it describes, so the member who
      // pressed nothing is given the same explanation as the member who did.
      log: [{
        lineId: "line-1",
        action: "added",
        requestedByUserId: owner.user.id,
        trackTitle: "Nocturne in E-flat major"
      }]
    };
    const seen = Promise.all([
      onceEvent<{ roomId: string; state: typeof state }>(ownerSocket, "music:queue"),
      onceEvent<{ roomId: string; state: typeof state }>(memberSocket, "music:queue")
    ]);
    const ack = await emitWithAck<MusicPublishAck>(botSocket, "music:publish", { roomId: "lobby", state });

    assert.deepEqual(ack, { ok: true });
    // The member who pasted nothing sees exactly what the member who pasted
    // the link sees. That is the whole point of the Queue being published.
    for (const delivery of await seen) {
      assert.deepEqual(delivery, { roomId: "lobby", state });
    }
  });

  it("refuses a Queue from a member who is not the Music bot", async () => {
    const owner = await bootstrapOwner(app);
    await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    const silence = expectNoEvent(ownerSocket, "music:queue");
    const ack = await emitWithAck<MusicPublishAck>(ownerSocket, "music:publish", {
      roomId: "lobby",
      state: { playing: true, entries: [], log: [] }
    });

    assert.deepEqual(ack, { ok: false, error: "not_authorized" });
    await silence;
  });

  it("refuses a Queue from a bot that is not in the room", async () => {
    // An owner who has just disconnected the bot must not have it go on
    // narrating a Set it is no longer part of.
    const owner = await bootstrapOwner(app);
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");

    const silence = expectNoEvent(ownerSocket, "music:queue");
    const ack = await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
      roomId: "lobby",
      state: { playing: false, entries: [], log: [] }
    });

    assert.deepEqual(ack, { ok: false, error: "not_authorized" });
    await silence;
  });

  it("refuses a Queue that is not the shape everyone agreed on", async () => {
    const owner = await bootstrapOwner(app);
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");
    await joinVoice(botSocket, "lobby");

    const entry = {
      entryId: "entry-1",
      requestedByUserId: owner.user.id,
      track: { id: "aB3dE5gH7jK", title: "Nocturne", durationSeconds: 273 }
    };
    assert.deepEqual(
      await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
        roomId: "lobby",
        state: { playing: true, entries: [{ ...entry, track: { ...entry.track, title: "x".repeat(500) } }], log: [] }
      }),
      { ok: false, error: "invalid_state" },
      "a title is somebody else's string on its way to every browser in the room"
    );
    assert.deepEqual(
      await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
        roomId: "lobby",
        state: { playing: true, entries: Array.from({ length: 200 }, () => entry), log: [] }
      }),
      { ok: false, error: "invalid_state" },
      "and the Queue is bounded before it is broadcast"
    );
    assert.deepEqual(
      await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
        roomId: "lobby",
        state: { playing: true, entries: [{ ...entry, nickname: "Owner" }], log: [] }
      }),
      { ok: false, error: "invalid_state" },
      "a field nobody agreed on must not ride along"
    );
    assert.deepEqual(
      await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
        roomId: "lobby",
        state: {
          playing: true,
          entries: [entry],
          log: [{ lineId: "line-1", action: "added", requestedByUserId: owner.user.id, trackTitle: "x".repeat(500) }]
        }
      }),
      { ok: false, error: "invalid_state" },
      "a Track's title is somebody else's string wherever on this payload it sits"
    );
    assert.deepEqual(
      await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
        roomId: "lobby",
        state: {
          playing: true,
          entries: [entry],
          log: Array.from({ length: musicSetLogMaxLines + 1 }, (_unused, index) => ({
            lineId: `line-${index}`,
            action: "paused",
            requestedByUserId: owner.user.id,
            trackTitle: null
          }))
        }
      }),
      { ok: false, error: "invalid_state" },
      "and the Set log is bounded before it is broadcast, exactly as the Queue is"
    );
    assert.deepEqual(
      await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
        roomId: "lobby",
        state: {
          playing: true,
          entries: [entry],
          log: [{ lineId: "line-1", action: "danced", requestedByUserId: owner.user.id, trackTitle: null }]
        }
      }),
      { ok: false, error: "invalid_state" },
      "a verb nobody agreed on is not a thing a member can be said to have done"
    );
  });

  it("relays a line about a Track that would not play, which names no member", async () => {
    // The bot writes three lines about itself, and they are the only ones on
    // this payload with no member on them. The server holds no opinion about
    // which verbs those are — a second copy of that rule here would refuse a
    // publish the bot was right to make, and take the room's whole Queue with
    // it. What it does check is that the shape is one everybody agreed on.
    const owner = await bootstrapOwner(app);
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");
    await joinVoice(botSocket, "lobby");

    const relayed = new Promise<MusicQueueState>((resolve) => {
      ownerSocket.once("music:queue", (payload: { roomId: string; state: MusicQueueState }) => resolve(payload.state));
    });
    const ack = await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
      roomId: "lobby",
      state: {
        playing: false,
        entries: [],
        log: [
          { lineId: "line-1", action: "failedUnavailable", requestedByUserId: null, trackTitle: "Nocturne" },
          { lineId: "line-2", action: "failedSource", requestedByUserId: null, trackTitle: "Gymnopédie" },
          { lineId: "line-3", action: "failedBot", requestedByUserId: null, trackTitle: "Clair de lune" }
        ]
      }
    });

    assert.deepEqual(ack, { ok: true });
    assert.deepEqual((await relayed).log.map((line) => line.action), [
      "failedUnavailable",
      "failedSource",
      "failedBot"
    ]);
  });

  it("never writes the Set log down, anywhere", async () => {
    // An acceptance criterion, and this is where it is enforced rather than
    // merely not violated: the server is the wire for the Queue and keeps no
    // copy of it (ADR-0005), and there is no table for a log line to go in.
    // Asserted against every table the schema has rather than a list this test
    // keeps, so a table added later is covered without anybody remembering to.
    const owner = await bootstrapOwner(app);
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(ownerSocket);
    await joinVoice(ownerSocket, "lobby");
    await joinVoice(botSocket, "lobby");
    const marker = "Nocturne-that-must-not-be-written-down";

    const ack = await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
      roomId: "lobby",
      state: {
        playing: true,
        entries: [],
        log: [{ lineId: "line-1", action: "skipped", requestedByUserId: owner.user.id, trackTitle: marker }]
      }
    });

    assert.deepEqual(ack, { ok: true }, "it was relayed");
    const stored = everyTable(app);
    // The control: this test is only saying anything if it can see what the
    // database *does* hold. A nickname is written down; a Set log line is not.
    assert.equal(stored.includes(owner.user.nickname), true, "the nickname is there to be found");
    assert.equal(stored.includes(marker), false, "and the Set log is not");
  });

  it("refuses a Queue for a text channel or a channel that is not there", async () => {
    const { botSocket } = await connectBot();

    for (const roomId of ["general", "no-such-room"]) {
      assert.deepEqual(
        await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
          roomId,
          state: { playing: false, entries: [], log: [] }
        }),
        { ok: false, error: "room_not_found" },
        roomId
      );
    }
  });

  it("keeps the Queue inside the voice room, not the whole server", async () => {
    // Who queued what is the business of the people listening, exactly as the
    // room's speaking state is.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");
    const { botSocket } = await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const outsiderSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, outsiderSocket);
    await joinVoice(ownerSocket, "lobby");
    await joinVoice(botSocket, "lobby");

    const silence = expectNoEvent(outsiderSocket, "music:queue");
    await emitWithAck<MusicPublishAck>(botSocket, "music:publish", {
      roomId: "lobby",
      state: { playing: false, entries: [], log: [] }
    });

    await silence;
  });

  it("delivers the command to the bot alone, never to the rest of the room", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");
    await connectBot();
    const ownerSocket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    const memberSocket = await connectSocket(baseUrl, member.cookies.voxly_session);
    sockets.push(ownerSocket, memberSocket);
    await joinVoice(ownerSocket, "lobby");
    await joinVoice(memberSocket, "lobby");

    const silence = expectNoEvent(memberSocket, "music:command");
    await emitWithAck<MusicControlAck>(ownerSocket, "music:control", { roomId: "lobby", command: { kind: "play" } });

    await silence;
  });
});

/**
 * Everything the database is holding, as one string.
 *
 * Read from `sqlite_master` rather than from a list of tables kept here,
 * because the assertion this serves is "it is written nowhere" — and a list
 * would quietly stop covering a table somebody adds later, which is exactly
 * when it would matter.
 */
function everyTable(app: VoxlyApp) {
  const tables = app.sqlite
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return tables
    .map((table) => JSON.stringify(app.sqlite.prepare(`select * from "${table.name}"`).all()))
    .join("");
}

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

/**
 * The next snapshot that says something in particular, rather than simply the
 * next one. A voice room publishes on every join, leave and media change, so a
 * test about one of those has to name the one it means.
 */
function nextSnapshotWhere(socket: Socket, matches: (snapshot: VoiceSnapshot) => boolean): Promise<VoiceSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("voice:snapshot", onSnapshot);
      reject(new Error("Timed out waiting for the voice:snapshot this test meant"));
    }, 1000);
    const onSnapshot = (snapshot: VoiceSnapshot) => {
      if (!matches(snapshot)) return;
      clearTimeout(timeout);
      socket.off("voice:snapshot", onSnapshot);
      resolve(snapshot);
    };
    socket.on("voice:snapshot", onSnapshot);
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
