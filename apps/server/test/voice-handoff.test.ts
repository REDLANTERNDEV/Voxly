import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import type { VoiceForceLeaveReason, VoiceJoinAck, VoiceMediaState, VoiceSnapshot } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { deviceLabel } from "../src/auth/deviceLabel.js";
import { createOpaqueToken, hashToken } from "../src/auth/tokens.js";

/**
 * Voice follows the newest Device.
 *
 * Voice membership is keyed by *account*, one slot per member. Once linking
 * exists a member can hold two Devices, and without a rule about which of them
 * owns the call, both answer every negotiation from every peer — which breaks
 * the mesh for everybody else in the room, not just for the member who linked.
 *
 * These pin the rule and the two ways it quietly undoes itself: the displaced
 * Device's own goodbye, and its later disconnect.
 */
describe("voice follows the newest Device", () => {
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

  it("tells the first Device it was displaced, and says why", async () => {
    const owner = await bootstrapOwner(app);
    const laptop = await connect(owner.cookies.voxly_session);
    const phoneToken = linkAnotherDevice(app, owner.user.id);
    await joinVoice(laptop, "lobby");

    const displaced = onceEvent<{ roomId: string; reason: VoiceForceLeaveReason }>(laptop, "voice:forceLeave");
    const phone = await connect(phoneToken);
    await joinVoice(phone, "lobby");

    const notice = await displaced;
    assert.equal(notice.roomId, "lobby");
    // Not an error. Nothing went wrong — the member moved.
    assert.equal(notice.reason, "joined_another_device");
  });

  it("leaves the account in the room, held by the new Device", async () => {
    const owner = await bootstrapOwner(app);
    const laptop = await connect(owner.cookies.voxly_session);
    const phoneToken = linkAnotherDevice(app, owner.user.id);
    await joinVoice(laptop, "lobby");

    const phone = await connect(phoneToken);
    const joined = await joinVoice(phone, "lobby");

    assert.equal(joined.ok, true);
    const snapshot = await snapshotOf(phone, "lobby");
    // One member, not two, and not none.
    assert.equal(snapshot.members.length, 1);
    assert.equal(snapshot.members[0]?.user.userId, owner.user.id);
  });

  it("does not undo itself when the displaced Device says goodbye", async () => {
    // The client answers `voice:forceLeave` by tearing down, and tearing down
    // emits `voice:leave`. Membership is keyed by account, so that goodbye
    // would remove the account from the room the phone had just taken over.
    const owner = await bootstrapOwner(app);
    const laptop = await connect(owner.cookies.voxly_session);
    const phoneToken = linkAnotherDevice(app, owner.user.id);
    await joinVoice(laptop, "lobby");
    const phone = await connect(phoneToken);
    await joinVoice(phone, "lobby");

    laptop.emit("voice:leave", "lobby");
    await settle();

    const snapshot = await snapshotOf(phone, "lobby");
    assert.equal(snapshot.members.length, 1, "the displaced Device hung up the new one's call");
  });

  it("does not end the call when the displaced Device disconnects", async () => {
    // Closing the laptop tab afterwards is the same hazard arriving later.
    const owner = await bootstrapOwner(app);
    const laptop = await connect(owner.cookies.voxly_session);
    const phoneToken = linkAnotherDevice(app, owner.user.id);
    await joinVoice(laptop, "lobby");
    const phone = await connect(phoneToken);
    await joinVoice(phone, "lobby");

    laptop.disconnect();
    await settle();

    const snapshot = await snapshotOf(phone, "lobby");
    assert.equal(snapshot.members.length, 1, "the displaced Device's disconnect ended the call");
  });

  it("still lets the holding Device leave normally", async () => {
    const owner = await bootstrapOwner(app);
    const laptop = await connect(owner.cookies.voxly_session);
    const phoneToken = linkAnotherDevice(app, owner.user.id);
    await joinVoice(laptop, "lobby");
    const phone = await connect(phoneToken);
    await joinVoice(phone, "lobby");

    phone.emit("voice:leave", "lobby");
    await settle();

    const snapshot = await snapshotOf(laptop, "lobby");
    assert.equal(snapshot.members.length, 0);
  });

  it("reads as one member to everybody else, not a leave and a rejoin", async () => {
    // A handoff is not somebody leaving. Emitting `voice:left` would fire the
    // join and leave cues at the whole room for something that did not happen
    // to them.
    const owner = await bootstrapOwner(app);
    const other = await acceptInvite(app, owner.cookies, "Ece");
    const witness = await connect(other.cookies.voxly_session);
    const laptop = await connect(owner.cookies.voxly_session);
    const phoneToken = linkAnotherDevice(app, owner.user.id);
    await joinVoice(laptop, "lobby");
    await settle();

    const departures: string[] = [];
    witness.on("voice:left", (payload: { userId: string }) => departures.push(payload.userId));
    const phone = await connect(phoneToken);
    await joinVoice(phone, "lobby");
    await settle();

    assert.deepEqual(departures, []);
  });

  it("carries a reload on the same Device through unchanged", async () => {
    // A refresh is not a handoff: same session, same Device. It must not
    // announce a displacement to the Device that is doing the reloading.
    const owner = await bootstrapOwner(app);
    const first = await connect(owner.cookies.voxly_session);
    await joinVoice(first, "lobby");
    first.disconnect();
    await settle();

    const reloaded = await connect(owner.cookies.voxly_session);
    const displaced: VoiceForceLeaveReason[] = [];
    reloaded.on("voice:forceLeave", (payload: { reason: VoiceForceLeaveReason }) => displaced.push(payload.reason));
    const joined = await joinVoice(reloaded, "lobby");
    await settle();

    assert.equal(joined.ok, true);
    assert.deepEqual(displaced, []);
  });

  it("keeps an owner's mute across the handoff", async () => {
    // Moderation belongs to the account, not to a Device, and a member must not
    // be able to shed a mute by picking up their phone.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");
    app.sqlite
      .prepare("update server_members set moderator_muted = 1 where user_id = ?")
      .run(member.user.id);
    const laptop = await connect(member.cookies.voxly_session);
    await joinVoice(laptop, "lobby");
    const phoneToken = linkAnotherDevice(app, member.user.id);

    const phone = await connect(phoneToken);
    const joined = await joinVoice(phone, "lobby");

    assert.equal(joined.ok, true);
    assert.equal(joined.ok && joined.state.moderation.muted, true);
    assert.equal(joined.ok && joined.state.media.mic, false);
  });

  async function connect(sessionToken: string) {
    const socket = await connectSocket(baseUrl, sessionToken);
    sockets.push(socket);
    return socket;
  }
});

