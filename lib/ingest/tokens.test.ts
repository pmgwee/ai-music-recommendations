/**
 * Token store tests — asserts the encrypt/decrypt round-trip + the
 * (de)serialisation invariants + the RLS-shape SQL. Mirrors byok/store.test.ts.
 *
 * The crypto module has its own test (lib/byok/crypto.test.ts) — we mock it
 * here so we can assert the store calls encryptKey/decryptKey (not the
 * crypto itself), and so the test runs without the env root key set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the crypto module — capture encrypt/decrypt calls so the store test
// asserts the contract (encrypt called with plaintext; decrypt fed the
// ciphertext the store previously persisted).
const cryptoMock = vi.hoisted(() => ({
  configured: true,
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("../byok/crypto", () => ({
  encryptKey: (plain: string) => cryptoMock.encrypt(plain),
  decryptKey: (cipher: string, iv: string) => cryptoMock.decrypt(cipher, iv),
  isEncryptionConfigured: () => cryptoMock.configured,
}));

import {
  getProviderToken,
  setProviderToken,
  clearProviderToken,
  isIngestProvider,
  INGEST_PROVIDERS,
  type ProviderTokenEnvelope,
} from "./tokens";
import type { Database } from "../supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Mock supabase client — records upserts/deletes + serves a select response
// per the per-test `selectResponse` holder.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

interface ClientLog {
  upserts: Array<{ table: string; row: Row; opts?: { onConflict?: string } }>;
  deletes: Array<{ table: string; filters: Record<string, unknown> }>;
  selects: Array<{ table: string; filters: Record<string, unknown> }>;
}

function makeClient(log: ClientLog, selectResponse: { data: Row | null }) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const selectBuilder = {
        select() {
          return selectBuilder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return selectBuilder;
        },
        maybeSingle() {
          log.selects.push({ table, filters: { ...filters } });
          return Promise.resolve({ data: selectResponse.data, error: null });
        },
        // Awaitable directly (the store does `await supabase.from().select()...`).
        then<T>(
          onFulfilled?: (v: {
            data: Row | null;
            error: null;
          }) => T | PromiseLike<T>,
        ) {
          return Promise.resolve({
            data: selectResponse.data,
            error: null,
          }).then(onFulfilled);
        },
      };
      const writeBuilder = {
        upsert(row: Row, opts?: { onConflict?: string }) {
          log.upserts.push({ table, row, opts });
          return Promise.resolve({ data: row, error: null });
        },
        delete() {
          return {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return this;
            },
            then<T>(
              onFulfilled?: (v: {
                data: null;
                error: null;
              }) => T | PromiseLike<T>,
            ) {
              log.deletes.push({ table, filters: { ...filters } });
              return Promise.resolve({ data: null, error: null }).then(
                onFulfilled,
              );
            },
          };
        },
      };
      // The chain for selects starts with .select(); for writes it starts
      // with .upsert() or .delete(). Return a proxy that handles both — but
      // simplest: return a builder exposing both surfaces, since the store
      // only ever calls .select()/.eq()/.maybeSingle() (read) OR
      // .upsert()/.delete() (write) on a from() result.
      return { ...selectBuilder, ...writeBuilder };
    },
  } as unknown as Client;
}

const sampleToken: ProviderTokenEnvelope = {
  access: "ya29.access-token",
  refresh: "1//refresh-token",
  expiresAt: "2026-08-07T12:00:00.000Z",
};

describe("isIngestProvider", () => {
  it("accepts the two supported providers", () => {
    expect(isIngestProvider("youtube")).toBe(true);
    expect(isIngestProvider("spotify")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isIngestProvider("applemusic")).toBe(false);
    expect(isIngestProvider("")).toBe(false);
    expect(isIngestProvider("openai")).toBe(false);
  });

  it("INGEST_PROVIDERS lists exactly the supported set", () => {
    expect([...INGEST_PROVIDERS]).toEqual(["youtube", "spotify"]);
  });
});

describe("setProviderToken", () => {
  let log: ClientLog;
  let client: Client;

  beforeEach(() => {
    log = { upserts: [], deletes: [], selects: [] };
    client = makeClient(log, { data: null });
    cryptoMock.configured = true;
    cryptoMock.encrypt.mockReset();
    cryptoMock.decrypt.mockReset();
    // Default: encrypt echoes a fake (ciphertext, iv) pair; decrypt echoes
    // back the JSON envelope the store wrote.
    cryptoMock.encrypt.mockImplementation(async (plain: string) => ({
      ciphertext: `cipher(${plain.length})`,
      iv: "iv-base64",
    }));
    cryptoMock.decrypt.mockImplementation(async () =>
      JSON.stringify(sampleToken),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encrypts the envelope + upserts to provider_tokens on (user, provider)", async () => {
    await setProviderToken(client, "user-1", "spotify", sampleToken, "playlist-read-private");

    expect(cryptoMock.encrypt).toHaveBeenCalledOnce();
    const plain = cryptoMock.encrypt.mock.calls[0]![0] as string;
    expect(plain).toContain("ya29.access-token");
    expect(plain).toContain("1//refresh-token");
    // Envelope is JSON.
    expect(() => JSON.parse(plain)).not.toThrow();

    expect(log.upserts).toHaveLength(1);
    expect(log.upserts[0]).toMatchObject({
      table: "provider_tokens",
      opts: { onConflict: "user_id,provider" },
      row: {
        user_id: "user-1",
        provider: "spotify",
        encrypted_token: expect.any(String),
        iv: "iv-base64",
        scope: "playlist-read-private",
        expires_at: "2026-08-07T12:00:00.000Z",
      },
    });
  });

  it("rejects an unsupported provider", async () => {
    await expect(
      setProviderToken(client, "user-1", "tidal", sampleToken, ""),
    ).rejects.toThrow(/unsupported provider/);
    expect(log.upserts).toHaveLength(0);
  });

  it("rejects an empty access token", async () => {
    await expect(
      setProviderToken(
        client,
        "user-1",
        "youtube",
        { access: "" },
        "youtube.readonly",
      ),
    ).rejects.toThrow(/empty access/);
    expect(log.upserts).toHaveLength(0);
  });

  it("omits expires_at when the envelope has none", async () => {
    await setProviderToken(
      client,
      "user-1",
      "youtube",
      { access: "a" },
      "youtube.readonly",
    );
    expect(log.upserts[0]!.row.expires_at).toBeNull();
  });
});

describe("getProviderToken", () => {
  let log: ClientLog;
  let selectResponse: { data: Row | null };
  let client: Client;

  beforeEach(() => {
    log = { upserts: [], deletes: [], selects: [] };
    selectResponse = { data: null };
    client = makeClient(log, selectResponse);
    cryptoMock.configured = true;
    cryptoMock.encrypt.mockReset();
    cryptoMock.decrypt.mockReset();
    cryptoMock.decrypt.mockImplementation(async () =>
      JSON.stringify(sampleToken),
    );
  });

  it("returns null when no row exists", async () => {
    selectResponse.data = null;
    const out = await getProviderToken(client, "user-1", "spotify");
    expect(out).toBeNull();
  });

  it("returns null when encryption is not configured (clean degrade)", async () => {
    cryptoMock.configured = false;
    const out = await getProviderToken(client, "user-1", "spotify");
    expect(out).toBeNull();
    // Didn't even hit the DB.
    expect(log.selects).toHaveLength(0);
  });

  it("decrypts + parses the stored envelope", async () => {
    selectResponse.data = {
      encrypted_token: "cipher-blob",
      iv: "iv-base64",
    };
    const out = await getProviderToken(client, "user-1", "spotify");
    expect(out).toEqual(sampleToken);
    // Decrypt was fed the row's stored ciphertext + iv (NOT a mix).
    expect(cryptoMock.decrypt).toHaveBeenCalledWith("cipher-blob", "iv-base64");
  });

  it("selects scoped by user_id + provider", async () => {
    selectResponse.data = null;
    await getProviderToken(client, "u", "youtube");
    expect(log.selects).toHaveLength(1);
    expect(log.selects[0]).toMatchObject({
      table: "provider_tokens",
      filters: { user_id: "u", provider: "youtube" },
    });
  });

  it("throws when decrypt yields malformed JSON (tampered row)", async () => {
    selectResponse.data = { encrypted_token: "x", iv: "y" };
    cryptoMock.decrypt.mockResolvedValueOnce("not-json");
    await expect(getProviderToken(client, "u", "spotify")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("throws when parsed envelope is missing access", async () => {
    selectResponse.data = { encrypted_token: "x", iv: "y" };
    cryptoMock.decrypt.mockResolvedValueOnce(JSON.stringify({ refresh: "r" }));
    await expect(getProviderToken(client, "u", "spotify")).rejects.toThrow(
      /missing `access`/,
    );
  });
});

describe("clearProviderToken", () => {
  let log: ClientLog;
  let client: Client;

  beforeEach(() => {
    log = { upserts: [], deletes: [], selects: [] };
    client = makeClient(log, { data: null });
  });

  it("deletes scoped by user_id + provider", async () => {
    await clearProviderToken(client, "u", "spotify");
    expect(log.deletes).toHaveLength(1);
    expect(log.deletes[0]).toMatchObject({
      table: "provider_tokens",
      filters: { user_id: "u", provider: "spotify" },
    });
  });
});
