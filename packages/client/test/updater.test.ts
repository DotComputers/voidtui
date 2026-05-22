import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chmod, stat } from "node:fs/promises";
import {
  atomicSwap,
  downloadAndVerify,
  extractTarGzMember,
  fetchManifest,
  runUpdate,
  type Manifest,
} from "../src/updater.ts";

/**
 * Helper for tests that need an actual tar.gz served from a mock HTTP server.
 * Creates a tar.gz containing one file named `void` (or another given name)
 * holding the given content. Returns the tarball bytes + its SHA256.
 */
async function makeTarGz(content: string, workdir: string, memberName = "void"): Promise<{
  bytes: Uint8Array;
  sha256: string;
}> {
  const srcDir = await mkdtemp(join(workdir, "src-"));
  await Bun.write(join(srcDir, memberName), content);
  const tarPath = join(workdir, `${memberName}-${Math.random().toString(36).slice(2)}.tar.gz`);
  const proc = Bun.spawn(["tar", "-czf", tarPath, "-C", srcDir, memberName]);
  const code = await proc.exited;
  if (code !== 0) throw new Error("tar pack failed in test setup");
  const bytes = new Uint8Array(await Bun.file(tarPath).arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256: sha };
}

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/ok.json") {
        return Response.json({
          version: "0.1.1",
          released_at: "2026-05-22T00:00:00Z",
          min_protocol: 1,
          platforms: {
            "darwin-arm64": { url: "https://x", sha256: "a", size: 1 },
          },
          notes_url: "https://x",
        });
      }
      if (url.pathname === "/bad.json") return new Response("not json", { status: 200 });
      if (url.pathname === "/404") return new Response("missing", { status: 404 });
      return new Response("nope", { status: 500 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop();
});

describe("fetchManifest", () => {
  test("returns parsed manifest on 200 with valid JSON", async () => {
    const m: Manifest = await fetchManifest(`${baseUrl}/ok.json`);
    expect(m.version).toBe("0.1.1");
    expect(m.platforms["darwin-arm64"]?.url).toBe("https://x");
  });

  test("throws on 404", async () => {
    await expect(fetchManifest(`${baseUrl}/404`)).rejects.toThrow();
  });

  test("throws on non-JSON body", async () => {
    await expect(fetchManifest(`${baseUrl}/bad.json`)).rejects.toThrow();
  });

  test("throws on missing required fields", async () => {
    const s = Bun.serve({
      port: 0,
      fetch: () => Response.json({ released_at: "x" }),
    });
    try {
      await expect(fetchManifest(`http://localhost:${s.port}/`)).rejects.toThrow();
    } finally {
      s.stop();
    }
  });
});

describe("downloadAndVerify", () => {
  const PAYLOAD = "hello void";
  const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

  let dlServer: ReturnType<typeof Bun.serve>;
  let dlBase = "";
  let workdir = "";

  beforeAll(async () => {
    dlServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/ok.bin") {
          return new Response(PAYLOAD, { status: 200, headers: { "content-type": "application/octet-stream" } });
        }
        return new Response("no", { status: 404 });
      },
    });
    dlBase = `http://localhost:${dlServer.port}`;
    workdir = await mkdtemp(join(tmpdir(), "void-updater-test-"));
  });

  afterAll(async () => {
    dlServer?.stop();
    await rm(workdir, { recursive: true, force: true });
  });

  test("downloads + verifies a correct SHA256", async () => {
    const out = join(workdir, "ok.bin");
    await downloadAndVerify(`${dlBase}/ok.bin`, PAYLOAD_SHA, out);
    const content = await readFile(out, "utf-8");
    expect(content).toBe(PAYLOAD);
  });

  test("throws and removes file on SHA256 mismatch", async () => {
    const out = join(workdir, "bad.bin");
    await expect(downloadAndVerify(`${dlBase}/ok.bin`, "0".repeat(64), out)).rejects.toThrow(/sha256/);
    const file = Bun.file(out);
    expect(await file.exists()).toBe(false);
  });

  test("throws on 404", async () => {
    const out = join(workdir, "missing.bin");
    await expect(downloadAndVerify(`${dlBase}/missing`, PAYLOAD_SHA, out)).rejects.toThrow();
  });
});

describe("atomicSwap", () => {
  let workdir = "";
  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "void-updater-swap-"));
  });
  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  test("renames new file over target; target now has new content", async () => {
    const target = join(workdir, "void");
    const fresh = join(workdir, "void.new");
    await Bun.write(target, "OLD-CONTENT");
    await Bun.write(fresh, "NEW-CONTENT");

    await atomicSwap(fresh, target);

    const after = await Bun.file(target).text();
    expect(after).toBe("NEW-CONTENT");
    expect(await Bun.file(fresh).exists()).toBe(false);
  });

  test("makes the target executable (mode includes 0o100)", async () => {
    const target = join(workdir, "void2");
    const fresh = join(workdir, "void2.new");
    await Bun.write(target, "OLD");
    await Bun.write(fresh, "NEW");
    await chmod(fresh, 0o644);

    await atomicSwap(fresh, target);
    const st = await stat(target);
    expect(st.mode & 0o100).toBe(0o100);
  });

  test("throws when target is in a non-existent directory", async () => {
    const fresh = join(workdir, "to-nowhere.new");
    await Bun.write(fresh, "x");
    await expect(atomicSwap(fresh, "/nonexistent/dir/void")).rejects.toThrow();
  });
});

