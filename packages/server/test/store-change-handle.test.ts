import { describe, expect, test } from "bun:test";

process.env.VOID_DB = ":memory:";

const {
  getIdentityWithTimestamps,
  recordPostAt,
  registerIdentity,
  tryUpdateHandle,
} = await import("../src/store.ts");

describe("identities timestamps", () => {
  test("registerIdentity yields null timestamps initially", () => {
    const pk = "a".repeat(64);
    registerIdentity(pk, `hndl1a`);
    const id = getIdentityWithTimestamps(pk)!;
    expect(id.last_post_at).toBeNull();
    expect(id.last_handle_change_at).toBeNull();
  });

  test("recordPostAt sets last_post_at", () => {
    const pk = "b".repeat(64);
    registerIdentity(pk, `hndl1b`);
    recordPostAt(pk, 1234567);
    expect(getIdentityWithTimestamps(pk)!.last_post_at).toBe(1234567);
  });

  test("tryUpdateHandle succeeds when target is free", () => {
    const pk = "c".repeat(64);
    registerIdentity(pk, "oldname1");
    const result = tryUpdateHandle(pk, "newname1", 999);
    expect(result.ok).toBe(true);
    const id = getIdentityWithTimestamps(pk)!;
    expect(id.handle).toBe("newname1");
    expect(id.last_handle_change_at).toBe(999);
  });

  test("tryUpdateHandle fails when target is taken", () => {
    const pk1 = "d".repeat(64);
    const pk2 = "e".repeat(64);
    registerIdentity(pk1, "owner-tgt2");
    registerIdentity(pk2, "wants-tgt2");
    const result = tryUpdateHandle(pk2, "owner-tgt2", 1000);
    expect(result.ok).toBe(false);
    expect(getIdentityWithTimestamps(pk2)!.handle).toBe("wants-tgt2");
  });

  test("tryUpdateHandle returns ok=false for unknown pubkey", () => {
    const result = tryUpdateHandle("f".repeat(64), "whatever", 1);
    expect(result.ok).toBe(false);
  });
});
