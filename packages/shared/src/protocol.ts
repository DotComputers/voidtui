import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const Hex = z.string().regex(/^[0-9a-f]+$/);
const Hex64 = Hex.length(64); // Ed25519 public key
const Hex128 = Hex.length(128); // Ed25519 signature

export const HandleSchema = z
  .string()
  .regex(/^[a-z0-9_-]{3,20}$/, "handle must be 3-20 chars, lowercase a-z, 0-9, _, -");

const Timestamp = z.number().int().positive();
const Version = z.literal(PROTOCOL_VERSION);

// ──────────────────────────────────────────────────────────────────────────
// Client → Server
// ──────────────────────────────────────────────────────────────────────────

export const ConnectMessage = z.object({
  v: Version,
  type: z.literal("CONNECT"),
  pubkey: Hex64,
  client_version: z.string(),
  handle_request: HandleSchema.optional(),
  pow: z
    .object({
      nonce: Hex,
      difficulty: z.number().int().positive(),
    })
    .optional(),
  t: Timestamp,
  signature: Hex128,
});
export type ConnectMessage = z.infer<typeof ConnectMessage>;

export const PostMessage = z.object({
  v: Version,
  type: z.literal("POST"),
  client_id: z.string().min(1).max(64),
  pubkey: Hex64,
  body: z.string().min(1).max(280),
  ghost: z.boolean(),
  t: Timestamp,
  signature: Hex128,
});
export type PostMessage = z.infer<typeof PostMessage>;

export const PingMessage = z.object({
  v: Version,
  type: z.literal("PING"),
  t: Timestamp,
});
export type PingMessage = z.infer<typeof PingMessage>;

export const ChangeHandleMessage = z.object({
  v: Version,
  type: z.literal("CHANGE_HANDLE"),
  pubkey: Hex64,
  handle_request: HandleSchema,
  pow: z.object({
    nonce: Hex,
    difficulty: z.number().int().positive(),
  }),
  t: Timestamp,
  signature: Hex128,
});
export type ChangeHandleMessage = z.infer<typeof ChangeHandleMessage>;

export const ClientMessage = z.discriminatedUnion("type", [
  ConnectMessage,
  PostMessage,
  PingMessage,
  ChangeHandleMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ──────────────────────────────────────────────────────────────────────────
// Server → Client
// ──────────────────────────────────────────────────────────────────────────

export const RecentPostSchema = z.object({
  id: z.string(),
  handle: HandleSchema.optional(),
  ghost: z.boolean(),
  body: z.string(),
  created_at: Timestamp,
});
export type RecentPost = z.infer<typeof RecentPostSchema>;

export const ConnectedMessage = z.object({
  v: Version,
  type: z.literal("CONNECTED"),
  server_version: z.string(),
  handle: HandleSchema,
  server_time: Timestamp,
  active_count: z.number().int().nonnegative(),
  recent_posts: z.array(RecentPostSchema),
});
export type ConnectedMessage = z.infer<typeof ConnectedMessage>;

export const ConnectRejectReason = z.enum([
  "not_registered",
  "already_registered",
  "handle_taken",
  "handle_invalid",
  "invalid_pow",
  "invalid_signature",
  "stale_timestamp",
  "server_full",
]);
export type ConnectRejectReason = z.infer<typeof ConnectRejectReason>;

export const ConnectRejectedMessage = z.object({
  v: Version,
  type: z.literal("CONNECT_REJECTED"),
  reason: ConnectRejectReason,
  message: z.string(),
});
export type ConnectRejectedMessage = z.infer<typeof ConnectRejectedMessage>;

export const ProtocolMismatchMessage = z.object({
  v: z.number().int().positive(),
  type: z.literal("PROTOCOL_MISMATCH"),
  server_supports: z.array(z.number().int().positive()),
  minimum_required: z.number().int().positive(),
  update_url: z.string().url(),
});
export type ProtocolMismatchMessage = z.infer<typeof ProtocolMismatchMessage>;

export const PostOkMessage = z.object({
  v: Version,
  type: z.literal("POST_OK"),
  client_id: z.string(),
  server_id: z.string(),
  created_at: Timestamp,
});
export type PostOkMessage = z.infer<typeof PostOkMessage>;

export const PostRejectReason = z.enum([
  "bad_request",
  "invalid_signature",
  "stale_timestamp",
  "duplicate",
  "not_registered",
  "rate_limit",
  "content_blocked",
  "banned",
]);
export type PostRejectReason = z.infer<typeof PostRejectReason>;

export const PostRejectedMessage = z.object({
  v: Version,
  type: z.literal("POST_REJECTED"),
  client_id: z.string(),
  reason: PostRejectReason,
  message: z.string(),
  retry_after: Timestamp.optional(),
});
export type PostRejectedMessage = z.infer<typeof PostRejectedMessage>;

export const BroadcastMessage = z.object({
  v: Version,
  type: z.literal("BROADCAST"),
  id: z.string(),
  handle: HandleSchema.optional(),
  ghost: z.boolean(),
  body: z.string(),
  created_at: Timestamp,
});
export type BroadcastMessage = z.infer<typeof BroadcastMessage>;

export const ActiveCountMessage = z.object({
  v: Version,
  type: z.literal("ACTIVE_COUNT"),
  count: z.number().int().nonnegative(),
});
export type ActiveCountMessage = z.infer<typeof ActiveCountMessage>;

export const PongMessage = z.object({
  v: Version,
  type: z.literal("PONG"),
  t: Timestamp,
});
export type PongMessage = z.infer<typeof PongMessage>;

export const ErrorMessage = z.object({
  v: Version,
  type: z.literal("ERROR"),
  code: z.enum(["internal", "unauthorized", "kicked"]),
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const HandleChangedMessage = z.object({
  v: Version,
  type: z.literal("HANDLE_CHANGED"),
  handle: HandleSchema,
  changed_at: Timestamp,
});
export type HandleChangedMessage = z.infer<typeof HandleChangedMessage>;

export const ChangeHandleRejectReason = z.enum([
  "handle_taken",
  "handle_invalid",
  "invalid_pow",
  "invalid_signature",
  "stale_timestamp",
  "cooldown_active",
  "recent_post",
  "not_registered",
  "bad_request",
]);
export type ChangeHandleRejectReason = z.infer<typeof ChangeHandleRejectReason>;

export const ChangeHandleRejectedMessage = z.object({
  v: Version,
  type: z.literal("CHANGE_HANDLE_REJECTED"),
  reason: ChangeHandleRejectReason,
  message: z.string(),
  retry_after: Timestamp.optional(),
});
export type ChangeHandleRejectedMessage = z.infer<typeof ChangeHandleRejectedMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  ConnectedMessage,
  ConnectRejectedMessage,
  ProtocolMismatchMessage,
  PostOkMessage,
  PostRejectedMessage,
  BroadcastMessage,
  ActiveCountMessage,
  PongMessage,
  ErrorMessage,
  HandleChangedMessage,
  ChangeHandleRejectedMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
