import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { canonicalize } from "./canonical.ts";

// Required for @noble/ed25519 v2.x sync API:
// the sync sign/verify path needs sha512Sync hooked up explicitly.
ed.etc.sha512Sync = (...m: Uint8Array[]) =>
  sha512(m.length === 1 ? m[0]! : ed.etc.concatBytes(...m));

export type Keypair = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

export function generateKeypair(): Keypair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(privateKey);
}

/**
 * Sign a canonical-JSON-serialized payload. The `signature` field is excluded
 * from the canonical form (it's what we're producing).
 */
export function signMessage(privateKey: Uint8Array, message: object): string {
  const { signature: _drop, ...rest } = message as Record<string, unknown>;
  const canonical = canonicalize(rest);
  const bytes = new TextEncoder().encode(canonical);
  const sig = ed.sign(bytes, privateKey);
  return toHex(sig);
}

export function verifyMessage(
  publicKey: Uint8Array,
  message: object,
  signatureHex: string,
): boolean {
  const { signature: _drop, ...rest } = message as Record<string, unknown>;
  const canonical = canonicalize(rest);
  const bytes = new TextEncoder().encode(canonical);
  try {
    return ed.verify(fromHex(signatureHex), bytes, publicKey);
  } catch {
    return false;
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("fromHex: odd-length string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
