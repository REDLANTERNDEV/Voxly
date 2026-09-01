/**
 * Voice room membership, the media rules that govern it, and the WebRTC
 * signalling that connects the members to each other.
 *
 * Voice state is deliberately in-memory and never persisted: it describes who
 * is connected right now, so a restart legitimately empties it. That makes this
 * module the single owner of two maps — who is in which voice room, and who is
 * subscribed to whose camera or screen — and every rule that has to stay
 * consistent with them: media normalisation, snapshot audience scoping, the
 * visual publisher limit, force-leave, room teardown, and signal forwarding.
 *
 * Keeping them together matters because they are mutually dependent. Leaving a
 * room has to drop subscriptions in both directions; turning a camera off has
 * to drop the subscriptions that pointed at it; forwarding a signal is only
 * allowed between two members of the same room. Splitting those across call
 * sites is how one of them gets missed.
 */

import { z } from "zod";
import type {
  PresenceUser,
  RtcSignalAck,
  VisualMediaKind,
  VisualTarget,
  VoiceForceLeaveReason,
  VoiceJoinRequest,
  VoiceMediaState,
  VoiceMemberState,
  VoiceModerationState,
  VoiceSetVisualSubscriptionsAck,
  VoiceSnapshot
} from "@voxly/shared";
import type { VoxlyDatabase } from "./db/database.js";
import {
  activeServerMembership,
  hasActiveServerMembership,
  serverPresenceUser,
  type ServerMemberRow
} from "./members.js";
import { roomById } from "./rooms.js";
import {
  callAck,
  roomIdPayloadSchema,
  safeSocketHandler,
  socketsForSession,
  socketsForUser,
  type VoxlyIoServer,
  type VoxlySocket
} from "./socket.js";

/** Members of one voice room, keyed by user id. */
export type VoiceRoomMembership = Map<string, VoiceMemberState>;
/** Viewer user id to publisher user id to the kinds that viewer subscribes to. */
type VisualSubscriptions = Map<string, Map<string, Set<VisualMediaKind>>>;

const visualPublisherLimit = 3;

const visualSubscriptionsPayloadSchema = z.object({
  roomId: z.string().min(1),
  targets: z.array(z.object({
    publisherUserId: z.string().min(1),
    kind: z.enum(["camera", "screen"])
  }).strict()).max(6)
}).strict();

const setMediaStatePayloadSchema = z.object({
  roomId: z.string().min(1),
  media: z.object({
    mic: z.boolean(),
    camera: z.boolean(),
    screen: z.boolean(),
    deafened: z.boolean(),
    speaking: z.boolean()
  }).partial()
}).strict();

const rtcSignalPayloadSchema = z.object({
  roomId: z.string().min(1),
  toUserId: z.string().min(1),
  signal: z.record(z.string(), z.unknown())
}).strict();

/**
 * Everything a voice operation needs: the socket server it emits through, the
 * database it authorizes against, and the two live maps it owns.
 */
interface VoiceContext {
  io: VoxlyIoServer;
  database: VoxlyDatabase;
  membership: Map<string, VoiceRoomMembership>;
  subscriptions: Map<string, VisualSubscriptions>;
  /**
   * Which Device currently holds each member's call.
   *
   * Voice membership is keyed by account — one slot per member, everywhere —
   * so once a member can hold several Devices, something has to say *which* of
   * them the call belongs to. Without it two Devices signed in as one account
   * both answer every negotiation from every peer, which breaks the mesh for
   * everybody else in the room rather than just for the member who linked.
   *
   * A member is in at most one voice room globally, so this is keyed by user
   * rather than by room. See ADR-0014.
   */
  holders: Map<string, { roomId: string; sessionId: string }>;
}

/**
 * The operations the rest of the server performs on live voice state. Owner
 * moderation, room deletion, and membership changes all reach voice through
 * this surface rather than touching the maps themselves.
 */
