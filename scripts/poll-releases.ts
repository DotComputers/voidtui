#!/usr/bin/env bun
/**
 * Polls GitHub Releases for the configured voidtui repo and regenerates
 * the local release manifest (latest.json + latest.sh) whenever a new
 * release is detected.
 *
 * Runs as a long-lived process; intended to be supervised by systemd on
 * the Jetson. The server (which serves /release/latest.json) reads the
 * manifest files this script writes — they share the VOID_RELEASE_DIR.
 *
 * Configuration via env vars:
 *   VOID_GH_REPO       e.g. "DotComputers/voidtui" (required)
 *   VOID_RELEASE_DIR   where to write manifest files (default: ./release)
 *   VOID_POLL_INTERVAL polling interval in ms (default: 90000 = 90s)
 *
 * Rate-limit note: unauthenticated GitHub REST API allows 60 req/hr per
 * IP. 90s polling = 40 req/hr. Safe.
 */
import { writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

type Platform = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
type PlatformEntry = { url: string; sha256: string; size: number };

const REPO = process.env.VOID_GH_REPO;
const RELEASE_DIR = process.env.VOID_RELEASE_DIR ?? "./release";
const INTERVAL_MS = Number(process.env.VOID_POLL_INTERVAL ?? 90_000);

if (!REPO) {
  console.error("VOID_GH_REPO not set (expected e.g. DotComputers/voidtui)");
  process.exit(1);
}

const ASSET_NAMES: Record<Platform, string> = {
  "darwin-arm64": "void-darwin-arm64.tar.gz",
  "darwin-x64":   "void-darwin-x64.tar.gz",
  "linux-arm64":  "void-linux-arm64.tar.gz",
  "linux-x64":    "void-linux-x64.tar.gz",
};

let lastSeenTag: string | null = null;

async function fetchLatestRelease(): Promise<{
  tag: string;
  version: string;
  publishedAt: string;
  assets: Array<{ name: string; url: string; size: number }>;
  htmlUrl: string;
} | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    tag_name: string;
    published_at: string;
    html_url: string;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
  };
  return {
    tag: data.tag_name,
    version: data.tag_name.replace(/^v/, ""),
    publishedAt: data.published_at,
    htmlUrl: data.html_url,
    assets: data.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  };
}

async function fetchChecksums(assetUrl: string): Promise<Record<string, string>> {
  const res = await fetch(assetUrl);
  if (!res.ok) throw new Error(`fetch checksums ${assetUrl}: ${res.status}`);
  const body = await res.text();
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, file] = trimmed.split(/\s+/);
    if (hash && file) out[file] = hash;
  }
  return out;
}

function buildJson(args: {
  version: string;
  releasedAt: string;
  notesUrl: string;
  platforms: Record<Platform, PlatformEntry>;
}): string {
  return JSON.stringify(
    {
      version: args.version,
      released_at: args.releasedAt,
      min_protocol: 1,
      platforms: args.platforms,
      notes_url: args.notesUrl,
    },
    null,
    2,
  );
}

function buildSh(args: {
  version: string;
  platforms: Record<Platform, PlatformEntry>;
}): string {
  const lines: string[] = [`VOID_VERSION="${args.version}"`];
  for (const [key, entry] of Object.entries(args.platforms)) {
    const macro = key.replace("-", "_").toUpperCase();
    lines.push(`VOID_${macro}_URL="${entry.url}"`);
    lines.push(`VOID_${macro}_SHA="${entry.sha256}"`);
  }
  return lines.join("\n") + "\n";
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

async function refreshManifest(): Promise<void> {
  const release = await fetchLatestRelease();
  if (!release) return; // no releases yet

  if (release.tag === lastSeenTag) return; // unchanged

  const checksumsAsset = release.assets.find((a) => a.name === "checksums.txt");
  if (!checksumsAsset) {
    console.warn(`release ${release.tag} has no checksums.txt — skipping`);
    return;
  }
  const checksums = await fetchChecksums(checksumsAsset.url);

  const platforms: Partial<Record<Platform, PlatformEntry>> = {};
  for (const [plat, filename] of Object.entries(ASSET_NAMES) as Array<[Platform, string]>) {
    const asset = release.assets.find((a) => a.name === filename);
    const sha = checksums[filename];
    if (!asset || !sha) {
      console.warn(`release ${release.tag} missing ${filename} or its checksum — skipping`);
      return;
    }
    platforms[plat] = { url: asset.url, sha256: sha, size: asset.size };
  }

  await mkdir(RELEASE_DIR, { recursive: true });
  const json = buildJson({
    version: release.version,
    releasedAt: release.publishedAt,
    notesUrl: release.htmlUrl,
    platforms: platforms as Record<Platform, PlatformEntry>,
  });
  const sh = buildSh({
    version: release.version,
    platforms: platforms as Record<Platform, PlatformEntry>,
  });
  await writeAtomically(join(RELEASE_DIR, "latest.json"), json);
  await writeAtomically(join(RELEASE_DIR, "latest.sh"), sh);
  console.log(`[poll-releases] manifest refreshed to ${release.tag}`);
  lastSeenTag = release.tag;
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await refreshManifest();
    } catch (e) {
      console.error(`[poll-releases] refresh failed: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

console.log(`[poll-releases] watching ${REPO} every ${INTERVAL_MS / 1000}s, writing to ${RELEASE_DIR}`);
await loop();
