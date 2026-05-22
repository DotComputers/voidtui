import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config.ts", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "void-config-test-"));
    originalHome = process.env.VOID_HOME;
    process.env.VOID_HOME = tmp;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.VOID_HOME;
    else process.env.VOID_HOME = originalHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("loadConfig writes defaults when file is missing", async () => {
    const { loadConfig } = await import("../src/config.ts?fresh=" + Math.random());
    const cfg = await loadConfig();
    expect(cfg.accent_color).toBe("cyan");
    const raw = await Bun.file(join(tmp, "config.json")).text();
    expect(JSON.parse(raw)).toEqual({ accent_color: "cyan" });
  });

  test("loadConfig returns defaults on malformed file", async () => {
    await writeFile(join(tmp, "config.json"), "not json", "utf8");
    const { loadConfig } = await import("../src/config.ts?fresh=" + Math.random());
    const cfg = await loadConfig();
    expect(cfg.accent_color).toBe("cyan");
  });

  test("saveConfig + loadConfig round trip", async () => {
    const { loadConfig, saveConfig } = await import(
      "../src/config.ts?fresh=" + Math.random()
    );
    await saveConfig({ accent_color: "amber" });
    const cfg = await loadConfig();
    expect(cfg.accent_color).toBe("amber");
  });
});
