import type { ChatMessage, PresenceUser, PublicUser, RoomSummary } from "@voxly/shared";

export type { ChatMessage, PresenceUser, PublicUser, RoomSummary };

export interface CurrentUserResponse {
  user: PublicUser;
}

export interface RoomsResponse {
  rooms: RoomSummary[];
}

export interface MessagesResponse {
  messages: ChatMessage[];
}

export interface MessageResponse {
  message: ChatMessage;
}

export interface AppConfigResponse {
  publicUrl: string | null;
  rtc: {
    iceServers: RTCIceServer[];
  };
  turnstile: {
    siteKey: string;
  } | null;
}

export interface InviteResponse {
  invite: {
    id: string;
    token: string;
    label: string;
    expiresAt: string | null;
  };
}

export interface OwnerInvite {
  id: string;
  label: string;
  createdByUserId: string;
  usedByUserId: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
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
