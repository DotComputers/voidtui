import { Database } from "bun:sqlite";
import type { RecentPost } from "@void/shared";

/**
 * SQLite-backed store.
 *
 * Persistent state (identities, posts) lives in the DB.
 * Ephemeral state (replay cache, rate-limit windows) stays in memory.
 *
 * Schema matches PROTOCOL.md §7.4.
 */

export type Identity = {
  pubkeyHex: string;
  handle: string;
  created_at: number;
  banned_at: number | null;
  ban_reason: string | null;
  last_handle_change_at: number | null;
  last_post_at: number | null;
};

export type StoredPost = {
  id: string;
  pubkey_hex: string;
  handle: string;
  ghost: boolean;
  body: string;
  created_at: number;
};

export type ModerationDrop = {
  id: string;
  pubkey: string;
  category: string;
  score: number;
  body: string;
  created_at: number;
};

const DB_PATH = process.env.VOID_DB ?? "./void.db";

const db = new Database(DB_PATH, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    pubkey      TEXT PRIMARY KEY,
    handle      TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    banned_at   INTEGER,
    ban_reason  TEXT
  );

  CREATE TABLE IF NOT EXISTS posts (
    id          TEXT PRIMARY KEY,
    pubkey      TEXT NOT NULL REFERENCES identities(pubkey),
    handle      TEXT NOT NULL,
    ghost       INTEGER NOT NULL DEFAULT 0,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    CHECK (length(body) <= 280)
  );

  CREATE INDEX IF NOT EXISTS posts_created_at ON posts(created_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS moderation_log (
    id          TEXT PRIMARY KEY,
    pubkey      TEXT,
    category    TEXT NOT NULL,
    score       REAL NOT NULL,
    body        TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS moderation_log_created_at ON moderation_log(created_at);
`);

// Idempotent migrations — wrap each ALTER in try/catch so re-running on a
// schema that already has the column is a no-op.
function addColumnIfMissing(table: string, column: string, decl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("duplicate column name")) throw err;
  }
}
addColumnIfMissing("identities", "last_handle_change_at", "INTEGER");
addColumnIfMissing("identities", "last_post_at", "INTEGER");

// Prepared statements (cached for perf)
const stmtGetIdentityFull = db.prepare(
  "SELECT pubkey, handle, created_at, banned_at, ban_reason, last_handle_change_at, last_post_at FROM identities WHERE pubkey = $pubkey",
);
const stmtHandleTaken = db.prepare(
  "SELECT 1 AS taken FROM identities WHERE handle = $handle LIMIT 1",
);
const stmtInsertIdentity = db.prepare(
  "INSERT INTO identities (pubkey, handle, created_at, banned_at, ban_reason) VALUES ($pubkey, $handle, $created_at, NULL, NULL)",
);
const stmtInsertPost = db.prepare(
  "INSERT INTO posts (id, pubkey, handle, ghost, body, created_at) VALUES ($id, $pubkey, $handle, $ghost, $body, $created_at)",
);
const stmtRecentPosts = db.prepare(
  "SELECT id, handle, ghost, body, created_at FROM posts WHERE created_at >= $cutoff ORDER BY created_at ASC LIMIT $limit",
);
const stmtPurgePosts = db.prepare("DELETE FROM posts WHERE created_at < $cutoff");
const stmtInsertModeration = db.prepare(
  "INSERT INTO moderation_log (id, pubkey, category, score, body, created_at) VALUES ($id, $pubkey, $category, $score, $body, $created_at)",
);
const stmtAllModeration = db.prepare(
  "SELECT id, pubkey, category, score, body, created_at FROM moderation_log ORDER BY created_at ASC",
);
const stmtPurgeModerationText = db.prepare(
  "UPDATE moderation_log SET body = NULL WHERE created_at < $cutoff AND body IS NOT NULL",
);
const stmtRecordPostAt = db.prepare(
  "UPDATE identities SET last_post_at = $t WHERE pubkey = $pubkey",
);
const stmtUpdateHandle = db.prepare(
  `UPDATE identities
   SET handle = $new, last_handle_change_at = $t
   WHERE pubkey = $pubkey
     AND NOT EXISTS (SELECT 1 FROM identities WHERE handle = $new)`,
);

// In-memory ephemeral state
const replayCache = new Map<string, Map<string, number>>();
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const postTimestamps = new Map<string, number[]>();
const RATE_PER_MINUTE = 5;
const RATE_PER_DAY = 100;

// ──────────────────────────────────────────────────────────────────────────
// Identities
// ──────────────────────────────────────────────────────────────────────────

export function getIdentityByPubkey(pubkeyHex: string): Identity | undefined {
  const row = stmtGetIdentityFull.get({ pubkey: pubkeyHex }) as
    | {
        pubkey: string;
        handle: string;
        created_at: number;
        banned_at: number | null;
        ban_reason: string | null;
        last_handle_change_at: number | null;
        last_post_at: number | null;
      }
    | null;
  if (!row) return undefined;
  return {
    pubkeyHex: row.pubkey,
    handle: row.handle,
    created_at: row.created_at,
    banned_at: row.banned_at,
    ban_reason: row.ban_reason,
    last_handle_change_at: row.last_handle_change_at,
    last_post_at: row.last_post_at,
  };
}

/** Alias for the timestamp-aware identity getter, used by the change-handle path. */
export function getIdentityWithTimestamps(pubkeyHex: string): Identity | undefined {
  return getIdentityByPubkey(pubkeyHex);
}

/**
 * Atomic handle change. Returns ok=true if the row was updated (target free),
 * ok=false if the pubkey is unknown OR the target handle is taken.
 */
export function tryUpdateHandle(
  pubkeyHex: string,
  newHandle: string,
  changedAt: number,
): { ok: true } | { ok: false } {
  const result = stmtUpdateHandle.run({
    pubkey: pubkeyHex,
    new: newHandle,
    t: changedAt,
  });
  return result.changes && result.changes > 0 ? { ok: true } : { ok: false };
}

/** Record that this identity just made a post (updates last_post_at). */
export function recordPostAt(pubkeyHex: string, t: number): void {
  stmtRecordPostAt.run({ t, pubkey: pubkeyHex });
}

export function isHandleTaken(handle: string): boolean {
  return stmtHandleTaken.get({ handle }) !== null;
}

export function registerIdentity(pubkeyHex: string, handle: string): Identity {
  const identity: Identity = {
    pubkeyHex,
    handle,
    created_at: Date.now(),
    banned_at: null,
    ban_reason: null,
    last_handle_change_at: null,
    last_post_at: null,
  };
  stmtInsertIdentity.run({
    pubkey: pubkeyHex,
    handle,
    created_at: identity.created_at,
  });
  return identity;
}

// ──────────────────────────────────────────────────────────────────────────
// Posts
// ──────────────────────────────────────────────────────────────────────────

export function recordPost(post: StoredPost): void {
  stmtInsertPost.run({
    id: post.id,
    pubkey: post.pubkey_hex,
    handle: post.handle,
    ghost: post.ghost ? 1 : 0,
    body: post.body,
    created_at: post.created_at,
  });
}

export function recordModerationDrop(entry: ModerationDrop): void {
  stmtInsertModeration.run({
    id: entry.id,
    pubkey: entry.pubkey,
    category: entry.category,
    score: entry.score,
    body: entry.body,
    created_at: entry.created_at,
  });
}

/** Read all moderation-log rows (oldest first). For tuning + tests. */
export function getModerationDrops(): Array<{
  id: string;
  pubkey: string | null;
  category: string;
  score: number;
  body: string | null;
  created_at: number;
}> {
  return stmtAllModeration.all() as Array<{
    id: string;
    pubkey: string | null;
    category: string;
    score: number;
    body: string | null;
    created_at: number;
  }>;
}

export function getRecentPosts(maxAgeMs: number, limit: number): RecentPost[] {
  const cutoff = Date.now() - maxAgeMs;
  const rows = stmtRecentPosts.all({ cutoff, limit }) as Array<{
    id: string;
    handle: string;
    ghost: number;
    body: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    handle: r.ghost ? undefined : r.handle,
    ghost: r.ghost === 1,
    body: r.body,
    created_at: r.created_at,
  }));
}

/** Purge posts older than the retention window. Returns count removed. */
export function purgeExpiredPosts(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = stmtPurgePosts.run({ cutoff });
  return result.changes ?? 0;
}

/** Scrub post text from moderation-log rows older than the window. Rows persist; only `body` is nulled. Returns count scrubbed. */
export function purgeModerationText(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = stmtPurgeModerationText.run({ cutoff });
  return result.changes ?? 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Replay cache (in-memory)
// ──────────────────────────────────────────────────────────────────────────

export function checkAndMarkReplay(pubkeyHex: string, clientId: string): boolean {
  const now = Date.now();
  let cache = replayCache.get(pubkeyHex);
  if (!cache) {
    cache = new Map();
    replayCache.set(pubkeyHex, cache);
  }
  // Prune expired entries.
  for (const [id, seenAt] of cache) {
    if (now - seenAt > REPLAY_WINDOW_MS) cache.delete(id);
  }
  if (cache.has(clientId)) return true;
  cache.set(clientId, now);
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Rate limits (in-memory)
// ──────────────────────────────────────────────────────────────────────────

export function checkRateLimit(
  pubkeyHex: string,
): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  let times = postTimestamps.get(pubkeyHex) ?? [];
  times = times.filter((t) => now - t < 24 * 60 * 60 * 1000);
  postTimestamps.set(pubkeyHex, times);

  const lastMinute = times.filter((t) => now - t < 60 * 1000).length;
  if (lastMinute >= RATE_PER_MINUTE) {
    return { ok: false, retryAfter: times[times.length - RATE_PER_MINUTE]! + 60 * 1000 };
  }
  if (times.length >= RATE_PER_DAY) {
    return { ok: false, retryAfter: times[0]! + 24 * 60 * 60 * 1000 };
  }
  return { ok: true };
}

export function recordPostTimestamp(pubkeyHex: string): void {
  const times = postTimestamps.get(pubkeyHex) ?? [];
  times.push(Date.now());
  postTimestamps.set(pubkeyHex, times);
}

// ──────────────────────────────────────────────────────────────────────────
// Cleanup
// ──────────────────────────────────────────────────────────────────────────

export function closeStore(): void {
  db.close();
}
