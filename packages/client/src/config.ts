import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { ACCENT_PALETTE } from "./colors.ts";

const VOID_DIR = (): string =>
  process.env.VOID_HOME ?? join(homedir(), ".config", "void");
const CONFIG_PATH = (): string => join(VOID_DIR(), "config.json");

/**
 * Theme controls how the void surface adapts to the terminal background.
 *   "auto"  — detect via OSC 11 query at startup; fall back to dark.
 *   "dark"  — force dark theme (white-on-black, light stars).
 *   "light" — force light theme (dark-on-light, dark stars).
 *
 * Takes effect on next launch (the colors are baked into the renderables at
 * scene initialization; live switching would require re-creating them).
 */
const ConfigSchema = z.object({
  accent_color: z.enum(
    Object.keys(ACCENT_PALETTE) as [keyof typeof ACCENT_PALETTE],
  ),
  theme: z.enum(["auto", "dark", "light"]).default("auto"),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULTS: Config = {
  accent_color: "cyan",
  theme: "auto",
};

export async function loadConfig(): Promise<Config> {
  const path = CONFIG_PATH();
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    await saveConfig(DEFAULTS);
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[void] config.json is not valid JSON — using defaults`);
    return { ...DEFAULTS };
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[void] config.json failed validation — using defaults`);
    return { ...DEFAULTS };
  }
  return result.data;
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(VOID_DIR(), { recursive: true });
  await Bun.write(CONFIG_PATH(), JSON.stringify(cfg, null, 2));
}

export function configPath(): string {
  return CONFIG_PATH();
}
