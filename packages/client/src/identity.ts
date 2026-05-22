import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { generateKeypair, toHex, fromHex, type Keypair } from "@void/shared";

export type Identity = {
  keypair: Keypair;
  handle: string | null; // null until first registration confirms
};

const VOID_DIR = process.env.VOID_HOME ?? join(homedir(), ".config", "void");
const IDENTITY_PATH = join(VOID_DIR, "identity.json");

type IdentityFile = {
  privateKey: string; // hex
  publicKey: string; // hex
  handle: string | null;
};

export async function loadIdentity(): Promise<Identity | null> {
  try {
    const raw = await readFile(IDENTITY_PATH, "utf8");
    const parsed = JSON.parse(raw) as IdentityFile;
    return {
      keypair: {
        privateKey: fromHex(parsed.privateKey),
        publicKey: fromHex(parsed.publicKey),
      },
      handle: parsed.handle,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveIdentity(identity: Identity): Promise<void> {
  await mkdir(VOID_DIR, { recursive: true });
  const data: IdentityFile = {
    privateKey: toHex(identity.keypair.privateKey),
    publicKey: toHex(identity.keypair.publicKey),
    handle: identity.handle,
  };
  await writeFile(IDENTITY_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(IDENTITY_PATH, 0o600);
}

export function newIdentity(): Identity {
  return { keypair: generateKeypair(), handle: null };
}

export function identityPath(): string {
  return IDENTITY_PATH;
}

const ADJECTIVES = [
  "blue", "amber", "cosmic", "void", "neon", "drift", "static", "echo",
  "ember", "frost", "lunar", "nova", "orbit", "phase", "rust", "shade",
  "spark", "tidal", "vapor", "wave",
];
const NOUNS = [
  "ant", "fox", "owl", "wolf", "moth", "crow", "lynx", "fin",
  "ray", "kit", "stag", "carp", "newt", "wren", "hare", "tern",
  "lark", "vole", "ibis", "puma",
];

export function suggestHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${a}${n}-${suffix}`;
}