export interface VoiceRealtime {
  /** Attach the voice and RTC signalling handlers to a newly connected socket. */
  registerHandlers: (socket: VoxlySocket, user: PresenceUser) => void;
  /**
   * Whether this user is currently in this voice room. Exposed because being in
   * the room is a permission elsewhere — it is what entitles a member to summon
   * the Music bot — and that answer must come from the live map rather than
   * from a caller's own copy of it.
   */
  isVoiceMember: (roomId: string, userId: string) => boolean;
  /** Drop the voice membership a disconnecting socket still holds. */
  leaveAllRooms: (socket: VoxlySocket, userId: string) => void;
  /** Owner-initiated disconnect of one member from one voice room. */
  disconnectMember: (serverId: string, roomId: string, userId: string) => boolean;
  /** Owner-initiated move of one member to another voice room in the same server. */
  moveMember: (serverId: string, userId: string, targetRoomId: string) => boolean;
  /**
   * Evict a user from voice, everywhere by default or from one server's rooms
   * when `serverId` is given — a global ban reaches all of them, a kick or a
   * server ban only that server's.
   */
  forceLeave: (userId: string, reason: VoiceForceLeaveReason, serverId?: string) => void;
  /** Tear a voice room down and evict everyone in it. */
  deleteRoom: (roomId: string, reason: "room_deleted" | "server_deleted") => void;
  /** Republish live snapshots after a member's identity changed. */
  refreshMemberIdentity: (serverId: string, userId: string, user: PresenceUser) => void;
  /** Reapply owner mute/deafen to the member's live media state. */
  updateModeration: (serverId: string, userId: string, moderation: VoiceModerationState) => void;
}

export function createVoiceRealtime(io: VoxlyIoServer, database: VoxlyDatabase): VoiceRealtime {
  const context: VoiceContext = {
    io,
    database,
    membership: new Map<string, VoiceRoomMembership>(),
    subscriptions: new Map<string, VisualSubscriptions>(),
    holders: new Map<string, { roomId: string; sessionId: string }>()
  };

  return {
    registerHandlers(socket, user) {
      registerVoiceHandlers(context, socket, user);
    },
    isVoiceMember(roomId, userId) {
      return context.membership.get(roomId)?.has(userId) === true;
    },
    leaveAllRooms(socket, userId) {
      // Only the Device holding the call may end it by going away. A laptop
      // that was displaced by a phone still has a socket, and closing that tab
      // must not hang up the call the phone is now on.
      const sessionId = typeof socket.data.sessionId === "string" ? socket.data.sessionId : "";
      const holder = context.holders.get(userId);
      if (holder && sessionId && holder.sessionId !== sessionId) {
        socket.leave(`voice:${holder.roomId}`);
        return;
      }
      for (const [roomId, members] of context.membership) {
        if (members.has(userId)) {
          leaveVoice(context, socket, roomId, userId);
        }
      }
    },
    disconnectMember(serverId, roomId, userId) {
      const room = roomById(database.sqlite, roomId);
      if (!room || room.serverId !== serverId || !context.membership.get(roomId)?.has(userId)) {
        return false;
      }
      leaveVoiceMember(context, roomId, userId);
      emitVoiceForceLeave(context, userId, roomId, "owner_disconnect");
      return true;
    },
    moveMember(serverId, userId, targetRoomId) {
      // The server cannot join on a member's behalf: the client owns the peer
      // connections and the capture. So the move is an instruction, and the
      // ordinary join path carries it out — including the AFK room's forced
      // mute and the automatic leave of the previous room.
      const currentRoomId = [...context.membership.entries()]
        .find(([roomId, members]) => members.has(userId) && roomById(database.sqlite, roomId)?.serverId === serverId)?.[0];
      if (!currentRoomId || currentRoomId === targetRoomId) return false;
      for (const socket of socketsForUser(io, userId)) {
        socket.emit("voice:moveTo", { roomId: targetRoomId });
      }
      return true;
    },
    forceLeave(userId, reason, serverId) {
      const rooms = serverId === undefined
        ? voiceRoomsOf(context, userId)
        : serverVoiceRoomsOf(context, serverId, userId);
      for (const { roomId } of rooms) {
        leaveVoiceMember(context, roomId, userId);
        emitVoiceForceLeave(context, userId, roomId, reason);
      }
    },
    deleteRoom(roomId, reason) {
      const memberUserIds = new Set(context.membership.get(roomId)?.keys() ?? []);
      context.membership.delete(roomId);
      context.subscriptions.delete(roomId);
      for (const socket of io.sockets.sockets.values()) {
        const socketUser = socket.data.user as PresenceUser | undefined;
        socket.leave(`voice:${roomId}`);
        if (socketUser && memberUserIds.has(socketUser.userId)) {
          socket.emit("voice:forceLeave", { roomId, reason });
        }
      }
    },
    refreshMemberIdentity(serverId, userId, user) {
      for (const { roomId, members, current } of serverVoiceRoomsOf(context, serverId, userId)) {
        members.set(userId, { ...current, user });
        emitVoiceSnapshot(context, roomId, members);
      }
    },
    updateModeration(serverId, userId, moderation) {
      for (const { roomId, room, members, current } of serverVoiceRoomsOf(context, serverId, userId)) {
        const media = normalizeVoiceMedia(current.media, moderation, room);
        members.set(userId, { ...current, media, moderation });
        emitVoiceSnapshot(context, roomId, members);
      }
    }
  };
}

