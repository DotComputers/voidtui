import type { ServerWebSocket } from "bun";
import { ulid } from "ulid";
import {
  ClientMessage,
  type ChangeHandleMessage,
  type ConnectMessage,
  type PostMessage,
  type ServerMessage,
  PROTOCOL_VERSION,
  verifyMessage,
  verifyPow,
  fromHex,
} from "@void/shared";
import {
  checkAndMarkReplay,
  checkRateLimit,
  getIdentityByPubkey,
  getRecentPosts,
  isHandleTaken,
  purgeExpiredPosts,
  purgeModerationText,
  recordModerationDrop,
  recordPost,
  recordPostAt,
  recordPostTimestamp,
  registerIdentity,
  tryUpdateHandle,
} from "./store.ts";
import { handleReleaseRequest } from "./release-routes.ts";
import { classify, initModeration } from "./moderation.ts";

const SERVER_VERSION = "0.1.0";
const PORT = Number(process.env.PORT ?? 8787);
const RELEASE_DIR = process.env.VOID_RELEASE_DIR ?? "./release";
const POW_DIFFICULTY = 18;
const POST_RETENTION_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 90 * 1000;
const RECENT_LIMIT = 50;
const TIMESTAMP_SKEW_MS = 60 * 1000;
const POW_NONCE_MAX_BYTES = 32;
const HANDLE_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

type WSData = {
  pubkeyHex: string | null;
  handle: string | null;
  banned: boolean;
  lastPingAt: number;
};

type Sock = ServerWebSocket<WSData>;
const connections = new Set<Sock>();

function send(ws: Sock, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage, excludePubkey?: string): void {
  const payload = JSON.stringify(msg);
  for (const ws of connections) {
    if (!ws.data.pubkeyHex) continue;
    if (excludePubkey && ws.data.pubkeyHex === excludePubkey) continue;
    if (ws.data.banned) continue;
    ws.send(payload);
  }
}

function pushActiveCount(): void {
  const count = Array.from(connections).filter((c) => c.data.pubkeyHex).length;
  broadcast({ v: PROTOCOL_VERSION, type: "ACTIVE_COUNT", count });
}

function handleConnect(ws: Sock, msg: ConnectMessage): void {
  // Timestamp skew check
  if (Math.abs(msg.t - Date.now()) > TIMESTAMP_SKEW_MS) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CONNECT_REJECTED",
      reason: "stale_timestamp",
      message: "client clock skew exceeds 60s",
    });
    ws.close();
    return;
  }

  // Signature verification
  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = fromHex(msg.pubkey);
  } catch {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CONNECT_REJECTED",
      reason: "invalid_signature",
      message: "invalid pubkey encoding",
    });
    ws.close();
    return;
  }

  if (!verifyMessage(pubkeyBytes, msg, msg.signature)) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CONNECT_REJECTED",
      reason: "invalid_signature",
      message: "signature verification failed",
    });
    ws.close();
    return;
  }

  const existing = getIdentityByPubkey(msg.pubkey);
  const isRegistration = !!msg.handle_request && !!msg.pow;

  if (existing && isRegistration) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CONNECT_REJECTED",
      reason: "already_registered",
      message: "this identity is already registered",
    });
    ws.close();
    return;
  }

  if (!existing && !isRegistration) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CONNECT_REJECTED",
      reason: "not_registered",
      message: "this identity is not registered",
    });
    ws.close();
    return;
  }

  let identity = existing;

  if (isRegistration) {
    // Validate PoW
    if (
      msg.pow!.difficulty < POW_DIFFICULTY ||
      !verifyPow(pubkeyBytes, msg.pow!.nonce, POW_DIFFICULTY) ||
      msg.pow!.nonce.length > POW_NONCE_MAX_BYTES * 2
    ) {
      send(ws, {
        v: PROTOCOL_VERSION,
        type: "CONNECT_REJECTED",
        reason: "invalid_pow",
        message: "proof of work is invalid or below required difficulty",
      });
      ws.close();
      return;
    }
    // Validate handle availability
    if (isHandleTaken(msg.handle_request!)) {
      send(ws, {
        v: PROTOCOL_VERSION,
        type: "CONNECT_REJECTED",
        reason: "handle_taken",
        message: "handle is taken",
      });
      ws.close();
      return;
    }
    identity = registerIdentity(msg.pubkey, msg.handle_request!);
  }

  // Authenticated
  ws.data.pubkeyHex = msg.pubkey;
  ws.data.handle = identity!.handle;
  ws.data.banned = identity!.banned_at !== null;
  ws.data.lastPingAt = Date.now();

  const activeCount = Array.from(connections).filter((c) => c.data.pubkeyHex).length;

  send(ws, {
    v: PROTOCOL_VERSION,
    type: "CONNECTED",
    server_version: SERVER_VERSION,
    handle: identity!.handle,
    server_time: Date.now(),
    active_count: activeCount,
    recent_posts: getRecentPosts(RECENT_WINDOW_MS, RECENT_LIMIT),
  });

  pushActiveCount();
}

