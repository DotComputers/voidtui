import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  generateKeypair,
  toHex,
  signMessage,
  computePow,
} from "@void/shared";

process.env.VOID_DB = ":memory:";
process.env.VOID_TEST_MODE = "1";

const { registerIdentity, recordPostAt, getIdentityByPubkey } = await import(
  "../src/store.ts"
);
const { __test_handleMessage } = await import("../src/index.ts");

type FakeSock = {
  sent: string[];
  closed: boolean;
  data: {
    pubkeyHex: string | null;
    handle: string | null;
    banned: boolean;
    lastPingAt: number;
  };
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

function buildChangeHandle(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  newHandle: string,
  difficulty = 18,
): unknown {
  const pow = computePow(publicKey, difficulty);
  const msg = {
    v: PROTOCOL_VERSION as const,
    type: "CHANGE_HANDLE" as const,
    pubkey: toHex(publicKey),
    handle_request: newHandle,
    pow: { nonce: pow.nonce, difficulty },
    t: Date.now(),
  };
  return { ...msg, signature: signMessage(privateKey, msg) };
}

function lastResponse(sock: FakeSock): { type: string; reason?: string } {
  const raw = sock.sent[sock.sent.length - 1]!;
  return JSON.parse(raw);
}

describe("CHANGE_HANDLE handler", () => {
  test("rejects unauthenticated socket as not_registered", () => {
    const kp = generateKeypair();
    const msg = buildChangeHandle(kp.privateKey, kp.publicKey, "newhandle");
    const sock = makeSock(null, null);
    __test_handleMessage(sock as unknown as never, JSON.stringify(msg));
    const r = lastResponse(sock);
    expect(r.type).toBe("CHANGE_HANDLE_REJECTED");
    expect(r.reason).toBe("not_registered");
  });

  test("succeeds when cooldowns clear and target free", () => {
    const kp = generateKeypair();
    const pk = toHex(kp.publicKey);
    registerIdentity(pk, "alpha-tst1");
    const msg = buildChangeHandle(kp.privateKey, kp.publicKey, "beta-tst1");
    const sock = makeSock(pk, "alpha-tst1");
    __test_handleMessage(sock as unknown as never, JSON.stringify(msg));
    const r = lastResponse(sock);
    expect(r.type).toBe("HANDLE_CHANGED");
    expect(getIdentityByPubkey(pk)!.handle).toBe("beta-tst1");
  });

  test("rejects with handle_taken when target is occupied", () => {
    const kpA = generateKeypair();
    const kpB = generateKeypair();
    registerIdentity(toHex(kpA.publicKey), "target-tst2");
    registerIdentity(toHex(kpB.publicKey), "wants-tst2");
    const msg = buildChangeHandle(kpB.privateKey, kpB.publicKey, "target-tst2");
    const sock = makeSock(toHex(kpB.publicKey), "wants-tst2");
    __test_handleMessage(sock as unknown as never, JSON.stringify(msg));
    const r = lastResponse(sock);
    expect(r.type).toBe("CHANGE_HANDLE_REJECTED");
    expect(r.reason).toBe("handle_taken");
  });

  test("rejects with recent_post when posted within 24h", () => {
    const kp = generateKeypair();
    const pk = toHex(kp.publicKey);
    registerIdentity(pk, "alpha-tst3");
    recordPostAt(pk, Date.now() - 1000);
    const msg = buildChangeHandle(kp.privateKey, kp.publicKey, "beta-tst3");
    const sock = makeSock(pk, "alpha-tst3");
    __test_handleMessage(sock as unknown as never, JSON.stringify(msg));
    const r = lastResponse(sock);
    expect(r.type).toBe("CHANGE_HANDLE_REJECTED");
    expect(r.reason).toBe("recent_post");
  });

  test("rejects with invalid_pow when difficulty too low", () => {
    const kp = generateKeypair();
    const pk = toHex(kp.publicKey);
    registerIdentity(pk, "alpha-tst4");
    const msg = buildChangeHandle(kp.privateKey, kp.publicKey, "beta-tst4", 4);
    const sock = makeSock(pk, "alpha-tst4");
    __test_handleMessage(sock as unknown as never, JSON.stringify(msg));
    const r = lastResponse(sock);
    expect(r.type).toBe("CHANGE_HANDLE_REJECTED");
    expect(r.reason).toBe("invalid_pow");
  });
});
