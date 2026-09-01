import type {
  AppConfigResponse,
  CurrentUserResponse,
  InviteResponse,
  InviteExpiryMinutes,
  InviteMaxUses,
  MessageResponse,
  MessagesResponse,
  OwnerInvite,
  OwnerSession,
  PresenceUser,
  PublicUser,
  RoomSummary,
  RoomsResponse,
  RtcConfigResponse,
  ServerMember,
  ServerSummary,
  ServersResponse
} from "./types.js";
import type { DeviceSummary, VoiceModerationState } from "@voxly/shared";

type JsonBody = Record<string, unknown>;
type AccessClaimResponse = CurrentUserResponse & { serverId: string };
type InviteAcceptResponse = CurrentUserResponse & { serverId: string };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly data?: Record<string, unknown>
  ) {
    super(message);
  }
}

const ownerClaimRequests = new Map<string, Promise<CurrentUserResponse>>();
const accessClaimRequests = new Map<string, Promise<AccessClaimResponse>>();

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function apiPost<T>(path: string, body?: JsonBody): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * The member's own Devices. Deliberately not the owner's session console, which
 * answers an operator's question about everybody; this one answers "what is
 * signed in as me, and how do I get rid of it?" (`devices.ts`).
 */
export async function fetchDevices() {
  return apiGet<{ devices: DeviceSummary[] }>("/api/devices");
}

export async function signOutDevice(deviceId: string) {
  await request<void>(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

/**
 * Linking a second Device. Four calls because there are four moments, and the
 * middle one is the point: claiming asks, and only approval on the Device that
 * minted the code turns that into a session (ADR-0014).
 */
export async function createDeviceLink() {
  return apiPost<{ code: string; expiresAt: string; expiresInSeconds: number; linkId: string }>("/api/devices/links");
}

/**
 * Retires one code by id, never "whatever is outstanding". A client that mints
 * twice in quick succession would otherwise have its live code killed by the
 * previous one's cleanup.
 */
export async function cancelDeviceLink(linkId: string) {
  await request<void>(`/api/devices/links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
}

export async function fetchWaitingDeviceLink() {
  return apiGet<{ waiting: { confirmation: string; label: string; expiresAt: string } | null }>(
    "/api/devices/links/waiting"
  );
}

export async function answerDeviceLink(approve: boolean) {
  return apiPost<{ ok: boolean }>("/api/devices/links/approve", { approve });
}

export async function claimDeviceLink(code: string, turnstileToken?: string) {
  return apiPost<{ claimToken: string; confirmation: string }>("/api/devices/links/claim", { code, turnstileToken });
}

export type DeviceLinkOutcome = "pending" | "approved" | "refused" | "expired";

export async function collectDeviceLink(claimToken: string) {
  return apiPost<{ status: DeviceLinkOutcome; user?: PublicUser }>("/api/devices/links/collect", { claimToken });
}

/**
 * The Recovery code. `present` never carries the value — it is shown once when
 * it is created and nothing can read it back, which is what stops every session
 * from being a way to steal it.
 */
export async function fetchRecoveryStatus() {
  return apiGet<{ present: boolean }>("/api/recovery");
}

export async function createRecoveryCode() {
  return apiPost<{ code: string; signedOutOthers: boolean }>("/api/recovery");
}

export async function redeemRecoveryCode(code: string, turnstileToken?: string) {
  return apiPost<{ user: PublicUser }>("/api/recovery/redeem", { code, turnstileToken });
}

export async function fetchMe() {
  return apiGet<CurrentUserResponse>("/api/me");
}

export async function fetchConfig() {
  return apiGet<AppConfigResponse>("/api/config");
}

export async function fetchRtcConfig() {
  return apiGet<RtcConfigResponse>("/api/rtc/config");
}

export async function fetchRooms() {
  return apiGet<RoomsResponse>("/api/rooms");
}

export async function fetchServers() {
  return apiGet<ServersResponse>("/api/servers");
}

export async function createServer(name: string) {
  return apiPost<{ server: ServerSummary }>("/api/servers", { name });
}

export async function updateServerAfkTimeout(serverId: string, afkTimeoutMinutes: number) {
  return request<{ afkTimeoutMinutes: number }>(`/api/servers/${encodeURIComponent(serverId)}/afk`, {
    method: "PATCH",
    body: JSON.stringify({ afkTimeoutMinutes })
  });
}

export async function updateServer(serverId: string, name: string) {
  return request<{ server: ServerSummary }>(`/api/servers/${encodeURIComponent(serverId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name })
  });
}

export async function fetchServerRooms(serverId: string) {
  return apiGet<RoomsResponse>(`/api/servers/${encodeURIComponent(serverId)}/rooms`);
}

export async function fetchServerDirectory(serverId: string) {
  return apiGet<{ members: PresenceUser[] }>(`/api/servers/${encodeURIComponent(serverId)}/directory`);
}

export async function createServerRoom(serverId: string, name: string, kind: "text" | "voice") {
  return apiPost<{ room: RoomSummary }>(`/api/servers/${encodeURIComponent(serverId)}/rooms`, { name, kind });
}

export async function deleteServerRoom(serverId: string, roomId: string) {
  await request<void>(`/api/servers/${encodeURIComponent(serverId)}/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE"
  });
}

export async function deleteServer(serverId: string) {
  await request<void>(`/api/servers/${encodeURIComponent(serverId)}`, { method: "DELETE" });
}

export async function fetchServerMembers(serverId: string) {
  return apiGet<{ members: ServerMember[] }>(`/api/servers/${encodeURIComponent(serverId)}/members`);
}

export async function fetchMessages(roomId: string, limit = 100) {
  return apiGet<MessagesResponse>(`/api/rooms/${roomId}/messages?limit=${encodeURIComponent(String(limit))}`);
}

export async function sendMessage(roomId: string, body: string, replyToMessageId?: string | null) {
  return apiPost<MessageResponse>(`/api/rooms/${roomId}/messages`, replyToMessageId
    ? { body, replyToMessageId }
    : { body });
}

export async function updateMessage(roomId: string, messageId: string, body: string) {
  return request<MessageResponse>(`/api/rooms/${roomId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ body })
  });
}

