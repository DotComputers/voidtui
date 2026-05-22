import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, fromHex } from "./crypto.ts";

/**
 * Proof of work for registration.
 *
 * Find a nonce such that sha256(pubkey || nonce) has at least `difficulty`
 * leading zero bits.
 */
export function computePow(
  publicKey: Uint8Array,
  difficulty: number,
  maxIterations = 50_000_000,
): { nonce: string } {
  const nonceBuf = new Uint8Array(16);
  const combined = new Uint8Array(publicKey.length + nonceBuf.length);
  combined.set(publicKey, 0);

  for (let i = 0; i < maxIterations; i++) {
    writeUint64LE(nonceBuf, i);
    combined.set(nonceBuf, publicKey.length);
    const hash = sha256(combined);
    if (leadingZeroBits(hash) >= difficulty) {
      return { nonce: toHex(nonceBuf) };
    }
  }
  throw new Error(`PoW exceeded ${maxIterations} iterations at difficulty ${difficulty}`);
}

export function verifyPow(
  publicKey: Uint8Array,
  nonceHex: string,
  difficulty: number,
): boolean {
  const nonce = fromHex(nonceHex);
  const combined = new Uint8Array(publicKey.length + nonce.length);
  combined.set(publicKey, 0);
  combined.set(nonce, publicKey.length);
  const hash = sha256(combined);
  return leadingZeroBits(hash) >= difficulty;
}

function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    // Math.clz32 counts leading zeros in a 32-bit value;
    // for a byte 0-255 the upper 24 bits are zero, so subtract 24.
    count += Math.clz32(byte) - 24;
    break;
  }
  return count;
}

function writeUint64LE(buf: Uint8Array, value: number): void {
  // JS numbers are 53-bit safe integers; this is fine for our nonce counter.
  let v = value;
  for (let i = 0; i < 8; i++) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  // upper 8 bytes stay zero
}
