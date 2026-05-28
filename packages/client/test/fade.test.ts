import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { lerpRgba } from "../src/fade.ts";

describe("lerpRgba", () => {
  test("t=0 returns the from color", () => {
    const from = RGBA.fromValues(0.1, 0.2, 0.3, 0.4);
    const to = RGBA.fromValues(0.9, 0.8, 0.7, 0.6);
    const result = lerpRgba(from, to, 0);
    expect(result.toInts()).toEqual(from.toInts());
  });

  test("t=1 returns the to color", () => {
    const from = RGBA.fromValues(0.1, 0.2, 0.3, 0.4);
    const to = RGBA.fromValues(0.9, 0.8, 0.7, 0.6);
    const result = lerpRgba(from, to, 1);
    expect(result.toInts()).toEqual(to.toInts());
  });

  test("t=0.5 returns the midpoint", () => {
    const from = RGBA.fromValues(0, 0, 0, 1);
    const to = RGBA.fromValues(1, 1, 1, 1);
    const result = lerpRgba(from, to, 0.5);
    const [r, g, b, a] = result.toInts();
    expect(r).toBeGreaterThanOrEqual(127);
    expect(r).toBeLessThanOrEqual(128);
    expect(g).toBeGreaterThanOrEqual(127);
    expect(g).toBeLessThanOrEqual(128);
    expect(b).toBeGreaterThanOrEqual(127);
    expect(b).toBeLessThanOrEqual(128);
    expect(a).toBe(255);
  });

  test("clamps t below 0 to 0", () => {
    const from = RGBA.fromValues(0.2, 0.2, 0.2, 1);
    const to = RGBA.fromValues(0.8, 0.8, 0.8, 1);
    const result = lerpRgba(from, to, -0.5);
    expect(result.toInts()).toEqual(from.toInts());
  });

  test("clamps t above 1 to 1", () => {
    const from = RGBA.fromValues(0.2, 0.2, 0.2, 1);
    const to = RGBA.fromValues(0.8, 0.8, 0.8, 1);
    const result = lerpRgba(from, to, 2);
    expect(result.toInts()).toEqual(to.toInts());
  });

  test("lerps alpha channel too", () => {
    const from = RGBA.fromValues(0.5, 0.5, 0.5, 0);
    const to = RGBA.fromValues(0.5, 0.5, 0.5, 1);
    const result = lerpRgba(from, to, 0.5);
    const [, , , a] = result.toInts();
    expect(a).toBeGreaterThanOrEqual(127);
    expect(a).toBeLessThanOrEqual(128);
  });

  test("from black to white at t=0.25 is approximately quarter-grey", () => {
    const black = RGBA.fromHex("#000000");
    const white = RGBA.fromHex("#ffffff");
    const result = lerpRgba(black, white, 0.25);
    const [r, g, b] = result.toInts();
    expect(r).toBeGreaterThanOrEqual(63);
    expect(r).toBeLessThanOrEqual(64);
    expect(g).toBe(r);
    expect(b).toBe(r);
  });
});
