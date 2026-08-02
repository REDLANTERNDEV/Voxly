import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  nickname: text("nickname").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  bannedAt: text("banned_at")
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
  revokedAt: text("revoked_at")
});

export const ownerClaims = sqliteTable("owner_claims", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at")
});

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["text", "voice"] }).notNull(),
  position: integer("position").notNull()
});

export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: text("created_at").notNull()
});

export const serverMembers = sqliteTable("server_members", {
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

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  targetUserId: text("target_user_id"),
  createdAt: text("created_at").notNull()
});