describe("runUpdate", () => {
  test("no-op when current version >= manifest version", async () => {
    const result = await runUpdate({
      manifestUrl: "x",
      currentVersion: "0.1.99",
      execPath: "/tmp/void-fake",
      platform: "darwin-arm64",
      provideManifest: async () => ({
        version: "0.1.99",
        released_at: "x",
        min_protocol: 1,
        platforms: {
          "darwin-arm64": { url: "x", sha256: "x", size: 0 },
        },
        notes_url: "x",
      }),
    });
    expect(result.kind).toBe("already-current");
  });

  test("returns 'unsupported-platform' when manifest doesn't list our platform", async () => {
    const result = await runUpdate({
      manifestUrl: "x",
      currentVersion: "0.1.0",
      execPath: "/tmp/void-fake",
      platform: "linux-arm64",
      provideManifest: async () => ({
        version: "0.1.1",
        released_at: "x",
        min_protocol: 1,
        platforms: {
          "darwin-arm64": { url: "x", sha256: "x", size: 0 },
        },
        notes_url: "x",
      }),
    });
    expect(result.kind).toBe("unsupported-platform");
  });

  test("end-to-end: downloads tar.gz, extracts void, swaps when manifest is newer", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "void-runupdate-"));
    try {
      const targetPath = join(workdir, "void");
      await Bun.write(targetPath, "OLD-VOID");

      const payload = "NEW-VOID";
      const { bytes: tarBytes, sha256: tarSha } = await makeTarGz(payload, workdir);

      const binServer = Bun.serve({
        port: 0,
        fetch: () => new Response(tarBytes, { status: 200 }),
      });
      try {
        const result = await runUpdate({
          manifestUrl: "x",
          currentVersion: "0.1.0",
          execPath: targetPath,
          platform: "darwin-arm64",
          stagingDir: workdir,
          provideManifest: async () => ({
            version: "0.1.1",
            released_at: "x",
            min_protocol: 1,
            platforms: {
              "darwin-arm64": {
                url: `http://localhost:${binServer.port}/bin`,
                sha256: tarSha,
                size: tarBytes.byteLength,
              },
            },
            notes_url: "x",
          }),
        });
        expect(result.kind).toBe("installed");
        if (result.kind === "installed") expect(result.newVersion).toBe("0.1.1");

        // After extraction + swap, the binary at execPath should be the file
        // that was *inside* the tarball.
        const after = await Bun.file(targetPath).text();
        expect(after).toBe("NEW-VOID");
      } finally {
        binServer.stop();
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("swallows network errors and returns 'failed' result", async () => {
    const result = await runUpdate({
      manifestUrl: "http://localhost:1/dead",
      currentVersion: "0.1.0",
      execPath: "/tmp/void-fake",
      platform: "darwin-arm64",
      provideManifest: async () => { throw new Error("network down"); },
    });
    expect(result.kind).toBe("failed");
  });
});

describe("install-path independence (regression)", () => {
  const PAYLOAD = "PATH-INDEPENDENT";

  async function runWithExecPath(execPathSuffix: string): Promise<void> {
    const workdir = await mkdtemp(join(tmpdir(), "void-pathind-"));
    try {
      const subdir = join(workdir, execPathSuffix);
      await mkdir(subdir, { recursive: true });
      const targetPath = join(subdir, "void");
      await Bun.write(targetPath, "OLD");

      const { bytes: tarBytes, sha256: tarSha } = await makeTarGz(PAYLOAD, workdir);

      const binServer = Bun.serve({
        port: 0,
        fetch: () => new Response(tarBytes, { status: 200 }),
      });
      try {
        const result = await runUpdate({
          manifestUrl: "x",
          currentVersion: "0.1.0",
          execPath: targetPath,
          platform: "darwin-arm64",
          provideManifest: async () => ({
            version: "0.1.1",
            released_at: "x",
            min_protocol: 1,
            platforms: {
              "darwin-arm64": {
                url: `http://localhost:${binServer.port}/`,
                sha256: tarSha,
                size: tarBytes.byteLength,
              },
            },
            notes_url: "x",
          }),
        });
        expect(result.kind).toBe("installed");
        const after = await Bun.file(targetPath).text();
        expect(after).toBe(PAYLOAD);
      } finally {
        binServer.stop();
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  test("works for brew-like path", async () => {
    await runWithExecPath("opt/homebrew/bin");
  });
  test("works for npm-like path", async () => {
    await runWithExecPath("node_modules/.bin");
  });
  test("works for curl-installed path", async () => {
    await runWithExecPath(".local/bin");
  });
});
