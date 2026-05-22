/**
 * Auto-update flow.
 *
 * On startup we fetch the latest manifest from the Jetson, and if it points to
 * a newer version than the embedded CLIENT_VERSION, we silently download +
 * verify + atomic-rename the new binary over our own location. The current
 * process keeps running on the old inode; next launch picks up the new file.
 *
 * All failure paths are non-fatal: a failed update never breaks a running void.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareSemver } from "./version.ts";

export type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

export type Manifest = {
  version: string;
  released_at: string;
  min_protocol: number;
  platforms: Partial<Record<PlatformKey, { url: string; sha256: string; size: number }>>;
  notes_url: string;
};

const FETCH_TIMEOUT_MS = 3_000;

/** Fetch + parse the manifest. Throws on network error, non-200, malformed JSON, or missing fields. */
export async function fetchManifest(url: string): Promise<Manifest> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const text = await res.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("manifest is not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string") throw new Error("manifest missing version");
  if (typeof r.released_at !== "string") throw new Error("manifest missing released_at");
  if (typeof r.platforms !== "object" || r.platforms === null) throw new Error("manifest missing platforms");
  return r as unknown as Manifest;
}

/** Download URL to `outPath`, verify SHA256 hex. Removes file and throws on mismatch. */
export async function downloadAndVerify(url: string, expectedSha256Hex: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  if (!res.body) throw new Error("download had no body");

  const hash = createHash("sha256");
  const writer = Bun.file(outPath).writer();
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      writer.write(value);
    }
    await writer.end();
  } catch (e) {
    await writer.end();
    await safeUnlink(outPath);
    throw e;
  }

  const actual = hash.digest("hex");
  if (actual !== expectedSha256Hex) {
    await safeUnlink(outPath);
    throw new Error(`sha256 mismatch: expected ${expectedSha256Hex}, got ${actual}`);
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort
  }
}

/**
 * Extract a single file from a gzipped tar archive.
 *
 * Uses the system `tar` (present on macOS + Linux). `member` is the entry name
 * inside the archive (e.g. "void"). `outPath` is where the extracted file
 * should end up. Throws on tar failure.
 */
export async function extractTarGzMember(
  archivePath: string,
  member: string,
  outPath: string,
): Promise<void> {
  const targetDir = dirname(outPath);
  await mkdir(targetDir, { recursive: true });

  const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", targetDir, member], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar extract failed (${exitCode}): ${err.trim()}`);
  }

  const extractedPath = join(targetDir, member);
  if (extractedPath !== outPath) {
    await rename(extractedPath, outPath);
  }
}

/**
 * Make `freshPath` executable, then atomically rename it over `targetPath`.
 *
 * On Unix this is safe even if `targetPath` is the currently-executing binary:
 * the kernel keeps the running process's inode alive after the rename.
 * Next process launch from that path picks up the new file.
 *
 * `freshPath` and `targetPath` must be on the same filesystem (typical: both
 * inside the user's home dir).
 */
export async function atomicSwap(freshPath: string, targetPath: string): Promise<void> {
  await chmod(freshPath, 0o755);
  await rename(freshPath, targetPath);
}

export type UpdateResult =
  | { kind: "already-current" }
  | { kind: "unsupported-platform" }
  | { kind: "installed"; newVersion: string }
  | { kind: "failed"; reason: string }
  /**
   * Refused to update because the running process doesn't look like a
   * compiled void binary. Set when launched via `bun run` from source or
   * when `execPath` doesn't end in `/void`. This guard prevents a serious
   * bug where the updater would atomic-rename a downloaded void binary
   * over the bun binary that's currently executing the source. See
   * project-void-updater-source-run-guard memory for the discovery story.
   */
  | { kind: "refused"; reason: "from-source" | "wrong-execpath" };

export type UpdateProgress =
  | { phase: "fetching-manifest" }
  | { phase: "downloading"; size: number }
  | { phase: "verifying" }
  | { phase: "installing" }
  | { phase: "done"; newVersion: string }
  | { phase: "failed"; reason: string };

export type UpdateOptions = {
  manifestUrl: string;
  currentVersion: string;
  execPath: string;
  platform: PlatformKey;
  /** Override staging directory (defaults to `<dirname execPath>/.void-updates`). */
  stagingDir?: string;
  /** Inject a custom manifest provider (for tests). */
  provideManifest?: (url: string) => Promise<Manifest>;
  /** Progress callback for the UI (optional). */
  onProgress?: (p: UpdateProgress) => void;
};

export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const provideManifest = opts.provideManifest ?? fetchManifest;

  // Refuse to update when running from source (bun run): currentVersion is the
  // "0.0.0-dev" sentinel AND execPath points at bun, not void. Without this
  // check, the atomic-rename would clobber the user's bun binary.
  if (opts.currentVersion === "0.0.0-dev") {
    return { kind: "refused", reason: "from-source" };
  }
  // Defense-in-depth: even with a real version baked in, only rewrite paths
  // that actually end in /void (or the Windows variant). Catches the case
  // where a compiled void binary was copied somewhere weird.
  if (
    !opts.execPath.endsWith("/void") &&
    !opts.execPath.endsWith("\\void.exe")
  ) {
    return { kind: "refused", reason: "wrong-execpath" };
  }

  try {
    onProgress({ phase: "fetching-manifest" });
    const manifest = await provideManifest(opts.manifestUrl);

    if (compareSemver(manifest.version, opts.currentVersion) <= 0) {
      return { kind: "already-current" };
    }
    const entry = manifest.platforms[opts.platform];
    if (!entry) return { kind: "unsupported-platform" };

    const stagingDir = opts.stagingDir ?? join(opts.execPath, "..", ".void-updates");
    await mkdir(stagingDir, { recursive: true });
    const archivePath = join(stagingDir, `void-${manifest.version}.tar.gz`);
    const freshPath = join(stagingDir, `void-${manifest.version}.new`);

    onProgress({ phase: "downloading", size: entry.size });
    await downloadAndVerify(entry.url, entry.sha256, archivePath);
    onProgress({ phase: "verifying" });

    // The release artifact is a `.tar.gz` containing a single file named `void`.
    // We verified the archive's SHA against the manifest above; now extract.
    await extractTarGzMember(archivePath, "void", freshPath);
    // Best-effort cleanup of the archive (the extracted binary is what we keep).
    await safeUnlink(archivePath);

    onProgress({ phase: "installing" });
    await atomicSwap(freshPath, opts.execPath);

    onProgress({ phase: "done", newVersion: manifest.version });
    return { kind: "installed", newVersion: manifest.version };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    onProgress({ phase: "failed", reason });
    return { kind: "failed", reason };
  }
}

/**
 * Compute the platform key for the running process, or null if unsupported.
 * Maps Bun's `process.platform` + `process.arch` to our manifest keys.
 */
export function detectPlatform(): PlatformKey | null {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64") return "darwin-x64";
  if (p === "linux" && a === "arm64") return "linux-arm64";
  if (p === "linux" && a === "x64") return "linux-x64";
  return null;
}
