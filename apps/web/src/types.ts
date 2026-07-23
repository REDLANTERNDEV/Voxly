import type { ChatMessage, PresenceUser, PublicUser, RoomSummary, VoiceModerationState } from "@voxly/shared";

export type { ChatMessage, PresenceUser, PublicUser, RoomSummary };

export interface CurrentUserResponse {
  user: PublicUser;
}

export interface RoomsResponse {
  rooms: RoomSummary[];
}

export interface ServerSummary {
  id: string;
  name: string;
  role: "owner" | "member";
}

export interface ServersResponse {
  servers: ServerSummary[];
}

export interface ServerMember {
  id: string;
  nickname: string;
  role: "owner" | "member";
  bannedAt: string | null;
  removedAt: string | null;
  joinedAt: string;
  moderation: VoiceModerationState;
}

export type InviteExpiryMinutes = 30 | 60 | 360 | 720 | 1440 | 10080 | 43200 | null;
export type InviteMaxUses = 1 | 5 | 10 | 25 | 50 | 100 | null;

export interface MessagesResponse {
  messages: ChatMessage[];
}

export interface MessageResponse {
  message: ChatMessage;
}

export interface AppConfigResponse {
  publicUrl: string | null;
  turnstile: {
    siteKey: string;
  } | null;
}

export interface RtcConfigResponse {
  iceServers: RTCIceServer[];
  expiresAt: number | null;
}

export interface InviteResponse {
  invite: {
    id: string;
    serverId: string;
    token: string;
    label: string;
    expiresAt: string | null;
    maxUses: InviteMaxUses;
    usedCount: number;
  };
}

export interface OwnerInvite {
  id: string;
  serverId: string;
  label: string;
  createdByUserId: string;
  usedByUserId: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  maxUses: InviteMaxUses;
  usedCount: number;
  createdAt: string;
}

export interface OwnerSession {
  id: string;
  userId: string;
  nickname: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
