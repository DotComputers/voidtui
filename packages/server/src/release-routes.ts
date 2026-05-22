import { join } from "node:path";

type StaticFile = {
  filename: string;
  contentType: string;
  cacheControl: string;
};

const ROUTES: Record<string, StaticFile> = {
  "/release/latest.json": {
    filename: "latest.json",
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=60",
  },
  "/release/latest.sh": {
    filename: "latest.sh",
    contentType: "text/plain; charset=utf-8",
    cacheControl: "public, max-age=60",
  },
  "/install": {
    filename: "install.sh",
    contentType: "text/x-shellscript; charset=utf-8",
    cacheControl: "public, max-age=3600",
  },
};

/**
 * Serve release-related static files from `releaseDir`.
 * Returns the Response for known paths (200 or 404).
 * Returns null for unknown paths so the caller can route elsewhere.
 *
 * Supports GET and HEAD.
 */
export async function handleReleaseRequest(
  req: Request,
  releaseDir: string,
): Promise<Response | null> {
  const url = new URL(req.url);
  const route = ROUTES[url.pathname];
  if (!route) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }

  const path = join(releaseDir, route.filename);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers({
    "content-type": route.contentType,
    "cache-control": route.cacheControl,
  });

  if (req.method === "HEAD") {
    headers.set("content-length", String(file.size));
    return new Response(null, { status: 200, headers });
  }
  return new Response(file, { status: 200, headers });
}
