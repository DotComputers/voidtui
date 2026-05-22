import { describe, expect, test } from "bun:test";
import { parseOsc11 } from "../src/theme.ts";

describe("parseOsc11", () => {
  test("classic 4-hex-digit response: pure black is dark", () => {
    expect(parseOsc11("\x1b]11;rgb:0000/0000/0000\x07")).toBe("dark");
  });

  test("classic 4-hex-digit response: pure white is light", () => {
    expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("light");
  });

  test("mid-gray (about 0.5 luminance) → light (we err toward 'light')", () => {
    // r=g=b=0x8000 → ~0.5 of the way; just over the threshold
    expect(parseOsc11("\x1b]11;rgb:8000/8000/8000\x07")).toBe("light");
  });

  test("typical dark theme (~ #1a1b26, Tokyonight)", () => {
    expect(parseOsc11("\x1b]11;rgb:1a1a/1b1b/2626\x07")).toBe("dark");
  });

  test("typical light theme (~ #fafafa)", () => {
    expect(parseOsc11("\x1b]11;rgb:fafa/fafa/fafa\x07")).toBe("light");
  });

  test("8-bit (2 hex digits per channel)", () => {
    expect(parseOsc11("\x1b]11;rgb:00/00/00\x07")).toBe("dark");
    expect(parseOsc11("\x1b]11;rgb:ff/ff/ff\x07")).toBe("light");
  });

  test("ST terminator (ESC + backslash) instead of BEL", () => {
    expect(parseOsc11("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe("dark");
  });

  test("garbage input returns null", () => {
    expect(parseOsc11("hello world")).toBeNull();
    expect(parseOsc11("")).toBeNull();
    expect(parseOsc11("\x1b]11;not-rgb")).toBeNull();
  });

  test("primarily-green color: dark variant", () => {
    // Green has the highest luminance coefficient (0.7152), so a "green
    // background" is more biased toward light than the eye would naively
    // estimate. Pure mid-green should be light.
    expect(parseOsc11("\x1b]11;rgb:0000/ffff/0000\x07")).toBe("light");
  });
});
