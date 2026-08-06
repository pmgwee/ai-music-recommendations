/**
 * AES-256-GCM envelope encryption for user-supplied LLM API keys (BYOK).
 *
 * SERVER ONLY. Uses Node's WebCrypto (`node:crypto`'s `webcrypto` binding, the
 * same engine that powers the Web Cryptography API in the Edge/Node runtimes —
 * not the legacy `crypto.Cipher` API). The plaintext key is encrypted in memory
 * before it ever touches the database; `user_llm_keys.encrypted_key` stores only
 * ciphertext, and the 12-byte IV is co-stored in `user_llm_keys.iv`.
 *
 * Root key: `process.env.LLM_KEY_ENCRYPTION_KEY` — 32 bytes, hex-encoded (64
 * chars). Generate with `openssl rand -hex 32`. Because the same root key
 * decrypts every user's row, it must live only in server env (never the client,
 * never the DB) — its secrecy is the foundation of the whole BYOK layer.
 *
 * Failure modes:
 *  - env unset + production  → throw (fail-closed: BYOK is disabled rather than
 *    storing keys with a weak/fallback root key; callers surface a clean error).
 *  - env unset + dev/test    → use a fixed, obviously-non-secret dev fallback
 *    key and `console.warn` once, so local development does not require ops.
 *    `isEncryptionConfigured()` still returns false in this state, so the route
 *    layer can refuse to persist a real key until the operator sets the env.
 *
 * The dev fallback is the reason `getKey()` is gated on `NODE_ENV` at call time
 * rather than at module load: it keeps the fallback deterministic for tests
 * (they run under `NODE_ENV=test`, which is `!== "production"`) and lets
 * `vi.stubEnv` flip the env per-case without re-importing the module.
 */
import { webcrypto } from "node:crypto";

const SUBTLE = webcrypto.subtle;

/** 32-byte root key, hex. NOT SECRET — dev/local fallback only, never production.
 *  Pinned so the encrypt/decrypt round-trip is deterministic without env. */
const DEV_FALLBACK_KEY_HEX =
  "0000000000000000000000000000000000000000000000000000000000000000";

/** AES-256-GCM nonce length (NIST SP 800-38D recommendation for best performance). */
const IV_LEN = 12;
/** AES-256 key length in bytes. */
const KEY_LEN = 32;

let devFallbackWarned = false;

/** True iff the server root key env is set. Route/UI code uses this to decide
 *  whether BYOK is live — the dev fallback keeps crypto working locally even
 *  when this returns false. */
export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.LLM_KEY_ENCRYPTION_KEY);
}

/** Parse + validate the 32-byte hex root key into raw bytes. */
function hexToKeyBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "LLM_KEY_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars).",
    );
  }
  const bytes = new Uint8Array(KEY_LEN);
  for (let i = 0; i < KEY_LEN; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return SUBTLE.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Resolve the active CryptoKey. Real env wins; otherwise dev/test gets the
 * fallback (with a one-time warning); production throws fail-closed.
 */
async function resolveKey(): Promise<CryptoKey> {
  const hex = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (hex) return importAesKey(hexToKeyBytes(hex));

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "LLM_KEY_ENCRYPTION_KEY is not set — production refuses to encrypt " +
        "user keys without a configured root key (BYOK disabled).",
    );
  }

  if (!devFallbackWarned) {
    // eslint-disable-next-line no-console
    console.warn(
      "[byok] LLM_KEY_ENCRYPTION_KEY is not set — using insecure dev-only " +
        "fallback key. Do NOT ship this. Set LLM_KEY_ENCRYPTION_KEY " +
        "(openssl rand -hex 32) before any real user key is stored.",
    );
    devFallbackWarned = true;
  }
  return importAesKey(hexToKeyBytes(DEV_FALLBACK_KEY_HEX));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Encrypt a plaintext API key. Generates a fresh random 12-byte IV per call
 * (so encrypting the same key twice yields different ciphertext), and returns
 * both ciphertext and IV as base64 — ready to insert into `user_llm_keys`.
 */
export async function encryptKey(
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await resolveKey();
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LEN));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await SUBTLE.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt a previously-stored key. Throws (GCM auth-tag mismatch) if the
 * ciphertext or IV was tampered with, or if the root key differs from the one
 * used to encrypt — the correctness of the fail-closed path leans on this.
 */
export async function decryptKey(
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await resolveKey();
  const ivBytes = base64ToBytes(iv);
  const cipherBytes = base64ToBytes(ciphertext);
  const plainBuf = await SUBTLE.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    cipherBytes,
  );
  return new TextDecoder().decode(plainBuf);
}
