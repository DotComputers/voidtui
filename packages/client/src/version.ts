/**
 * Embedded client version. Set at compile time via
 *   bun build --compile --define VOID_CLIENT_VERSION='"X.Y.Z"' ...
 * When running from source (no --define), falls back to "0.0.0-dev".
 */
declare const VOID_CLIENT_VERSION: string | undefined;

export const CLIENT_VERSION: string =
  typeof VOID_CLIENT_VERSION !== "undefined" && VOID_CLIENT_VERSION
    ? VOID_CLIENT_VERSION
    : "0.0.0-dev";

/**
 * Compare two semver strings. Returns:
 *   negative if a < b
 *   zero if a == b (suffixes ignored — "0.1.0-dev" == "0.1.0")
 *   positive if a > b
 * Missing segments are treated as 0. Prerelease suffixes are not ordered.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const base = v.split("-")[0] ?? v;
    const parts = base.split(".").map((x) => Number.parseInt(x, 10) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}
