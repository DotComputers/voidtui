import { describe, expect, test } from "bun:test";
import { getAccent, setAccent, subscribeAccent } from "../src/accent.ts";

describe("accent observable", () => {
  test("default value is cyan", () => {
    expect(getAccent()).toBe("cyan");
  });

  test("setAccent updates the value", () => {
    setAccent("amber");
    expect(getAccent()).toBe("amber");
    setAccent("cyan");
  });

  test("subscribe receives updates and unsubscribes cleanly", () => {
    const seen: string[] = [];
    const unsub = subscribeAccent((name) => seen.push(name));
    setAccent("violet");
    setAccent("magenta");
    unsub();
    setAccent("white");
    expect(seen).toEqual(["violet", "magenta"]);
    setAccent("cyan");
  });
});
