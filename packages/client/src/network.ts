import { ulid } from "ulid";
import {
  PROTOCOL_VERSION,
  ServerMessage,
  computePow,
  signMessage,
  toHex,
  generateKeypair,
  type Keypair,
} from "@void/shared";
import {
  loadIdentity,
  newIdentity,
  saveIdentity,
  suggestHandle,
  type Identity,
} from "./identity.ts";

const CLIENT_VERSION = "0.1.0";
const POW_DIFFICULTY = 18;
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "blocked";

export type BroadcastEvent = {
  id: string;
  handle?: string;
  ghost: boolean;
  body: string;
  created_at: number;
};

export type OwnPostEvent = BroadcastEvent;

export type NetworkEventMap = {
  status: (status: ConnectionStatus) => void;
  handle: (handle: string) => void;
  activeCount: (count: number) => void;
  broadcast: (post: BroadcastEvent) => void;
  ownPost: (post: OwnPostEvent) => void;
  rejected: (reason: string, message: string) => void;
};

/**
 * Owns the WebSocket connection + identity + signing.
 *
 * Consumers subscribe via `on(event, callback)`. The class handles:
 *  - First-run vs returning identity (keypair on disk).
 *  - Proof-of-work for first registration.
 *  - Sending signed CONNECT and POST messages.
 *  - Receiving CONNECTED, BROADCAST, POST_OK, POST_REJECTED, ACTIVE_COUNT, etc.
 *  - Reconnect with exponential backoff.
 *  - Heartbeat PING every 30s.
 */
export class NetworkClient {
  private url: string;
  private ws: WebSocket | null = null;
  private identity!: Identity;
  private isFirstRun = false;
  private listeners: Partial<{
    [K in keyof NetworkEventMap]: NetworkEventMap[K][];
  }> = {};
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Track posts we've sent so we can spawn them locally when POST_OK arrives
  // (server never broadcasts our own posts back to us).
  private pendingPosts = new Map<string, { body: string; ghost: boolean }>();

  // First-run state: keypair + PoW cached across retries of tryRegister().
  private pendingKeypair: Keypair | null = null;
  private pendingPow: { nonce: string; difficulty: number } | null = null;

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Whether the saved-on-disk identity already exists. Caller can use this
   * to decide between the first-run picker flow vs the normal start().
   */
  async hasSavedIdentity(): Promise<boolean> {
    return (await loadIdentity()) !== null;
  }

  async start(): Promise<void> {
    const existing = await loadIdentity();
    if (existing) {
      this.identity = existing;
      this.isFirstRun = false;
    } else if (this.identity) {
      // Already populated by tryRegister; skip reload.
      this.isFirstRun = false;
    } else {
      this.identity = newIdentity();
      this.isFirstRun = true;
    }
    this.connect();
  }

  /**
   * One-shot first-run registration. Opens a temporary WebSocket, sends a
   * signed CONNECT with the requested handle + PoW, and resolves with the
   * outcome. On success, persists the identity to disk so a subsequent
   * `start()` picks it up and runs the normal auth flow.
   *
   * Keypair + PoW are computed once and cached across retries — same
   * keypair, different handle request each attempt.
   */
  async tryRegister(
    handleRequest: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
    if (!this.pendingKeypair) {
      this.pendingKeypair = generateKeypair();
    }
    if (!this.pendingPow) {
      const computed = computePow(
        this.pendingKeypair.publicKey,
        POW_DIFFICULTY,
      );
      this.pendingPow = { nonce: computed.nonce, difficulty: POW_DIFFICULTY };
    }

    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        resolve({
          ok: false,
          reason: "connection_error",
          message: String(err),
        });
        return;
      }

