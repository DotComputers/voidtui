import { describe, expect, test } from "bun:test";
import { ACCENT_PALETTE, ACCENT_NAMES, type AccentName } from "../src/colors.ts";

describe("ACCENT_PALETTE", () => {
  test("exposes 5 named accents", () => {
    expect(Object.keys(ACCENT_PALETTE).length).toBe(5);
  });

  test("includes cyan as the default", () => {
    expect(ACCENT_PALETTE.cyan).toBe("#22d3ee");
  });

  test("ACCENT_NAMES is a stable cycle order", () => {
    expect(ACCENT_NAMES).toEqual(["cyan", "amber", "magenta", "violet", "white"]);
  });

  test("AccentName type covers each entry", () => {
    const all: AccentName[] = ["cyan", "amber", "magenta", "violet", "white"];
    for (const name of all) {
      expect(ACCENT_PALETTE[name]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