async function handlePost(ws: Sock, msg: PostMessage): Promise<void> {
  if (!ws.data.pubkeyHex || ws.data.pubkeyHex !== msg.pubkey) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "POST_REJECTED",
      client_id: msg.client_id,
      reason: "not_registered",
      message: "post pubkey does not match connection",
    });
    return;
  }

  if (Math.abs(msg.t - Date.now()) > TIMESTAMP_SKEW_MS) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "POST_REJECTED",
      client_id: msg.client_id,
      reason: "stale_timestamp",
      message: "timestamp out of range",
    });
    return;
  }

  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = fromHex(msg.pubkey);
  } catch {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "POST_REJECTED",
      client_id: msg.client_id,
      reason: "bad_request",
      message: "invalid pubkey encoding",
    });
    return;
  }

  if (!verifyMessage(pubkeyBytes, msg, msg.signature)) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "POST_REJECTED",
      client_id: msg.client_id,
      reason: "invalid_signature",
      message: "signature verification failed",
    });
    return;
  }

  if (checkAndMarkReplay(msg.pubkey, msg.client_id)) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "POST_REJECTED",
      client_id: msg.client_id,
      reason: "duplicate",
      message: "duplicate client_id",
    });
    return;
  }

  const limit = checkRateLimit(msg.pubkey);
  if (!limit.ok) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "POST_REJECTED",
      client_id: msg.client_id,
      reason: "rate_limit",
      message: "slow down",
      retry_after: limit.retryAfter,
    });
    return;
  }

  // All validation passed. Generate identifiers and do rate-limit bookkeeping at
  // arrival — a post counts against the author's window whether or not it is later
  // shadow-dropped (probing the filter is not free).
  const serverId = ulid();
  const createdAt = Date.now();
  const identity = getIdentityByPubkey(msg.pubkey)!;
  recordPostAt(msg.pubkey, createdAt);
  recordPostTimestamp(msg.pubkey);

  // Ack immediately. The client renders its own post locally off POST_OK, so the
  // author's experience is identical whether or not the post is later dropped.
  send(ws, {
    v: PROTOCOL_VERSION,
    type: "POST_OK",
    client_id: msg.client_id,
    server_id: serverId,
    created_at: createdAt,
  });

  // Shadow ban: acked above, but never persisted to `posts` and never broadcast.
  // (Persisting here previously leaked banned posts to new clients via backfill.)
  if (ws.data.banned) return;

  // Content moderation runs off the hot path and fails open. A blocked post is
  // logged (text scrubbed at 24h) and silently dropped: no `posts` row, no broadcast.
  const verdict = await classify(msg.body);
  if (verdict.blocked) {
    recordModerationDrop({
      id: serverId,
      pubkey: msg.pubkey,
      category: verdict.category,
      score: verdict.score,
      body: msg.body,
      created_at: createdAt,
    });
    return;
  }

  recordPost({
    id: serverId,
    pubkey_hex: msg.pubkey,
    handle: identity.handle,
    ghost: msg.ghost,
    body: msg.body,
    created_at: createdAt,
  });

  broadcast(
    {
      v: PROTOCOL_VERSION,
      type: "BROADCAST",
      id: serverId,
      handle: msg.ghost ? undefined : identity.handle,
      ghost: msg.ghost,
      body: msg.body,
      created_at: createdAt,
      // Strip accent for ghosts (same privacy contract as handle).
      accent: msg.ghost ? undefined : msg.accent,
    },
    msg.pubkey,
  );
}