      let settled = false;
      const finish = (
        result:
          | { ok: true }
          | { ok: false; reason: string; message: string },
      ): void => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(result);
      };

      ws.onopen = () => {
        const msg = {
          v: PROTOCOL_VERSION as const,
          type: "CONNECT" as const,
          pubkey: toHex(this.pendingKeypair!.publicKey),
          client_version: CLIENT_VERSION,
          handle_request: handleRequest,
          pow: this.pendingPow!,
          t: Date.now(),
        };
        const sig = signMessage(this.pendingKeypair!.privateKey, msg);
        ws.send(JSON.stringify({ ...msg, signature: sig }));
      };

      ws.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            typeof event.data === "string"
              ? event.data
              : (event.data as { toString(): string }).toString(),
          );
        } catch {
          return;
        }
        const r = ServerMessage.safeParse(parsed);
        if (!r.success) return;
        const m = r.data;

        if (m.type === "CONNECTED") {
          const identity: Identity = {
            keypair: this.pendingKeypair!,
            handle: m.handle,
          };
          saveIdentity(identity).catch(() => {
            // Best-effort. If persistence fails the user can still use
            // this session; on next launch they'd re-register.
          });
          this.identity = identity;
          this.pendingKeypair = null;
          this.pendingPow = null;
          finish({ ok: true });
        } else if (m.type === "CONNECT_REJECTED") {
          finish({ ok: false, reason: m.reason, message: m.message });
        } else if (m.type === "PROTOCOL_MISMATCH") {
          finish({
            ok: false,
            reason: "protocol_mismatch",
            message: "client must update",
          });
        }
      };

      ws.onerror = () => {
        finish({
          ok: false,
          reason: "connection_error",
          message: "could not reach server",
        });
      };

      // Hard timeout in case server doesn't respond.
      setTimeout(() => {
        finish({
          ok: false,
          reason: "timeout",
          message: "no response from server",
        });
      }, 10_000);
    });
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  /**
   * Graceful close: sends a 1000 normal-closure frame and waits up to 200ms
   * for the close ack, then resolves. Used by /quit and SIGINT.
   */
  async close(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;

    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;

    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 200);
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        ws.close(1000, "bye");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  on<K extends keyof NetworkEventMap>(
    event: K,
    callback: NetworkEventMap[K],
  ): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    (this.listeners[event] as NetworkEventMap[K][]).push(callback);
  }

  /**
   * Request a handle change for this identity. Returns the outcome.
   * NOT called from any UI path in v0.1 — reserved for a future paid-rename feature.
   *
   * Server enforces: ≥24h since last rename, ≥24h since last post, fresh PoW,
   * atomic handle uniqueness. See PROTOCOL.md §7.7.
   */
  async tryChangeHandle(
    newHandle: string,
  ): Promise<
    | { ok: true; handle: string; changed_at: number }
    | { ok: false; reason: string; retry_after?: number }
  > {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: "not_connected" };
    }
    const ws = this.ws;

    const computed = computePow(this.identity.keypair.publicKey, POW_DIFFICULTY);
    const msg = {
      v: PROTOCOL_VERSION as const,
      type: "CHANGE_HANDLE" as const,
      pubkey: toHex(this.identity.keypair.publicKey),
      handle_request: newHandle,
      pow: { nonce: computed.nonce, difficulty: POW_DIFFICULTY },
      t: Date.now(),
    };
    const signature = signMessage(this.identity.keypair.privateKey, msg);
    ws.send(JSON.stringify({ ...msg, signature }));

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener("message", listener);
        resolve({ ok: false, reason: "timeout" });
      }, 10_000);

      const listener = (event: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            typeof event.data === "string"
              ? event.data
              : (event.data as { toString(): string }).toString(),
          );
        } catch {
          return;
        }
        const r = ServerMessage.safeParse(parsed);
        if (!r.success) return;
        const m = r.data;
        if (m.type === "HANDLE_CHANGED") {
          clearTimeout(timeout);
          ws.removeEventListener("message", listener);
          this.identity.handle = m.handle;
          void import("./identity.ts").then(({ saveIdentity }) =>
            saveIdentity(this.identity).catch(() => {}),
          );
          this.emit("handle", m.handle);
          resolve({ ok: true, handle: m.handle, changed_at: m.changed_at });
        } else if (m.type === "CHANGE_HANDLE_REJECTED") {
          clearTimeout(timeout);
          ws.removeEventListener("message", listener);
          resolve({ ok: false, reason: m.reason, retry_after: m.retry_after });
        }
      };
      ws.addEventListener("message", listener);
    });
  }

  sendPost(input: { body: string; ghost: boolean }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const clientId = ulid();
    const post = {
      v: PROTOCOL_VERSION as const,
      type: "POST" as const,
      client_id: clientId,
      pubkey: toHex(this.identity.keypair.publicKey),
      body: input.body,
      ghost: input.ghost,
      t: Date.now(),
    };
    const signature = signMessage(this.identity.keypair.privateKey, post);

    this.pendingPosts.set(clientId, { body: input.body, ghost: input.ghost });
    this.ws.send(JSON.stringify({ ...post, signature }));
  }

  private emit<K extends keyof NetworkEventMap>(
    event: K,
    ...args: Parameters<NetworkEventMap[K]>
  ): void {
    const cbs = this.listeners[event];
    if (!cbs) return;
    for (const cb of cbs) (cb as (...a: typeof args) => void)(...args);
  }

  private connect(): void {
    this.emit("status", "connecting");

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.emit("status", "disconnected");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => this.sendConnect();
    this.ws.onmessage = (event) => this.handleMessage(event);
    this.ws.onerror = () => {
      // onclose will follow; handle reconnect there.
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.emit("status", "disconnected");
      this.scheduleReconnect();
    };
  }

  private sendConnect(): void {
    if (!this.ws) return;

    let handleRequest: string | undefined;
    let pow: { nonce: string; difficulty: number } | undefined;

    if (this.isFirstRun) {
      handleRequest = suggestHandle();
      const computed = computePow(
        this.identity.keypair.publicKey,
        POW_DIFFICULTY,
      );
      pow = { nonce: computed.nonce, difficulty: POW_DIFFICULTY };
    }

    const connectMsg = {
      v: PROTOCOL_VERSION as const,
      type: "CONNECT" as const,
      pubkey: toHex(this.identity.keypair.publicKey),
      client_version: CLIENT_VERSION,
      handle_request: handleRequest,
      pow,
      t: Date.now(),
    };
    const signature = signMessage(this.identity.keypair.privateKey, connectMsg);

    this.ws.send(JSON.stringify({ ...connectMsg, signature }));
  }

  private handleMessage(event: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof event.data === "string"
          ? event.data
          : (event.data as { toString(): string }).toString(),
      );
    } catch {
      return;
    }

    const result = ServerMessage.safeParse(parsed);
    if (!result.success) return;
    const msg = result.data;

    switch (msg.type) {
      case "CONNECTED": {
        this.identity.handle = msg.handle;
        if (this.isFirstRun) {
          saveIdentity(this.identity).catch(() => {
            // Failed to persist identity; user can still use this session.
          });
          this.isFirstRun = false;
        }
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.emit("handle", msg.handle);
        this.emit("activeCount", msg.active_count);
        this.emit("status", "connected");
        for (const post of msg.recent_posts) {
          this.emit("broadcast", {
            id: post.id,
            handle: post.handle,
            ghost: post.ghost,
            body: post.body,
            created_at: post.created_at,
          });
        }
        break;
      }
      case "CONNECT_REJECTED": {
        // If our identity isn't on the server (e.g. server was wiped /
        // restarted with a fresh DB), transparently re-register. This is
        // safe: a new handle gets minted, the user notices their handle
        // changed but the app continues working.
        if (msg.reason === "not_registered") {
          this.isFirstRun = true;
          // The socket is about to be closed by the server; let reconnect
          // handle the next attempt. It'll see isFirstRun=true and register.
          this.emit("status", "connecting");
          break;
        }
        this.emit("rejected", msg.reason, msg.message);
        this.emit("status", "blocked");
        break;
      }
      case "PROTOCOL_MISMATCH": {
        this.emit("rejected", "protocol_mismatch", "client must update");
        this.emit("status", "blocked");
        break;
      }
      case "BROADCAST": {
        this.emit("broadcast", {
          id: msg.id,
          handle: msg.handle,
          ghost: msg.ghost,
          body: msg.body,
          created_at: msg.created_at,
        });
        break;
      }
      case "POST_OK": {
        const pending = this.pendingPosts.get(msg.client_id);
        this.pendingPosts.delete(msg.client_id);
        if (pending) {
          this.emit("ownPost", {
            id: msg.server_id,
            handle: pending.ghost ? undefined : this.identity.handle ?? undefined,
            ghost: pending.ghost,
            body: pending.body,
            created_at: msg.created_at,
          });
        }
        break;
      }
      case "POST_REJECTED": {
        this.pendingPosts.delete(msg.client_id);
        // TODO: emit a "post_rejected" event for UI feedback (red flash, etc.)
        break;
      }
      case "ACTIVE_COUNT": {
        this.emit("activeCount", msg.count);
        break;
      }
      case "PONG":
      case "ERROR":
        // No-op for v0.1.
        break;
    }
  }

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "PING",
          t: Date.now(),
        }),
      );
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayIdx = Math.min(
      this.reconnectAttempts,
      RECONNECT_BACKOFF_MS.length - 1,
    );
    const delay = RECONNECT_BACKOFF_MS[delayIdx]!;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
