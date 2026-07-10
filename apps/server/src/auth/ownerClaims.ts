import { createOpaqueToken, hashToken } from "./tokens.js";
import { all, one, openDatabase, run, type VoxlyDatabase } from "../db/database.js";

export type OwnerSetupErrorCode = "owner_exists" | "owner_missing" | "invalid_nickname";

export class OwnerSetupError extends Error {
  constructor(readonly code: OwnerSetupErrorCode, message: string) {
    super(message);
  }
}

interface CreateOwnerClaimInput {
  databasePath: string;
  nickname: string;
  baseUrl: string;
  expiresInMinutes?: number;
}

interface CreateOwnerLoginClaimInput {
  databasePath: string;
  baseUrl: string;
  nickname?: string;
  expiresInMinutes?: number;
}

interface CreateOwnerClaimInDatabaseInput {
  nickname: string;
  baseUrl: string;
  expiresInMinutes?: number;
  now?: Date;
}

interface OwnerClaimRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  expires_at: string;
  consumed_at: string | null;
  nickname: string;
  role: "owner";
  banned_at: string | null;
}

interface OwnerUserRow extends Record<string, unknown> {
  id: string;
  nickname: string;
  role: "owner";
  banned_at: string | null;
}

export interface OwnerClaimResult {
  token: string;
  url: string;
  expiresAt: string;
  user: {
    id: string;
    nickname: string;
    role: "owner";
    bannedAt: null;
  };
}

export async function createOwnerClaim(input: CreateOwnerClaimInput): Promise<OwnerClaimResult> {
  const database = await openDatabase(input.databasePath);
  try {
    return createOwnerClaimInDatabase(database, input);
  } finally {
    database.close();
  }
}

export async function createOwnerLoginClaim(input: CreateOwnerLoginClaimInput): Promise<OwnerClaimResult> {
  const database = await openDatabase(input.databasePath);
  try {
    const user = findOwnerForLoginClaim(database, input.nickname);
    return createClaimForOwner(database, {
      user,
      baseUrl: input.baseUrl,
      expiresInMinutes: input.expiresInMinutes
    });
  } finally {
    database.close();
  }
}

export function createOwnerClaimInDatabase(
  database: VoxlyDatabase,
  input: CreateOwnerClaimInDatabaseInput
): OwnerClaimResult {
  const ownerCount = one<{ count: number }>(
    database.sqlite,
    "select count(*) as count from users where role = 'owner'"
  )?.count ?? 0;
  if (ownerCount > 0) {
    throw new OwnerSetupError("owner_exists", "An owner already exists.");
  }

  const nickname = normalizeNickname(input.nickname);
  const now = input.now ?? new Date();
  const expiresInMinutes = input.expiresInMinutes ?? 10;
  const user = {
    id: crypto.randomUUID(),
    nickname,
    role: "owner" as const,
    bannedAt: null
  };

  run(database.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", [
    user.id,
    user.nickname,
    user.role
  ]);
  audit(database, user.id, "owner.created", user.id, now);
  return createClaimForOwner(database, {
    user,
    baseUrl: input.baseUrl,
    expiresInMinutes,
    now
  });
}

export function consumeOwnerClaim(database: VoxlyDatabase, token: string, now = new Date()) {
  const claim = one<OwnerClaimRow>(
    database.sqlite,
    `select owner_claims.id, owner_claims.user_id, owner_claims.expires_at,
      owner_claims.consumed_at, users.nickname, users.role, users.banned_at
     from owner_claims
     join users on users.id = owner_claims.user_id
     where owner_claims.token_hash = ?`,
    [hashToken(token)]
  );

  if (!claim || claim.consumed_at || claim.banned_at || claim.role !== "owner" || isExpired(claim.expires_at, now)) {
    return null;
  }

  run(database.sqlite, "update owner_claims set consumed_at = ? where id = ?", [
    now.toISOString(),
    claim.id
  ]);
  audit(database, claim.user_id, "owner_claim.consumed", claim.user_id, now);
  database.save();

  return {
    id: claim.user_id,
    nickname: claim.nickname,
    role: claim.role,
    bannedAt: claim.banned_at
  };
}

function normalizeNickname(value: string) {
  const nickname = value.trim();
  if (nickname.length < 2 || nickname.length > 32) {
    throw new OwnerSetupError("invalid_nickname", "Owner nickname must be between 2 and 32 characters.");
  }
  return nickname;
}

function findOwnerForLoginClaim(database: VoxlyDatabase, nickname: string | undefined) {
  const owners = all<OwnerUserRow>(
    database.sqlite,
    "select id, nickname, role, banned_at from users where role = 'owner' and banned_at is null order by rowid asc"
  );
  const owner = nickname
    ? owners.find((item) => item.nickname.toLowerCase() === nickname.trim().toLowerCase())
    : owners[0];

  if (!owner) {
    throw new OwnerSetupError("owner_missing", "No active owner exists.");
  }

  return {
    id: owner.id,
    nickname: owner.nickname,
    role: owner.role,
    bannedAt: null
  };
}

function createClaimForOwner(
  database: VoxlyDatabase,
  input: {
    user: OwnerClaimResult["user"];
    baseUrl: string;
    expiresInMinutes?: number;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const expiresInMinutes = input.expiresInMinutes ?? 10;
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000).toISOString();
  const token = createOpaqueToken();

  run(
    database.sqlite,
    "insert into owner_claims (id, token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), hashToken(token), input.user.id, now.toISOString(), expiresAt]
  );
  audit(database, input.user.id, "owner_claim.created", input.user.id, now);
  database.save();

  return {
    token,
    url: `${input.baseUrl.replace(/\/+$/, "")}/setup/owner#claim=${encodeURIComponent(token)}`,
    expiresAt,
    user: input.user
  };
}

function audit(database: VoxlyDatabase, actorUserId: string | null, action: string, targetUserId: string | null, now: Date) {
  run(
    database.sqlite,
    "insert into audit_events (id, actor_user_id, action, target_user_id, created_at) values (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), actorUserId, action, targetUserId, now.toISOString()]
  );
}

function isExpired(value: string, now: Date) {
  return new Date(value).getTime() <= now.getTime();
}
