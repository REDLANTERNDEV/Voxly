import type {
  AppConfigResponse,
  CurrentUserResponse,
  InviteResponse,
  MessageResponse,
  MessagesResponse,
  OwnerInvite,
  OwnerSession,
  PublicUser,
  RoomsResponse
} from "./types.js";

type JsonBody = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
  }
}

const ownerClaimRequests = new Map<string, Promise<CurrentUserResponse>>();

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function apiPost<T>(path: string, body?: JsonBody): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function fetchMe() {
  return apiGet<CurrentUserResponse>("/api/me");
}

export async function fetchConfig() {
  return apiGet<AppConfigResponse>("/api/config");
}

export async function fetchRooms() {
  return apiGet<RoomsResponse>("/api/rooms");
}

export async function fetchMessages(roomId: string, limit = 100) {
  return apiGet<MessagesResponse>(`/api/rooms/${roomId}/messages?limit=${encodeURIComponent(String(limit))}`);
}

export async function sendMessage(roomId: string, body: string) {
  return apiPost<MessageResponse>(`/api/rooms/${roomId}/messages`, { body });
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

export async function acceptInvite(inviteToken: string, nickname: string, turnstileToken?: string) {
  return apiPost<CurrentUserResponse>("/api/invites/accept", { inviteToken, nickname, turnstileToken });
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

export async function createInvite(label: string, expiresInHours: number) {
  return apiPost<InviteResponse>("/api/owner/invites", { label, expiresInHours });
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
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string") {
        code = body.error;
      }
    } catch {
      code = undefined;
    }
    throw new ApiError(response.status === 401 ? "Unauthorized" : "Request failed", response.status, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