/** A second Device for an account that already has one; see `devices.test.ts`. */
function linkAnotherDevice(app: VoxlyApp, userId: string) {
  const token = createOpaqueToken();
  const now = new Date();
  app.sqlite
    .prepare("insert into sessions (id, token_hash, user_id, created_at, expires_at, label, last_seen_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run(
      crypto.randomUUID(),
      hashToken(token),
      userId,
      now.toISOString(),
      new Date(now.getTime() + 86_400_000).toISOString(),
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"),
      now.toISOString()
    );
  return token;
}

const joinMedia: VoiceMediaState = { mic: true, camera: false, screen: false, deafened: false, speaking: false };

function joinVoice(socket: Socket, roomId: string): Promise<VoiceJoinAck> {
  return new Promise((resolve) => {
    socket.emit("voice:join", { roomId, media: joinMedia }, (response: VoiceJoinAck) => resolve(response));
  });
}

function snapshotOf(socket: Socket, roomId: string): Promise<VoiceSnapshot> {
  return new Promise((resolve) => {
    socket.emit("voice:snapshot", roomId, (response: VoiceSnapshot) => resolve(response));
  });
}

function onceEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

/** Lets the emits above reach the server and come back before asserting. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 120));
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

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}

function connectSocket(baseUrl: string, sessionToken: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { cookie: `voxly_session=${sessionToken}` },
      reconnection: false
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (cause) => reject(new Error(`connect_error: ${cause.message}`)));
  });
}

/**
 * A live socket authenticates once, at handshake, and is bound to the session
 * *row* — not to the token value, which rotates under it every fifteen minutes
 * (ADR-0015).
 *
 * This is the invariant most likely to be broken by a well-meaning change:
 * anything that re-reads the token on a live socket would start tripping over
 * its own rotation, and would do it silently, hours into a call.
 */
describe("a live socket outlives the token that opened it", () => {
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

  it("keeps the call alive across a rotation", async () => {
    const owner = await bootstrapOwner(app);
    const socket = await connectSocket(baseUrl, owner.cookies.voxly_session);
    sockets.push(socket);
    await joinVoice(socket, "lobby");

    // Age the value and make an ordinary HTTP request, which is what rotates it.
    app.sqlite
      .prepare("update sessions set token_issued_at = ?")
      .run(new Date(Date.now() - 16 * 60 * 1000).toISOString());
    const rotated = await app.server.inject({ method: "GET", url: "/api/me", cookies: owner.cookies });
    assert.ok(rotated.cookies.length > 0, "the token did not rotate, so this proves nothing");
    await settle();

    const snapshot = await snapshotOf(socket, "lobby");
    assert.equal(snapshot.members.length, 1, "rotation dropped a live socket out of its call");
    assert.equal(socket.connected, true);
  });
});