function registerVoiceHandlers(context: VoiceContext, socket: VoxlySocket, user: PresenceUser) {
  const { database } = context;

  socket.on("voice:join", safeSocketHandler("voice:join", (payload, ack) => {
    if (typeof ack !== "function") return;

    const candidate = payload as Partial<VoiceJoinRequest> | null;
    const roomId = typeof candidate?.roomId === "string" ? candidate.roomId : "";
    const room = roomById(database.sqlite, roomId);
    if (!room || room.kind !== "voice") {
      ack({ ok: false, error: "room_not_found" });
      return;
    }
    const membership = activeServerMembership(database.sqlite, room.serverId, user.userId);
    if (!membership) {
      ack({ ok: false, error: "forbidden" });
      return;
    }
    const roomUser = serverPresenceUser(database.sqlite, room.serverId, user.userId);
    if (!roomUser) {
      ack({ ok: false, error: "forbidden" });
      return;
    }

    const requested = candidate?.media as Partial<VoiceMediaState> | undefined;
    const moderation = voiceModeration(membership);
    const media = normalizeVoiceMedia({
      mic: requested?.mic === true,
      camera: requested?.camera === true,
      screen: requested?.screen === true,
      deafened: requested?.deafened === true,
      speaking: false
    }, moderation, room);
    const members = ensureVoiceRoom(context.membership, roomId);
    if (visualPublisherCount(members, user.userId, media) > visualPublisherLimit) {
      ack({ ok: false, error: "visual_limit_reached" });
      return;
    }

    // Voice follows the newest Device.
    //
    // Membership is keyed by account, so two Devices cannot both hold a call —
    // the second would overwrite the first's member state while the first kept
    // its peer connections and went on answering every negotiation. Rather than
    // let that happen, the Device that was holding it is told plainly that it
    // has been displaced, and stops.
    //
    // Only voice moves. The displaced Device keeps its session, its chat and
    // its presence; nothing about it is signed out.
    const sessionId = typeof socket.data.sessionId === "string" ? socket.data.sessionId : "";
    const holder = context.holders.get(user.userId);
    if (holder && holder.sessionId !== sessionId) {
      emitVoiceForceLeave(context, user.userId, holder.roomId, "joined_another_device", holder.sessionId);
    }

    // A user account is in at most one voice room globally, so joining leaves
    // whatever they were in before — including the subscriptions it carried.
    //
    // Deliberately only *other* rooms. Taking over a call in the room the
    // member is already in must not emit `voice:left` — to everybody else this
    // is one member throughout, not a member who left and came back, and a
    // leave would fire the join and leave cues at the whole room for something
    // that did not happen to them.
    for (const [activeRoomId, activeMembers] of context.membership) {
      if (activeRoomId !== roomId && activeMembers.has(user.userId)) {
        leaveVoiceMember(context, activeRoomId, user.userId);
      }
    }
    socket.join(`voice:${roomId}`);
    // Media and moderation are rebuilt from the request and the membership row
    // above, so the member arrives on the new Device muted if they were muted,
    // and stays muted if an owner muted them.
    const memberState: VoiceMemberState = { user: roomUser, media, moderation };
    members.set(user.userId, memberState);
    context.holders.set(user.userId, { roomId, sessionId });
    ack({ ok: true, state: memberState });
    emitVoiceSnapshot(context, roomId, members);
    socket.to(`server:${room.serverId}`).emit("voice:joined", { roomId, user: roomUser });
  }));

  socket.on("voice:leave", safeSocketHandler("voice:leave", (roomId) => {
    const parsed = roomIdPayloadSchema.safeParse(roomId);
    if (!parsed.success) return;
    // Only the Device holding the call may end it.
    //
    // A displaced Device answers `voice:forceLeave` by tearing down, and
    // tearing down emits this. Without the guard the laptop's own goodbye
    // would remove the account from the room the phone had just taken over —
    // the handoff would undo itself a moment after it succeeded.
    const sessionId = typeof socket.data.sessionId === "string" ? socket.data.sessionId : "";
    const holder = context.holders.get(user.userId);
    if (holder && sessionId && holder.sessionId !== sessionId) {
      socket.leave(`voice:${parsed.data}`);
      return;
    }
    leaveVoice(context, socket, parsed.data, user.userId);
  }));

  socket.on("voice:snapshot", safeSocketHandler("voice:snapshot", (roomId, ack) => {
    const parsed = roomIdPayloadSchema.safeParse(roomId);
    if (!parsed.success) {
      callAck(ack, { roomId: typeof roomId === "string" ? roomId : "", members: [] });
      return;
    }
    const room = roomById(database.sqlite, parsed.data);
    if (!room || !hasActiveServerMembership(database.sqlite, room.serverId, user.userId)) {
      callAck(ack, { roomId: parsed.data, members: [] });
      return;
    }
    callAck(ack, voiceSnapshot(parsed.data, context.membership.get(parsed.data), socket.rooms.has(`voice:${parsed.data}`)));
  }));

  socket.on("voice:setMediaState", safeSocketHandler("voice:setMediaState", (payload, ack) => {
    const parsed = setMediaStatePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      callAck(ack, { ok: false, error: "room_not_found" });
      return;
    }
    const room = roomById(database.sqlite, parsed.data.roomId);
    if (!room || room.kind !== "voice") {
      callAck(ack, { ok: false, error: "room_not_found" });
      return;
    }
    const members = context.membership.get(parsed.data.roomId);
    const current = members?.get(user.userId);
    if (!members || !current) {
      callAck(ack, { ok: false, error: "not_in_voice_room" });
      return;
    }
    const membership = activeServerMembership(database.sqlite, room.serverId, user.userId);
    if (!membership) {
      callAck(ack, { ok: false, error: "not_in_voice_room" });
      return;
    }
    const moderation = voiceModeration(membership);
    const nextMedia = normalizeVoiceMedia({ ...current.media, ...parsed.data.media }, moderation, room);
    if (visualPublisherCount(members, user.userId, nextMedia) > visualPublisherLimit) {
      callAck(ack, { ok: false, error: "visual_limit_reached" });
      return;
    }
    const nextState = { ...current, media: nextMedia, moderation };
    members.set(user.userId, nextState);
    clearUnavailableVisualSubscriptions(context, parsed.data.roomId, user.userId, nextMedia);
    emitVoiceSnapshot(context, parsed.data.roomId, members);
    callAck(ack, { ok: true, state: nextState });
  }));

  socket.on("voice:setVisualSubscriptions", safeSocketHandler("voice:setVisualSubscriptions", (payload, ack) => {
    const parsed = visualSubscriptionsPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      callAck(ack, { ok: false, error: "invalid_payload" });
      return;
    }
    callAck(ack, setVisualSubscriptions(context, user.userId, parsed.data));
  }));

  socket.on("rtc:signal", safeSocketHandler("rtc:signal", (payload, ack) => {
    const parsed = rtcSignalPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      callAck(ack, { ok: false, error: "room_not_found" });
      return;
    }
    callAck(ack, forwardRtcSignal(context, user.userId, parsed.data));
  }));
}