export async function deleteMessage(roomId: string, messageId: string) {
  await request<void>(`/api/rooms/${roomId}/messages/${messageId}`, {
    method: "DELETE"
  });
}

export async function suppressMessageEmbed(roomId: string, messageId: string, embedKey: string) {
  return request<MessageResponse>(`/api/rooms/${roomId}/messages/${messageId}/embeds`, {
    method: "PATCH",
    body: JSON.stringify({ embedKey })
  });
}

export async function acceptInvite(inviteToken: string, nickname: string, turnstileToken?: string) {
  return apiPost<InviteAcceptResponse>("/api/invites/accept", { inviteToken, nickname: nickname || undefined, turnstileToken });
}

export async function previewInvite(inviteToken: string) {
  return apiPost<{ serverName: string; expiresAt: string | null; remainingUses: number | null }>("/api/invites/preview", { inviteToken });
}

export function claimAccessLink(token: string) {
  const existingRequest = accessClaimRequests.get(token);
  if (existingRequest) {
    return existingRequest;
  }

  const requestPromise = apiPost<AccessClaimResponse>("/api/access/claim", { token }).catch((error: unknown) => {
    accessClaimRequests.delete(token);
    throw error;
  });
  accessClaimRequests.set(token, requestPromise);
  return requestPromise;
}

export async function claimOwnerSession(claimToken: string) {
  const existingRequest = ownerClaimRequests.get(claimToken);
  if (existingRequest) {
    return existingRequest;
  }

  const requestPromise = apiPost<CurrentUserResponse>("/api/setup/owner/claim", { claimToken }).catch((error: unknown) => {
    ownerClaimRequests.delete(claimToken);
    throw error;
  });
  ownerClaimRequests.set(claimToken, requestPromise);
  return requestPromise;
}

