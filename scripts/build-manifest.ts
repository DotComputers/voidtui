#!/usr/bin/env bun
/**
 * Generate release/latest.json and release/latest.sh from build inputs.
 *
 * Usage (from CI after building all 4 binaries):
 *   bun scripts/build-manifest.ts \
 *     --version 0.1.1 \
 *     --released-at 2026-05-22T12:34:56Z \
 *     --notes-url https://github.com/.../releases/tag/v0.1.1 \
 *     --platform darwin-arm64 --url URL --sha SHA --size N \
 *     --platform darwin-x64   --url URL --sha SHA --size N \
 *     --platform linux-arm64  --url URL --sha SHA --size N \
 *     --platform linux-x64    --url URL --sha SHA --size N \
 *     --out-json ./latest.json \
 *     --out-sh   ./latest.sh
 */
import { writeFile } from "node:fs/promises";

type Platform = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

type PlatformEntry = { url: string; sha256: string; size: number };

function parseArgs(argv: string[]): {
  version: string;
  releasedAt: string;
  notesUrl: string;
  platforms: Partial<Record<Platform, PlatformEntry>>;
  outJson: string;
  outSh: string;
} {
  const platforms: Partial<Record<Platform, PlatformEntry>> = {};
  let version = "";
  let releasedAt = "";
  let notesUrl = "";
  let outJson = "";
  let outSh = "";
  let currentPlatform: Platform | null = null;
  let currentUrl = "";
  let currentSha = "";
  let currentSize = 0;

  const flushPlatform = (): void => {
    if (!currentPlatform) return;
    platforms[currentPlatform] = {
      url: currentUrl,
      sha256: currentSha,
      size: currentSize,
    };
    currentPlatform = null;
    currentUrl = "";
    currentSha = "";
    currentSize = 0;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1] ?? "";
    switch (flag) {
      case "--version":      version = value;    i++; break;
      case "--released-at":  releasedAt = value; i++; break;
      case "--notes-url":    notesUrl = value;   i++; break;
      case "--out-json":     outJson = value;    i++; break;
      case "--out-sh":       outSh = value;      i++; break;
      case "--platform":
        flushPlatform();
        currentPlatform = value as Platform;
        i++;
        break;
      case "--url":   currentUrl = value;          i++; break;
      case "--sha":   currentSha = value;          i++; break;
      case "--size":  currentSize = Number(value); i++; break;
    }
  }
  flushPlatform();

  // v0.1: darwin-x64 omitted. Schema still accepts it; just not required.
  const required: Platform[] = ["darwin-arm64", "linux-arm64", "linux-x64"];
  for (const p of required) {
    if (!platforms[p]) throw new Error(`missing --platform ${p}`);
  }
  if (!version || !releasedAt || !notesUrl || !outJson || !outSh) {
    throw new Error("missing required flags: --version, --released-at, --notes-url, --out-json, --out-sh");
  }

  return {
    version,
    releasedAt,
    notesUrl,
    platforms: platforms as Partial<Record<Platform, PlatformEntry>>,
    outJson,
    outSh,
  };
}

function buildJson(a: ReturnType<typeof parseArgs>): string {
  return JSON.stringify(
    {
      version: a.version,
      released_at: a.releasedAt,
      min_protocol: 1,
      platforms: a.platforms,
      notes_url: a.notesUrl,
    },
    null,
    2,
  );
}

function buildSh(a: ReturnType<typeof parseArgs>): string {
  const lines: string[] = [`VOID_VERSION="${a.version}"`];
  for (const [key, entry] of Object.entries(a.platforms)) {
    const macro = key.replace("-", "_").toUpperCase();
    lines.push(`VOID_${macro}_URL="${entry.url}"`);
    lines.push(`VOID_${macro}_SHA="${entry.sha256}"`);
  }
  return lines.join("\n") + "\n";
}

const args = parseArgs(process.argv.slice(2));
await writeFile(args.outJson, buildJson(args), "utf-8");
await writeFile(args.outSh, buildSh(args), "utf-8");
console.log(`wrote ${args.outJson} and ${args.outSh}`);
