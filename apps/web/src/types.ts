import type { AfkTimeoutMinutes } from "@voxly/shared";
import type { CategorySummary, ChatMessage, PresenceUser, PublicUser, RoomSummary, VoiceModerationState } from "@voxly/shared";
import type { AnalyticsSettings } from "./lib/analytics.js";

export type { CategorySummary, ChatMessage, PresenceUser, PublicUser, RoomSummary };

export interface CurrentUserResponse {
  user: PublicUser;
}

export interface RoomsResponse {
  rooms: RoomSummary[];
  categories: CategorySummary[];
  uncategorizedPosition: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  role: "owner" | "member";
  /** True for owners and for members the owner granted invite rights to. */
  canInvite: boolean;
  /** Owner-set idle window before a member is parked in the AFK room. */
  afkTimeoutMinutes: AfkTimeoutMinutes;
}

export interface ServersResponse {
  servers: ServerSummary[];
}

export interface ServerMember {
  id: string;
  nickname: string;
  role: "owner" | "member";
  canInvite: boolean;
  /** A service account rather than a person; see the shared `PresenceUser`. */
  isBot: boolean;
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
  /** Hashed entry script served by this deployment; null in API-only development. */
  clientVersion: string | null;
  publicUrl: string | null;
  turnstile: {
    siteKey: string;
  } | null;
  /** Null unless the deployment opted into landing-page analytics. */
  analytics: AnalyticsSettings | null;
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

export interface AccountDeletionRequest {
  id: string;
  status: "pending" | "cancelled" | "rejected" | "approved";
  requestedAt: string;
  resolvedAt: string | null;
}

export interface OwnerAccountMembership {
  serverId: string;
  serverName: string;
  nickname: string;
  role: "owner" | "member";
  state: "active" | "banned" | "removed";
}

export interface OwnerDeletionRequest {
  id: string;
  userId: string;
  nickname: string;
  status: "active" | "banned";
  requestedAt: string;
  memberships: OwnerAccountMembership[];
}

export interface OwnerAccount {
  id: string;
  nickname: string;
  role: "owner" | "member";
  bannedAt: string | null;
  isBot: boolean;
  deletedAt: string | null;
  serverCount: number;
}
