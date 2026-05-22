/**
 * Deterministic JSON serialization for cryptographic signing.
 *
 * Rules:
 *  - Object keys are sorted lexicographically (UTF-16 code unit order).
 *  - No insignificant whitespace.
 *  - Arrays preserve order.
 *  - undefined and functions are rejected.
 *  - Non-finite numbers are rejected.
 *
 * Both client and server use this when signing and verifying.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalize: non-finite numbers are not allowed");
    }
    return value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Match JSON.stringify: undefined values are dropped from objects entirely.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }
  if (typeof value === "undefined") {
    throw new Error("canonicalize: undefined at top level is not allowed");
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
