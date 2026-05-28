import { describe, expect, test, beforeEach } from "bun:test";
import { PROTOCOL_VERSION, generateKeypair, toHex, signMessage } from "@void/shared";

process.env.VOID_DB = ":memory:";
process.env.VOID_TEST_MODE = "1";

const { registerIdentity, getRecentPosts, getModerationDrops } = await import("../src/store.ts");
const { setModelRunner, configureModeration } = await import("../src/moderation.ts");
const { __test_handleMessage, __test_connections } = await import("../src/index.ts");

type FakeSock = {
  sent: string[];
  closed: boolean;
  data: { pubkeyHex: string | null; handle: string | null; banned: boolean; lastPingAt: number };
  send: (s: string) => void;
  close: () => void;
};

function makeSock(pubkeyHex: string | null, handle: string | null): FakeSock {
  return {
    sent: [],
    closed: false,
    data: { pubkeyHex, handle, banned: false, lastPingAt: Date.now() },
    send(s) {
      this.sent.push(s);
    },
    close() {
      this.closed = true;
    },
  };
}

function buildPost(privateKey: Uint8Array, publicKey: Uint8Array, body: string, ghost = false): unknown {
  const msg = {
    v: PROTOCOL_VERSION as const,
    type: "POST" as const,
    client_id: "c" + Math.random().toString(36).slice(2),
    pubkey: toHex(publicKey),
    body,
    ghost,
    t: Date.now(),
  };
  return { ...msg, signature: signMessage(privateKey, msg) };
}

const types = (sock: FakeSock): string[] => sock.sent.map((s) => JSON.parse(s).type);

beforeEach(() => {
  configureModeration({ timeoutMs: 5000, maxConcurrent: 4 });
  setModelRunner(null);
  __test_connections.clear();
});

describe("handlePost moderation", () => {
  test("blocked post: acked, not broadcast, not in posts, logged with text", async () => {
    setModelRunner(async () => ({ threat: 0.99 }));
    const kp = generateKeypair();
    const pk = toHex(kp.publicKey);
    registerIdentity(pk, "poster-blk");
    const author = makeSock(pk, "poster-blk");
    const observer = makeSock("a".repeat(64), "obs-blk");
    __test_connections.add(author as never);
    __test_connections.add(observer as never);

    await __test_handleMessage(author, JSON.stringify(buildPost(kp.privateKey, kp.publicKey, "blocked-body-1")));

    expect(types(author)).toContain("POST_OK");
    expect(types(author)).not.toContain("POST_REJECTED");
    expect(observer.sent.length).toBe(0); // no BROADCAST
    expect(getRecentPosts(60_000, 50).some((p) => p.body === "blocked-body-1")).toBe(false);
    const drops = getModerationDrops().filter((d) => d.body === "blocked-body-1");
    expect(drops.length).toBe(1);
    expect(drops[0]!.category).toBe("threat");
  });

  test("allowed post: acked, broadcast to others, persisted, not logged", async () => {
    setModelRunner(async () => ({ toxic: 0.01 }));
    const kp = generateKeypair();
    const pk = toHex(kp.publicKey);
    registerIdentity(pk, "poster-ok");
    const author = makeSock(pk, "poster-ok");
    const observer = makeSock("b".repeat(64), "obs-ok");
    __test_connections.add(author as never);
    __test_connections.add(observer as never);

    await __test_handleMessage(author, JSON.stringify(buildPost(kp.privateKey, kp.publicKey, "allowed-body-1")));

    expect(types(author)).toContain("POST_OK");
    const bcast = observer.sent.map((s) => JSON.parse(s)).find((m) => m.type === "BROADCAST");
    expect(bcast).toBeDefined();
    expect(bcast.body).toBe("allowed-body-1");
    expect(getRecentPosts(60_000, 50).some((p) => p.body === "allowed-body-1")).toBe(true);
    expect(getModerationDrops().some((d) => d.body === "allowed-body-1")).toBe(false);
  });

  test("fail-open: when the model throws, the post is allowed + broadcast", async () => {
    setModelRunner(async () => {
      throw new Error("model down");
    });
    const kp = generateKeypair();
    const pk = toHex(kp.publicKey);
    registerIdentity(pk, "poster-fo");
    const author = makeSock(pk, "poster-fo");
    const observer = makeSock("c".repeat(64), "obs-fo");
    __test_connections.add(author as never);
    __test_connections.add(observer as never);

    await __test_handleMessage(author, JSON.stringify(buildPost(kp.privateKey, kp.publicKey, "failopen-body-1")));

    expect(observer.sent.map((s) => JSON.parse(s)).some((m) => m.type === "BROADCAST")).toBe(true);
    expect(getRecentPosts(60_000, 50).some((p) => p.body === "failopen-body-1")).toBe(true);
  });

  test("shadow-ban: banned user's post is acked but never persisted or broadcast", async () => {
    setModelRunner(async () => ({ toxic: 0.01 })); // would otherwise pass + broadcast
    const kp = generateKeypair();
    const pk = toHex(kp.publicKey);
    registerIdentity(pk, "banned-user");
    const author = makeSock(pk, "banned-user");
    author.data.banned = true;
    const observer = makeSock("d".repeat(64), "obs-ban");
    __test_connections.add(author as never);
    __test_connections.add(observer as never);

    await __test_handleMessage(author, JSON.stringify(buildPost(kp.privateKey, kp.publicKey, "banned-body-1")));

    expect(types(author)).toContain("POST_OK");
    expect(observer.sent.length).toBe(0);
    expect(getRecentPosts(60_000, 50).some((p) => p.body === "banned-body-1")).toBe(false);
  });
});
