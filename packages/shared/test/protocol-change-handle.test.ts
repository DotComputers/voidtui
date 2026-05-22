import { describe, expect, test } from "bun:test";
import {
  ChangeHandleMessage,
  ChangeHandleRejectedMessage,
  type ChangeHandleRejectReason,
  HandleChangedMessage,
  ClientMessage,
  ServerMessage,
} from "../src/protocol.ts";

describe("CHANGE_HANDLE message", () => {
  const valid = {
    v: 1,
    type: "CHANGE_HANDLE",
    pubkey: "a".repeat(64),
    handle_request: "newhandle",
    pow: { nonce: "deadbeef", difficulty: 18 },
    t: 1716240000000,
    signature: "b".repeat(128),
  };

  test("accepts a well-formed message", () => {
    expect(ChangeHandleMessage.safeParse(valid).success).toBe(true);
  });

  test("rejects invalid handle format", () => {
    const bad = { ...valid, handle_request: "Invalid Handle" };
    expect(ChangeHandleMessage.safeParse(bad).success).toBe(false);
  });

  test("rejects missing pow", () => {
    const { pow: _pow, ...bad } = valid;
    expect(ChangeHandleMessage.safeParse(bad).success).toBe(false);
  });

  test("is in the ClientMessage discriminated union", () => {
    expect(ClientMessage.safeParse(valid).success).toBe(true);
  });
});

describe("HANDLE_CHANGED message", () => {
  const valid = {
    v: 1,
    type: "HANDLE_CHANGED",
    handle: "newhandle",
    changed_at: 1716240000123,
  };

  test("accepts a well-formed message", () => {
    expect(HandleChangedMessage.safeParse(valid).success).toBe(true);
  });

  test("is in the ServerMessage discriminated union", () => {
    expect(ServerMessage.safeParse(valid).success).toBe(true);
  });
});

describe("CHANGE_HANDLE_REJECTED message", () => {
  const valid = {
    v: 1,
    type: "CHANGE_HANDLE_REJECTED",
    reason: "handle_taken",
    message: "taken",
  };

  test("accepts each known rejection reason", () => {
    const reasons: ChangeHandleRejectReason[] = [
      "handle_taken",
      "handle_invalid",
      "invalid_pow",
      "invalid_signature",
      "stale_timestamp",
      "cooldown_active",
      "recent_post",
      "not_registered",
      "bad_request",
    ];
    for (const r of reasons) {
      expect(
        ChangeHandleRejectedMessage.safeParse({ ...valid, reason: r }).success,
      ).toBe(true);
    }
  });

  test("accepts optional retry_after", () => {
    const withRetry = { ...valid, reason: "cooldown_active", retry_after: 1716240000000 };
    expect(ChangeHandleRejectedMessage.safeParse(withRetry).success).toBe(true);
  });

  test("rejects unknown reason", () => {
    const bad = { ...valid, reason: "made_up" };
    expect(ChangeHandleRejectedMessage.safeParse(bad).success).toBe(false);
  });
});