function handleChangeHandle(ws: Sock, msg: ChangeHandleMessage): void {
  // Must be authenticated as this pubkey.
  if (!ws.data.pubkeyHex || ws.data.pubkeyHex !== msg.pubkey) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "not_registered",
      message: "pubkey does not match connection",
    });
    return;
  }

  if (Math.abs(msg.t - Date.now()) > TIMESTAMP_SKEW_MS) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "stale_timestamp",
      message: "timestamp out of range",
    });
    return;
  }

  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = fromHex(msg.pubkey);
  } catch {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "bad_request",
      message: "invalid pubkey encoding",
    });
    return;
  }

  if (!verifyMessage(pubkeyBytes, msg, msg.signature)) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "invalid_signature",
      message: "signature verification failed",
    });
    return;
  }

  if (
    msg.pow.difficulty < POW_DIFFICULTY ||
    !verifyPow(pubkeyBytes, msg.pow.nonce, POW_DIFFICULTY) ||
    msg.pow.nonce.length > POW_NONCE_MAX_BYTES * 2
  ) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "invalid_pow",
      message: "proof of work is invalid or below required difficulty",
    });
    return;
  }

  const identity = getIdentityByPubkey(msg.pubkey);
  if (!identity) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "not_registered",
      message: "identity not found",
    });
    return;
  }

  const now = Date.now();

  if (
    identity.last_handle_change_at !== null &&
    now - identity.last_handle_change_at < HANDLE_CHANGE_COOLDOWN_MS
  ) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "cooldown_active",
      message: "wait 24h between handle changes",
      retry_after: identity.last_handle_change_at + HANDLE_CHANGE_COOLDOWN_MS,
    });
    return;
  }

  if (
    identity.last_post_at !== null &&
    now - identity.last_post_at < HANDLE_CHANGE_COOLDOWN_MS
  ) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "recent_post",
      message: "you have posted in the last 24h",
      retry_after: identity.last_post_at + HANDLE_CHANGE_COOLDOWN_MS,
    });
    return;
  }

  const result = tryUpdateHandle(msg.pubkey, msg.handle_request, now);
  if (!result.ok) {
    send(ws, {
      v: PROTOCOL_VERSION,
      type: "CHANGE_HANDLE_REJECTED",
      reason: "handle_taken",
      message: "handle is taken",
    });
    return;
  }

  ws.data.handle = msg.handle_request;
  send(ws, {
    v: PROTOCOL_VERSION,
    type: "HANDLE_CHANGED",
    handle: msg.handle_request,
    changed_at: now,
  });
}

async function handleMessage(ws: Sock, raw: string | Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return;
  }

  // Quick version check before schema validation
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "v" in parsed &&
    (parsed as { v: number }).v !== PROTOCOL_VERSION
  ) {
    send(ws, {
      v: (parsed as { v: number }).v,
      type: "PROTOCOL_MISMATCH",
      server_supports: [PROTOCOL_VERSION],
      minimum_required: PROTOCOL_VERSION,
      update_url: "https://void.tld/install",
    });
    ws.close();
    return;
  }

  const result = ClientMessage.safeParse(parsed);
  if (!result.success) {
    // Malformed; ignore silently or log
    return;
  }

  const msg = result.data;
  switch (msg.type) {
    case "CONNECT":
      handleConnect(ws, msg);
      break;
    case "POST":
      await handlePost(ws, msg);
      break;
    case "PING":
      ws.data.lastPingAt = Date.now();
      send(ws, { v: PROTOCOL_VERSION, type: "PONG", t: Date.now() });
      break;
    case "CHANGE_HANDLE":
      handleChangeHandle(ws, msg);
      break;
  }
}

function startServer(): void {
  // Load the moderation model in the background. Until it resolves (or if it
  // fails), classify() fails open and all posts pass.
  void initModeration();

  const server = Bun.serve<WSData, never>({
    port: PORT,
    async fetch(req, server) {
      const releaseResponse = await handleReleaseRequest(req, RELEASE_DIR);
      if (releaseResponse) return releaseResponse;

      const upgraded = server.upgrade(req, {
        data: {
          pubkeyHex: null,
          handle: null,
          banned: false,
          lastPingAt: Date.now(),
        },
      });
      if (upgraded) return;
      return new Response("void", { status: 200 });
    },
    websocket: {
      open(ws) {
        connections.add(ws);
      },
      message(ws, raw) {
        void handleMessage(ws, raw).catch((err) => console.error("[void] handler error", err));
      },
      close(ws) {
        connections.delete(ws);
        if (ws.data.pubkeyHex) pushActiveCount();
      },
    },
  });

  setInterval(() => {
    const removed = purgeExpiredPosts(POST_RETENTION_MS);
    if (removed > 0) console.log(`[void] purged ${removed} expired posts`);
    const scrubbed = purgeModerationText(POST_RETENTION_MS);
    if (scrubbed > 0) console.log(`[void] scrubbed text from ${scrubbed} moderation-log rows`);
  }, 60 * 60 * 1000);

  setInterval(() => {
    const now = Date.now();
    for (const ws of connections) {
      if (ws.data.pubkeyHex && now - ws.data.lastPingAt > 90_000) {
        ws.close();
      }
    }
  }, 15_000);

  console.log(`[void] server listening on ${server.hostname}:${server.port}`);
}

// Exposed for tests only. Production callers use Bun.serve's websocket.message.
export const __test_handleMessage = handleMessage;

// Exposed for tests only — lets handler tests observe broadcast fan-out.
export const __test_connections = connections;

if (!process.env.VOID_TEST_MODE) {
  startServer();
}
