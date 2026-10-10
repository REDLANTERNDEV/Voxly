import { primaryKey, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  nickname: text("nickname").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  bannedAt: text("banned_at"),
  isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  deletedAt: text("deleted_at"),
  deletionSource: text("deletion_source", { enum: ["request_approved", "owner_initiated"] })
});

export const accountDeletionRequests = sqliteTable("account_deletion_requests", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  status: text("status", { enum: ["pending", "cancelled", "rejected", "approved"] }).notNull(),
  requestedAt: text("requested_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolvedByUserId: text("resolved_by_user_id")
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  createdByUserId: text("created_by_user_id").notNull(),
  usedByUserId: text("used_by_user_id"),
  usedAt: text("used_at"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  maxUses: integer("max_uses"),
  createdAt: text("created_at").notNull()
});

export const inviteUses = sqliteTable("invite_uses", {
  inviteId: text("invite_id").notNull(),
  userId: text("user_id").notNull(),
  usedAt: text("used_at").notNull()
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  /** Coarse and derived, never the raw User-Agent; see `auth/deviceLabel.ts`. */
  label: text("label"),
  lastSeenAt: text("last_seen_at"),
  /** When the *current* token value was issued; the row is older. */
  tokenIssuedAt: text("token_issued_at"),
  /** How this Device arrived: joined, linked, or recovered. */
  origin: text("origin", { enum: ["invite", "link", "recovery"] })
});

/**
 * A Link code in flight: minted by one Device, claimed by another, and worth
 * ninety seconds and one use. The claim half is separate from the mint half
 * because approval happens between them — see ADR-0014.
 */
export const deviceLinks = sqliteTable("device_links", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  /** Held only by the Device that claimed the code, so only it can collect. */
  claimTokenHash: text("claim_token_hash"),
  claimedAt: text("claimed_at"),
  claimLabel: text("claim_label"),
  /** Shown on both Devices while approval is waiting. Not a secret. */
  confirmation: text("confirmation"),
  approvedAt: text("approved_at"),
  refusedAt: text("refused_at")
});

/** Public launch correlation only; the browser session authorizes approval. */
export const desktopLaunches = sqliteTable("desktop_launches", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id").notNull(),
  origin: text("origin").notNull(),
  expiresAt: text("expires_at").notNull(),
  authorizationId: text("authorization_id").unique(),
  cancelledAt: text("cancelled_at")
});

/** A short browser approval request; only the arriving Device holds the secret. */
export const desktopAuthorizations = sqliteTable("desktop_authorizations", {
  id: text("id").primaryKey(),
  secretHash: text("secret_hash").notNull().unique(),
  origin: text("origin").notNull(),
  label: text("label").notNull(),
  confirmation: text("confirmation").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  approvedUserId: text("approved_user_id"),
  approvedSessionId: text("approved_session_id"),
  approvedAt: text("approved_at"),
  refusedAt: text("refused_at"),
  cancelledAt: text("cancelled_at"),
  consumedAt: text("consumed_at")
});

/**
 * The durable secret a member holds so they can reach their account with no
 * signed-in Device left. One live row per account: regenerating replaces it,
 * and redeeming replaces it too — see ADR-0014 on why using one is loud.
 */
export const recoveryCodes = sqliteTable("recovery_codes", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  usedAt: text("used_at"),
  replacedAt: text("replaced_at")
});

/**
 * Tokens a session has already carried.
 *
 * A session outlives any single token value: the value rotates while the row,
 * and everything bound to it, stays. These are the retired values, kept so that
 * one turning up again can be recognised for what it is — two parties holding
 * the same cookie. See ADR-0015.
 */
export const sessionTokens = sqliteTable("session_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  sessionId: text("session_id").notNull(),
  supersededAt: text("superseded_at").notNull(),
  /** When the replacement first returned, proving that its cookie was delivered. */
  replacementSeenAt: text("replacement_seen_at")
});

export const ownerClaims = sqliteTable("owner_claims", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at")
});

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  name: text("name").notNull(),
  position: integer("position").notNull()
});

export const rooms = sqliteTable("rooms", {
  messageSequence: integer("message_sequence").notNull().default(0),
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["text", "voice"] }).notNull(),
  position: integer("position").notNull(),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" })
});

export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: text("created_at").notNull(),
  uncategorizedPosition: integer("uncategorized_position").notNull().default(0)
});

export const serverMembers = sqliteTable("server_members", {
  mentionCode: text("mention_code"),
  messageNotificationsMuted: integer("message_notifications_muted", { mode: "boolean" }).notNull().default(false),
  messageNotificationsMuteUntil: text("message_notifications_mute_until"),
  serverId: text("server_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  nickname: text("nickname"),
  bannedAt: text("banned_at"),
  removedAt: text("removed_at"),
  moderatorMuted: integer("moderator_muted", { mode: "boolean" }).notNull().default(false),
  moderatorDeafened: integer("moderator_deafened", { mode: "boolean" }).notNull().default(false),
  canInvite: integer("can_invite", { mode: "boolean" }).notNull().default(false),
  joinedAt: text("joined_at").notNull()
});

export const accessClaims = sqliteTable("access_claims", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  serverId: text("server_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  revokedAt: text("revoked_at")
});

export const messages = sqliteTable("messages", {
  mentions: text("mentions").notNull().default("[]"),
  reactionVersion: integer("reaction_version").notNull().default(0),
  pinnedAt: text("pinned_at"),
  sequence: integer("sequence").notNull().default(0),
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull(),
  userId: text("user_id").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  editedAt: text("edited_at"),
  suppressedEmbedKeys: text("suppressed_embed_keys").notNull().default("[]"),
  deletedAt: text("deleted_at"),
  deletedByUserId: text("deleted_by_user_id")
});

export const messageReactions = sqliteTable(
  "message_reactions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull()
  },
  (table) => [primaryKey({ columns: [table.messageId, table.userId, table.emoji] })]
);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  targetUserId: text("target_user_id"),
  createdAt: text("created_at").notNull()
});

export const roomReadCursors = sqliteTable(
  "room_read_cursors",
  {
    userId: text("user_id").notNull(),
    roomId: text("room_id").notNull(),
    lastReadSequence: integer("last_read_sequence").notNull().default(0)
  },
  (table) => [primaryKey({ columns: [table.userId, table.roomId] })]
);