/**
 * Every voice room the user currently holds.
 *
 * Deliberately does not require the room's row to still exist: a member left
 * behind in a room whose row has gone must still be evictable.
 */
function* voiceRoomsOf(context: VoiceContext, userId: string) {
  for (const [roomId, members] of context.membership) {
    const current = members.get(userId);
    if (current) yield { roomId, members, current };
  }
}

/**
 * The same walk narrowed to one server. Answering that needs the room row, so
 * callers get it back — `updateModeration` needs it for the AFK rule.
 */
function* serverVoiceRoomsOf(context: VoiceContext, serverId: string, userId: string) {
  for (const entry of voiceRoomsOf(context, userId)) {
    const room = roomById(context.database.sqlite, entry.roomId);
    if (room && room.serverId === serverId) yield { ...entry, room };
  }
}

/**
 * `sessionId` narrows this to one Device. Every other reason concerns the
 * account and reaches all of them; a handoff concerns exactly the Device being
 * displaced, and telling the Device that just *took* the call that it has been
 * removed from it would undo the handoff it just performed.
 */
function emitVoiceForceLeave(
  context: VoiceContext,
  userId: string,
  roomId: string,
  reason: VoiceForceLeaveReason,
  sessionId?: string
) {
  const sockets = sessionId
    ? socketsForSession(context.io, userId, sessionId)
    : socketsForUser(context.io, userId);
  for (const socket of sockets) {
    // Leaving the Socket.IO room is what actually stops signalling reaching
    // this Device: `forwardRtcSignal` addresses whoever is in `voice:<room>`.
    socket.leave(`voice:${roomId}`);
    socket.emit("voice:forceLeave", { roomId, reason });
  }
}

