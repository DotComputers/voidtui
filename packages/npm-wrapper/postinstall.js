#!/usr/bin/env node
// Downloads the right-platform void binary at npm install time.
//
// Uses the same Jetson-hosted manifest as the curl installer. If the manifest
// can't be reached, prints a clear error and exits 1 — npm install fails
// rather than silently install nothing.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const MANIFEST_URL = process.env.VOID_MANIFEST_URL || "https://void-relay.com/release/latest.json";
const BIN_DIR = path.join(__dirname, "bin");
const BIN_PATH = path.join(BIN_DIR, "void");

function detectKey() {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64")   return "darwin-x64";
  if (p === "linux"  && a === "arm64") return "linux-arm64";
  if (p === "linux"  && a === "x64")   return "linux-x64";
  return null;
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(get(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  const key = detectKey();
  if (!key) {
    console.error(`[thevoid] unsupported platform: ${process.platform}-${process.arch}`);
    process.exit(1);
  }
  const manifest = JSON.parse((await get(MANIFEST_URL)).toString("utf-8"));
  const entry = manifest.platforms[key];
  if (!entry) {
    console.error(`[thevoid] manifest has no entry for ${key}`);
    process.exit(1);
  }

  console.log(`[thevoid] downloading void ${manifest.version} (${key})...`);
  const tarball = await get(entry.url);

  const actual = crypto.createHash("sha256").update(tarball).digest("hex");
  if (actual !== entry.sha256) {
    console.error(`[thevoid] sha256 mismatch — aborting`);
    process.exit(1);
  }

  // Extract the binary from the .tar.gz. We use the system `tar` because
  // bundling a tar parser is overkill. Bun's binary is the single file inside.
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmpTar = path.join(BIN_DIR, "void.tar.gz");
  fs.writeFileSync(tmpTar, tarball);
  execFileSync("tar", ["-xzf", tmpTar, "-C", BIN_DIR]);
  fs.unlinkSync(tmpTar);
  fs.chmodSync(BIN_PATH, 0o755);

  console.log(`[thevoid] installed void ${manifest.version} to ${BIN_PATH}`);
}

main().catch((e) => {
  console.error(`[thevoid] install failed: ${e.message}`);
  process.exit(1);
});