export async function logout() {
  await apiPost<void>("/api/logout");
}

export async function createInvite(label: string, expiresInMinutes: InviteExpiryMinutes, maxUses: InviteMaxUses) {
  return apiPost<InviteResponse>("/api/owner/invites", { label, expiresInMinutes, maxUses });
}

export async function createServerInvite(serverId: string, label: string, expiresInMinutes: InviteExpiryMinutes, maxUses: InviteMaxUses) {
  return apiPost<InviteResponse>(`/api/servers/${encodeURIComponent(serverId)}/invites`, { label, expiresInMinutes, maxUses });
}

export async function revokeServerInvite(serverId: string, inviteId: string) {
  await apiPost<void>(`/api/servers/${encodeURIComponent(serverId)}/invites/${encodeURIComponent(inviteId)}/revoke`);
}

export async function fetchServerOwnerData(serverId: string) {
  const [members, invites] = await Promise.all([
    fetchServerMembers(serverId),
    apiGet<{ invites: OwnerInvite[] }>(`/api/servers/${encodeURIComponent(serverId)}/invites`)
  ]);
  return { users: members.members, invites: invites.invites };
}

export async function fetchOwnerData() {
  const [users, invites, sessions] = await Promise.all([
    apiGet<{ users: PublicUser[] }>("/api/owner/users"),
    apiGet<{ invites: OwnerInvite[] }>("/api/owner/invites"),
    apiGet<{ sessions: OwnerSession[] }>("/api/owner/sessions")
  ]);

  return { users: users.users, invites: invites.invites, sessions: sessions.sessions };
}

export async function banUser(userId: string) {
  await apiPost<void>(`/api/owner/users/${userId}/ban`);
}

export async function moderateServerMember(serverId: string, userId: string, action: "ban" | "unban" | "kick") {
  await apiPost<void>(`/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/${action}`);
}

export async function updateServerMemberNickname(serverId: string, userId: string, nickname: string) {
  return request<{ user: PresenceUser }>(
    `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/nickname`,
    {
      method: "PATCH",
      body: JSON.stringify({ nickname })
    }
  );
}

export async function updateServerMemberPermissions(serverId: string, userId: string, canInvite: boolean) {
  return request<{ user: PresenceUser }>(
    `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/permissions`,
    {
      method: "PATCH",
      body: JSON.stringify({ canInvite })
    }
  );
}

export async function updateVoiceModeration(
  serverId: string,
  userId: string,
  moderation: Partial<VoiceModerationState>
) {
  return request<{ moderation: VoiceModerationState }>(
    `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/voice-moderation`,
    {
      method: "PATCH",
      body: JSON.stringify(moderation)
    }
  );
}

export async function createAccessLink(serverId: string, userId: string) {
  return apiPost<{ token: string; expiresAt: string }>(
    `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/access-links`
  );
}

export async function disconnectVoiceMember(serverId: string, roomId: string, userId: string) {
  await apiPost<void>(
    `/api/servers/${encodeURIComponent(serverId)}/voice/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}/disconnect`
  );
}

export async function moveVoiceMember(serverId: string, userId: string, roomId: string) {
  await apiPost<void>(
    `/api/servers/${encodeURIComponent(serverId)}/voice/members/${encodeURIComponent(userId)}/move`,
    { roomId }
  );
}

export async function revokeSession(sessionId: string) {
  await apiPost<void>(`/api/owner/sessions/${sessionId}/revoke`);
}

export async function revokeInvite(inviteId: string) {
  await apiPost<void>(`/api/owner/invites/${inviteId}/revoke`);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    let code: string | undefined;
    let data: Record<string, unknown> | undefined;
    try {
      const body = await response.json() as Record<string, unknown>;
      data = body;
      if (typeof body.error === "string") {
        code = body.error;
      }
    } catch {
      code = undefined;
    }
    throw new ApiError(response.status === 401 ? "Unauthorized" : "Request failed", response.status, code, data);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