function leaveVoice(context: VoiceContext, socket: VoxlySocket, roomId: string, userId: string) {
  socket.leave(`voice:${roomId}`);
  leaveVoiceMember(context, roomId, userId);
}

function leaveVoiceMember(context: VoiceContext, roomId: string, userId: string) {
  const members = context.membership.get(roomId);
  if (!members?.has(userId)) return;
  if (context.holders.get(userId)?.roomId === roomId) context.holders.delete(userId);
  clearViewerVisualSubscriptions(context, roomId, userId);
  clearPublisherVisualSubscriptions(context, roomId, userId);
  members.delete(userId);
  if (members.size === 0) {
    context.membership.delete(roomId);
  }
  for (const candidate of socketsForUser(context.io, userId)) {
    candidate.leave(`voice:${roomId}`);
  }
  const room = roomById(context.database.sqlite, roomId);
  if (!room) return;
  emitVoiceSnapshot(context, roomId, members);
  context.io.to(`server:${room.serverId}`).emit("voice:left", { roomId, userId });
}

/**
 * Full speaking state is private to the voice room. Everyone else in the server
 * sees who is present with `speaking` flattened to false, so idle presence
 * never discloses another room's live activity.
 */
function emitVoiceSnapshot(context: VoiceContext, roomId: string, members: VoiceRoomMembership | undefined) {
  const room = roomById(context.database.sqlite, roomId);
  if (!room) return;
  const voiceRoom = `voice:${roomId}`;
  context.io.to(voiceRoom).emit("voice:snapshot", voiceSnapshot(roomId, members, true));
  context.io.to(`server:${room.serverId}`).except(voiceRoom).emit("voice:snapshot", voiceSnapshot(roomId, members, false));
}

