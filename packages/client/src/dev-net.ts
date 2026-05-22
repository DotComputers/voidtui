#!/usr/bin/env bun
/**
 * Pre-TUI scaffolding client.
 *
 * Connects to the configured void server, registers if needed, sends a single
 * test post, then prints everything it receives for ~10 seconds and exits.
 *
 * The actual OpenTUI scene comes in the next pass — this is here to prove the
 * wire works end-to-end.
 */
import { ulid } from "ulid";
import {
  PROTOCOL_VERSION,
  ServerMessage,
  computePow,
  signMessage,
  toHex,
} from "@void/shared";
import {
  loadIdentity,
  newIdentity,
  saveIdentity,
  suggestHandle,
  identityPath,
  type Identity,
} from "./identity.ts";

const SERVER_URL = process.env.VOID_SERVER ?? "ws://localhost:8787";
const POW_DIFFICULTY = 18;

function log(...args: unknown[]) {
  console.log("[void]", ...args);
}

async function main() {
  let identity = await loadIdentity();
  const isFirstRun = !identity;

  if (!identity) {
    identity = newIdentity();
    log("generated new identity:", toHex(identity.keypair.publicKey).slice(0, 16) + "...");
  }

  const handleRequest = isFirstRun ? suggestHandle() : undefined;
  let powField: { nonce: string; difficulty: number } | undefined;

  if (isFirstRun) {
    log(`requesting handle: @${handleRequest}`);
    log(`computing proof of work (difficulty ${POW_DIFFICULTY})...`);
    const t0 = performance.now();
    const pow = computePow(identity.keypair.publicKey, POW_DIFFICULTY);
    log(`PoW done in ${Math.round(performance.now() - t0)}ms`);
    powField = { nonce: pow.nonce, difficulty: POW_DIFFICULTY };
  }

  const connectMsg = {
    v: PROTOCOL_VERSION as const,
    type: "CONNECT" as const,
    pubkey: toHex(identity.keypair.publicKey),
    client_version: "0.1.0",
    handle_request: handleRequest,
    pow: powField,
    t: Date.now(),
  };
  const signature = signMessage(identity.keypair.privateKey, connectMsg);

  const ws = new WebSocket(SERVER_URL);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });

  log("connected to", SERVER_URL);
  ws.send(JSON.stringify({ ...connectMsg, signature }));

  let confirmed = false;
  let stayOpen = true;

  ws.onmessage = (ev) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    const result = ServerMessage.safeParse(parsed);
    if (!result.success) {
      log("malformed server message:", parsed);
      return;
    }
    const msg = result.data;

    switch (msg.type) {
      case "CONNECTED": {
        log(`registered as @${msg.handle} (${msg.active_count} in the void)`);
        log(`recent posts: ${msg.recent_posts.length}`);
        identity!.handle = msg.handle;
        saveIdentity(identity!).catch((e) => log("save identity error:", e));
        confirmed = true;
        sendTestPost();
        break;
      }
      case "CONNECT_REJECTED": {
        log(`connect rejected: ${msg.reason} — ${msg.message}`);
        stayOpen = false;
        ws.close();
        break;
      }
      case "PROTOCOL_MISMATCH": {
        log(`protocol mismatch. server supports: ${msg.server_supports.join(", ")}`);
        stayOpen = false;
        ws.close();
        break;
      }
      case "POST_OK": {
        log(`post accepted (id=${msg.server_id.slice(0, 8)}...)`);
        break;
      }
      case "POST_REJECTED": {
        log(`post rejected: ${msg.reason} — ${msg.message}`);
        break;
      }
      case "BROADCAST": {
        const prefix = msg.ghost ? "~" : `@${msg.handle}`;
        log(`<broadcast> ${prefix}: ${msg.body}`);
        break;
      }
      case "ACTIVE_COUNT": {
        log(`active count: ${msg.count}`);
        break;
      }
      case "PONG":
        break;
      case "ERROR": {
        log(`server error: ${msg.code} — ${msg.message}`);
        break;
      }
    }
  };

  function sendTestPost() {
    if (!confirmed) return;
    const clientId = ulid();
    const post = {
      v: PROTOCOL_VERSION as const,
      type: "POST" as const,
      client_id: clientId,
      pubkey: toHex(identity!.keypair.publicKey),
      body: `hello void from @${identity!.handle ?? "?"} at ${new Date().toISOString()}`,
      ghost: false,
      t: Date.now(),
    };
    const sig = signMessage(identity!.keypair.privateKey, post);
    ws.send(JSON.stringify({ ...post, signature: sig }));
    log("sent test post");
  }

  ws.onclose = () => {
    log("disconnected");
    if (stayOpen) process.exit(0);
  };

  // Stay open briefly to observe broadcasts, then exit
  setTimeout(() => {
    log("scaffold complete, closing");
    ws.close();
  }, 10_000);

  log(`identity stored at ${identityPath()}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
