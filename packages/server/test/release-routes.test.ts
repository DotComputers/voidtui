import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { handleReleaseRequest } from "../src/release-routes.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "release");

describe("handleReleaseRequest", () => {
  test("returns null for non-release paths", async () => {
    const req = new Request("http://localhost/anything-else");
    expect(await handleReleaseRequest(req, FIXTURES)).toBeNull();
  });

  test("serves /release/latest.json with application/json + 60s cache", async () => {
    const req = new Request("http://localhost/release/latest.json");
    const res = await handleReleaseRequest(req, FIXTURES);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("application/json");
    expect(res!.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res!.json();
    expect(body.version).toBe("0.1.99");
  });

  test("serves /release/latest.sh with text/plain + 60s cache", async () => {
    const req = new Request("http://localhost/release/latest.sh");
    const res = await handleReleaseRequest(req, FIXTURES);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/plain");
    expect(res!.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res!.text();
    expect(body).toContain("VOID_VERSION=");
  });

  test("serves /install with text/x-shellscript + 1h cache", async () => {
    const req = new Request("http://localhost/install");
    const res = await handleReleaseRequest(req, FIXTURES);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("shellscript");
    expect(res!.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await res!.text();
    expect(body).toContain("fixture install script");
  });

  test("returns 404 when manifest file is missing", async () => {
    const req = new Request("http://localhost/release/latest.json");
    const res = await handleReleaseRequest(req, "/nonexistent/path");
    expect(res!.status).toBe(404);
  });

  test("HEAD on /release/latest.json works", async () => {
    const req = new Request("http://localhost/release/latest.json", { method: "HEAD" });
    const res = await handleReleaseRequest(req, FIXTURES);
    expect(res!.status).toBe(200);
  });
});