function setVisualSubscriptions(
  context: VoiceContext,
  viewerUserId: string,
  payload: { roomId: string; targets: VisualTarget[] }
): VoiceSetVisualSubscriptionsAck {
  const room = roomById(context.database.sqlite, payload.roomId);
  if (!room || room.kind !== "voice") {
    return { ok: false, error: "room_not_found" };
  }
  const members = context.membership.get(payload.roomId);
  if (!members?.has(viewerUserId)) {
    return { ok: false, error: "not_in_voice_room" };
  }

  const targets = uniqueVisualTargets(payload.targets);
  for (const target of targets) {
    const publisher = members.get(target.publisherUserId);
    if (!publisher || target.publisherUserId === viewerUserId) {
      return { ok: false, error: "target_not_in_voice_room" };
    }
    if (!publisher.media[target.kind]) {
      return { ok: false, error: "target_visual_unavailable" };
    }
  }

  const roomSubscriptions = context.subscriptions.get(payload.roomId) ?? new Map<string, Map<string, Set<VisualMediaKind>>>();
  const previous = roomSubscriptions.get(viewerUserId) ?? new Map<string, Set<VisualMediaKind>>();
  const next = new Map<string, Set<VisualMediaKind>>();
  for (const target of targets) {
    const kinds = next.get(target.publisherUserId) ?? new Set<VisualMediaKind>();
    kinds.add(target.kind);
    next.set(target.publisherUserId, kinds);
  }

  const publishers = new Set([...previous.keys(), ...next.keys()]);
  for (const publisherUserId of publishers) {
    const previousKinds = previous.get(publisherUserId) ?? new Set<VisualMediaKind>();
    const nextKinds = next.get(publisherUserId) ?? new Set<VisualMediaKind>();
    if (!sameVisualKinds(previousKinds, nextKinds) || nextKinds.size > 0) {
      emitVisualSubscriberState(context, payload.roomId, publisherUserId, viewerUserId, [...nextKinds]);
    }
  }

  if (next.size === 0) {
    roomSubscriptions.delete(viewerUserId);
  } else {
    roomSubscriptions.set(viewerUserId, next);
  }
  if (roomSubscriptions.size === 0) {
    context.subscriptions.delete(payload.roomId);
  } else {
    context.subscriptions.set(payload.roomId, roomSubscriptions);
  }

  return { ok: true, targets };
}

/**
 * A publisher who stops a camera or screen must not leave viewers subscribed to
 * a track that no longer exists.
 */
function clearUnavailableVisualSubscriptions(
  context: VoiceContext,
  roomId: string,
  publisherUserId: string,
  media: VoiceMediaState
) {
  const roomSubscriptions = context.subscriptions.get(roomId);
  if (!roomSubscriptions) return;

  for (const [viewerUserId, subscriptions] of roomSubscriptions) {
    const currentKinds = subscriptions.get(publisherUserId);
    if (!currentKinds) continue;
    const nextKinds = new Set([...currentKinds].filter((kind) => media[kind]));
    if (sameVisualKinds(currentKinds, nextKinds)) continue;
    if (nextKinds.size === 0) {
      subscriptions.delete(publisherUserId);
    } else {
      subscriptions.set(publisherUserId, nextKinds);
    }
    emitVisualSubscriberState(context, roomId, publisherUserId, viewerUserId, [...nextKinds]);
  }

  cleanupVisualSubscriptions(context, roomId);
}

function clearViewerVisualSubscriptions(context: VoiceContext, roomId: string, viewerUserId: string) {
  const roomSubscriptions = context.subscriptions.get(roomId);
  const subscriptions = roomSubscriptions?.get(viewerUserId);
  if (!roomSubscriptions || !subscriptions) return;
  for (const publisherUserId of subscriptions.keys()) {
    emitVisualSubscriberState(context, roomId, publisherUserId, viewerUserId, []);
  }
  roomSubscriptions.delete(viewerUserId);
  cleanupVisualSubscriptions(context, roomId);
}

function clearPublisherVisualSubscriptions(context: VoiceContext, roomId: string, publisherUserId: string) {
  const roomSubscriptions = context.subscriptions.get(roomId);
  if (!roomSubscriptions) return;
  for (const subscriptions of roomSubscriptions.values()) {
    subscriptions.delete(publisherUserId);
  }
  cleanupVisualSubscriptions(context, roomId);
}

function cleanupVisualSubscriptions(context: VoiceContext, roomId: string) {
  const roomSubscriptions = context.subscriptions.get(roomId);
  if (!roomSubscriptions) return;
  for (const [viewerUserId, subscriptions] of roomSubscriptions) {
    if (subscriptions.size === 0) roomSubscriptions.delete(viewerUserId);
  }
  if (roomSubscriptions.size === 0) context.subscriptions.delete(roomId);
}

