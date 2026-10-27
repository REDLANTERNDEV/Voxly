import type { AfkTimeoutMinutes } from "@voxly/shared";
import type {
  CategorySummary,
  ChatMessage,
  PresenceUser,
  PublicUser,
  RoomSummary,
  VoiceModerationState
} from "@voxly/shared";
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
  /** Whether invite joins post a Welcome notice, and the owner's channel for it. */
  welcomeNotices: boolean;
  welcomeRoomId: string | null;
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
  readThroughSequence: number;
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

/** A person in the Invite trail; a Deleted account has neither name nor code (ADR-0034). */
export interface InviteTrailPerson {
  userId: string;
  nickname: string | null;
  mentionCode: string | null;
  state: "active" | "kicked" | "banned" | "deleted";
}

export interface InviteUse extends InviteTrailPerson {
  joinedAt: string;
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
  createdBy: InviteTrailPerson;
  /** Everyone who joined through it, newest first. */
  uses: InviteUse[];
  /** When it stopped admitting anyone; null while it still does. */
  inactiveSince: string | null;
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
  /** Only in an Account's details: the Invite this Membership joined through, or null for none on record. */
  invite?: { inviteId: string; label: string; joinedAt: string; inviter: InviteTrailPerson } | null;
}

/** People one Account's Invites brought into one Server, newest first. */
export interface OwnerInvitedGroup {
  serverId: string;
  serverName: string;
  people: Array<InviteUse & { inviteId: string; inviteLabel: string }>;
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
