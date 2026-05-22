import { describe, expect, test } from "bun:test";
import { CLIENT_VERSION, compareSemver } from "../src/version.ts";

describe("CLIENT_VERSION", () => {
  test("is a non-empty string", () => {
    expect(typeof CLIENT_VERSION).toBe("string");
    expect(CLIENT_VERSION.length).toBeGreaterThan(0);
  });

  test("looks like a semver or 0.0.0-dev fallback", () => {
    expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/);
  });
});

describe("compareSemver", () => {
  test("returns negative when a < b", () => {
    expect(compareSemver("0.1.0", "0.1.1")).toBeLessThan(0);
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareSemver("0.1.0", "1.0.0")).toBeLessThan(0);
  });

  test("returns positive when a > b", () => {
    expect(compareSemver("0.1.1", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  test("returns zero when equal", () => {
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  });

  test("ignores -dev / prerelease suffixes (treat as equal to base)", () => {
    expect(compareSemver("0.1.0-dev", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0-rc.1", "0.1.0")).toBe(0);
  });

  test("handles 2-segment versions defensively (treats missing patch as 0)", () => {
    expect(compareSemver("0.1", "0.1.0")).toBe(0);
  });
});
