/**
 * crypto — AES-256-GCM envelope for BYOK user LLM keys.
 *
 * Covers: round-trip; random IV (two encrypts of the same plaintext differ);
 * GCM auth-tag (tampering with ciphertext or IV makes decrypt throw);
 * isEncryptionConfigured() tracking env; and the production fail-closed path
 * (unset root key in NODE_ENV=production throws rather than degrading to the
 * dev fallback).
 *
 * Env handling uses `vi.stubEnv`; because crypto.ts reads `process.env` at call
 * time (not module load), stubbing before each call is sufficient. Tests run
 * under vitest's default NODE_ENV=test, so the dev fallback is the active key
 * whenever LLM_KEY_ENCRYPTION_KEY is unset — which is exactly the path the
 * round-trip and IV-randomness cases exercise without needing a real key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encryptKey,
  decryptKey,
  isEncryptionConfigured,
} from "./crypto";

// A real-shape 32-byte hex root key for env-set cases (NOT a real secret —
// generated for tests, never used outside this file).
const TEST_KEY_HEX =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("crypto round-trip", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", TEST_KEY_HEX);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("decrypt(encrypt(x)) === x", async () => {
    const plaintext = "sk-proj-abcdef0123456789";
    const { ciphertext, iv } = await encryptKey(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(await decryptKey(ciphertext, iv)).toBe(plaintext);
  });

  it("preserves multi-line / unicode payloads", async () => {
    const plaintext = "glm-鍵-αβγ\nline-2\ttab";
    const { ciphertext, iv } = await encryptKey(plaintext);
    expect(await decryptKey(ciphertext, iv)).toBe(plaintext);
  });
});

describe("crypto random IV", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", TEST_KEY_HEX);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("two encrypts of the same plaintext produce different ciphertext AND iv", async () => {
    const plaintext = "sk-same-input";
    const a = await encryptKey(plaintext);
    const b = await encryptKey(plaintext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // both must still decrypt back to the original
    expect(await decryptKey(a.ciphertext, a.iv)).toBe(plaintext);
    expect(await decryptKey(b.ciphertext, b.iv)).toBe(plaintext);
  });

  it("the IV is 12 bytes (96 bits) once base64-decoded", async () => {
    const { iv } = await encryptKey("x");
    const raw = Buffer.from(iv, "base64");
    expect(raw.length).toBe(12);
  });
});

describe("crypto GCM auth tag", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", TEST_KEY_HEX);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("tampering with the ciphertext throws on decrypt (auth-tag mismatch)", async () => {
    const { ciphertext, iv } = await encryptKey("secret");
    const bytes = Buffer.from(ciphertext, "base64");
    // Flip the last byte — within the GCM tag region, so integrity fails.
    bytes[bytes.length - 1] ^= 0x01;
    const tampered = bytes.toString("base64");
    await expect(decryptKey(tampered, iv)).rejects.toThrow();
  });

  it("tampering with the IV throws on decrypt", async () => {
    const { ciphertext, iv } = await encryptKey("secret");
    const ivBytes = Buffer.from(iv, "base64");
    ivBytes[0] ^= 0x01;
    const tamperedIv = ivBytes.toString("base64");
    await expect(decryptKey(ciphertext, tamperedIv)).rejects.toThrow();
  });

  it("decrypting under a different root key throws (key must match)", async () => {
    const { ciphertext, iv } = await encryptKey("secret");
    // Switch to a different valid key; the ciphertext was sealed under the
    // original, so this must fail closed.
    vi.stubEnv(
      "LLM_KEY_ENCRYPTION_KEY",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    await expect(decryptKey(ciphertext, iv)).rejects.toThrow();
  });
});

describe("isEncryptionConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns true when LLM_KEY_ENCRYPTION_KEY is set", () => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", TEST_KEY_HEX);
    expect(isEncryptionConfigured()).toBe(true);
  });

  it("returns false when LLM_KEY_ENCRYPTION_KEY is unset", () => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", "");
    expect(isEncryptionConfigured()).toBe(false);
  });

  it("returns false when LLM_KEY_ENCRYPTION_KEY is undefined", () => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", undefined);
    expect(isEncryptionConfigured()).toBe(false);
  });
});

describe("dev fallback + production fail-closed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("dev/test: unset key still round-trips via the fallback (and warns)", async () => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", "");
    // NODE_ENV is "test" under vitest — satisfies the !== "production" gate.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plaintext = "sk-dev-fallback";
    const { ciphertext, iv } = await encryptKey(plaintext);
    expect(await decryptKey(ciphertext, iv)).toBe(plaintext);
    expect(warn).toHaveBeenCalled();
    // dev fallback does not count as "configured"
    expect(isEncryptionConfigured()).toBe(false);
  });

  it("production: unset root key makes encrypt throw (fail-closed)", async () => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(encryptKey("sk-any")).rejects.toThrow(
      /LLM_KEY_ENCRYPTION_KEY is not set/,
    );
  });

  it("production: unset root key makes decrypt throw too", async () => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(decryptKey("YWJj", "ZGVm")).rejects.toThrow(
      /LLM_KEY_ENCRYPTION_KEY is not set/,
    );
  });

  it("production: a set root key works (no fail-closed when configured)", async () => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", TEST_KEY_HEX);
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ciphertext, iv } = await encryptKey("sk-prod-configured");
    expect(await decryptKey(ciphertext, iv)).toBe("sk-prod-configured");
    expect(warn).not.toHaveBeenCalled();
  });
});