function emitVisualSubscriberState(
  context: VoiceContext,
  roomId: string,
  publisherUserId: string,
  viewerUserId: string,
  subscribedKinds: VisualMediaKind[]
) {
  for (const socket of socketsForUser(context.io, publisherUserId)) {
    if (socket.rooms.has(`voice:${roomId}`)) {
      socket.emit("voice:visualSubscriberState", { roomId, viewerUserId, subscribedKinds });
    }
  }
}

/**
 * Signalling is forwarded only between two active members of the same voice
 * room, so a socket cannot use it to reach a peer it could not otherwise see.
 */
function forwardRtcSignal(
  context: VoiceContext,
  fromUserId: string,
  payload: { roomId: string; toUserId: string; signal: Record<string, unknown> }
): RtcSignalAck {
  const room = roomById(context.database.sqlite, payload.roomId);
  if (!room || room.kind !== "voice") {
    return { ok: false, error: "room_not_found" };
  }
  const members = context.membership.get(payload.roomId);
  if (!members?.has(fromUserId)) {
    return { ok: false, error: "not_in_voice_room" };
  }
  if (!members.has(payload.toUserId)) {
    return { ok: false, error: "target_not_in_voice_room" };
  }
  for (const socket of socketsForUser(context.io, payload.toUserId)) {
    if (socket.rooms.has(`voice:${payload.roomId}`)) {
      socket.emit("rtc:signal", {
        roomId: payload.roomId,
        fromUserId,
        signal: payload.signal
      });
    }
  }
  return { ok: true };
}

function ensureVoiceRoom(voiceMembership: Map<string, VoiceRoomMembership>, roomId: string) {
  let members = voiceMembership.get(roomId);
  if (!members) {
    members = new Map();
    voiceMembership.set(roomId, members);
  }
  return members;
}

export function voiceModeration(membership: ServerMemberRow): VoiceModerationState {
  return {
    muted: Boolean(membership.moderator_muted),
    deafened: Boolean(membership.moderator_deafened)
  };
}

export function voiceSnapshot(roomId: string, members: VoiceRoomMembership | undefined, includeSpeaking: boolean): VoiceSnapshot {
  return {
    roomId,
    members: members
      ? [...members.values()].map((member) => includeSpeaking
        ? member
        : { ...member, media: { ...member.media, speaking: false } })
      : []
  };
}

/**
 * `room` carries the room-level rules. Enforcement lives here rather than at
 * each call site so join, later media changes, and moderation recalculation all
 * apply the same constraints; an unmute request that reached only one of those
 * paths would let the microphone back on.
 */
export function normalizeVoiceMedia(
  media: VoiceMediaState,
  moderation: VoiceModerationState = { muted: false, deafened: false },
  room: { isAfk: boolean } = { isAfk: false }
): VoiceMediaState {
  const next = {
    mic: Boolean(media.mic),
    camera: Boolean(media.camera),
    screen: Boolean(media.screen),
    deafened: Boolean(media.deafened),
    speaking: Boolean(media.speaking)
  };

  if (next.deafened) {
    next.mic = false;
  }

  if (moderation.muted) {
    next.mic = false;
  }

  // The AFK room mutes everyone in it, and the mute cannot be lifted from
  // inside. It is a property of the room rather than of the member: nobody in
  // there is present, so nothing they transmit is wanted, and unlike owner
  // moderation it applies to owners too. Leaving the room is how you get your
  // microphone back.
  if (room.isAfk) {
    next.mic = false;
  }

  if (!next.mic || next.deafened || moderation.muted) {
    next.speaking = false;
  }

  return next;
}

function visualPublisherCount(
  members: VoiceRoomMembership,
  currentUserId: string,
  nextCurrentMedia: VoiceMediaState
) {
  let count = nextCurrentMedia.camera || nextCurrentMedia.screen ? 1 : 0;
  for (const [userId, member] of members) {
    if (userId === currentUserId) {
      continue;
    }
    if (member.media.camera || member.media.screen) {
      count += 1;
    }
  }
  return count;
}

function uniqueVisualTargets(targets: VisualTarget[]) {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.publisherUserId}:${target.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameVisualKinds(left: Set<VisualMediaKind>, right: Set<VisualMediaKind>) {
  return left.size === right.size && [...left].every((kind) => right.has(kind));
}
