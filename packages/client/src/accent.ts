import { ACCENT_PALETTE, type AccentName } from "./colors.ts";
import { loadConfig, saveConfig } from "./config.ts";

let current: AccentName = "cyan";
const subscribers = new Set<(name: AccentName) => void>();

export function getAccent(): AccentName {
  return current;
}

export function getAccentHex(): string {
  return ACCENT_PALETTE[current];
}

export function setAccent(name: AccentName): void {
  if (current === name) return;
  current = name;
  for (const fn of subscribers) fn(name);
}

export function subscribeAccent(fn: (name: AccentName) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Read accent_color from config.json and apply it. Called once at startup. */
export async function initAccentFromConfig(): Promise<void> {
  const cfg = await loadConfig();
  setAccent(cfg.accent_color);
}

/** Persist the current accent to config.json. */
export async function saveAccent(): Promise<void> {
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, accent_color: current });
}
