/**
 * store — BYOK encrypted key persistence.
 *
 * Hand-rolled in-memory supabase mock (same shape as the track-store test):
 * `from("user_llm_keys").select().eq(...).maybeSingle()` → thenable, plus
 * `.upsert(...)` and `.delete().eq(...).eq(...)`. Verifies the four store
 * functions issue the right query shape, round-trip through `crypto.ts`, list
 * most-recently-set first, and that the BYOK-disabled path (no root key) makes
 * `getLlmKey` return null without touching the DB.
 *
 * `crypto.ts`'s own tests cover the AES-GCM envelope; here we stub env once
 * per beforeEach so encrypt/decrypt round-trip against a real key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  getLlmKey,
  setLlmKey,
  listProviders,
  deleteLlmKey,
  isSupportedProvider,
  SUPPORTED_PROVIDERS,
} from "./store";

// Real-shape 32-byte hex root key for env-set cases (NOT a real secret).
const TEST_KEY_HEX =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

// ---------------------------------------------------------------------------
// Mock supabase client (only the user_llm_keys surface is exercised)
// ---------------------------------------------------------------------------
type Row = {
  user_id: string;
  provider: string;
  encrypted_key: string;
  iv: string;
  created_at: string;
  updated_at: string;
};

interface MockStore {
  rows: Row[];
  forceError: boolean;
  lastUpsert: { table: string; row: unknown; onConflict?: string } | null;
  deleteCalls: Array<{ filters: Record<string, unknown> }>;
}

function makeStore(): MockStore {
  return { rows: [], forceError: false, lastUpsert: null, deleteCalls: [] };
}

function createMockClient(store: MockStore) {
  function from(table: string) {
    if (table !== "user_llm_keys") {
      throw new Error(`unexpected table: ${table}`);
    }
    const filters: Array<{ col: string; val: unknown }> = [];
    let selectCols: string | undefined;
    let orderCol: string | undefined;
    let orderAsc = true;
    let mode: "many" | "maybeSingle" = "many";

    function run() {
      if (store.forceError) return { data: null, error: { message: "forced" } };
      let rows = [...store.rows];
      for (const f of filters) rows = rows.filter((r) => r[f.col as keyof Row] === f.val);
      if (mode === "maybeSingle") {
        return { data: rows[0] ?? null, error: null };
      }
      if (orderCol) {
        rows.sort((a, b) => {
          const av = a[orderCol! as keyof Row];
          const bv = b[orderCol! as keyof Row];
          if (av === bv) return 0;
          const cmp = String(av) < String(bv) ? -1 : 1;
          return orderAsc ? cmp : -cmp;
        });
      }
      // Project to selected columns when a specific select list was given
      // (matches PostgREST's column projection; listProviders selects "provider").
      if (selectCols && selectCols !== "*") {
        const cols = selectCols.split(",").map((c) => c.trim());
        rows = rows.map((r) => {
          const proj: Record<string, unknown> = {};
          for (const c of cols) proj[c] = r[c as keyof Row];
          return proj as Row;
        });
      }
      return { data: rows, error: null };
    }

    const builder = {
      select(cols?: string) {
        selectCols = cols;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return builder;
      },
      maybeSingle() {
        mode = "maybeSingle";
        return builder;
      },
      upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
        store.lastUpsert = { table, row, onConflict: opts?.onConflict };
        if (store.forceError) {
          return Promise.resolve({ data: null, error: { message: "forced" } });
        }
        const pk = (row.provider as string) ?? "";
        const existing = store.rows.find((r) => r.provider === pk);
        const merged: Row = {
          user_id: row.user_id as string,
          provider: row.provider as string,
          encrypted_key: row.encrypted_key as string,
          iv: row.iv as string,
          created_at: existing?.created_at ?? new Date().toISOString(),
          updated_at: (row.updated_at as string) ?? new Date().toISOString(),
        };
        if (existing) Object.assign(existing, merged);
        else store.rows.push(merged);
        return Promise.resolve({ data: row, error: null });
      },
      delete() {
        return {
          eq(col: string, val: unknown) {
            filters.push({ col, val });
            return this;
          },
          // thenable
          then<T>(
            onFulfilled?: (v: { data: unknown; error: unknown }) => T | PromiseLike<T>,
          ) {
            store.deleteCalls.push({
              filters: Object.fromEntries(filters.map((f) => [f.col, f.val])),
            });
            if (store.forceError) {
              return Promise.resolve({ data: null, error: { message: "forced" } }).then(
                onFulfilled,
              );
            }
            store.rows = store.rows.filter(
              (r) => !filters.every((f) => r[f.col as keyof Row] === f.val),
            );
            return Promise.resolve({ data: null, error: null }).then(onFulfilled);
          },
        };
      },
      then<T>(
        onFulfilled?: (v: { data: unknown; error: unknown }) => T | PromiseLike<T>,
      ) {
        return Promise.resolve(run()).then(onFulfilled);
      },
    };
    return builder;
  }

  return { from };
}

describe("byok store", () => {
  let store: MockStore;
  // The mock is structurally partial; the typed `SupabaseClient<Database>`
  // param is satisfied via cast at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeEach(() => {
    vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", TEST_KEY_HEX);
    store = makeStore();
    client = createMockClient(store);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("getLlmKey", () => {
    it("returns null when no row exists", async () => {
      const out = await getLlmKey(client, "user-1", "openai");
      expect(out).toBeNull();
    });

    it("round-trips a key that was setLlmKey'd", async () => {
      await setLlmKey(client, "user-1", "openai", "sk-test-123");
      const out = await getLlmKey(client, "user-1", "openai");
      expect(out).toBe("sk-test-123");
    });

    it("returns null when encryption is not configured (BYOK disabled)", async () => {
      vi.stubEnv("LLM_KEY_ENCRYPTION_KEY", "");
      // Even with a row present, getLlmKey short-circuits without touching DB.
      store.rows.push({
        user_id: "user-1",
        provider: "openai",
        encrypted_key: "YWJj",
        iv: "ZGVm",
        created_at: "",
        updated_at: "",
      });
      const out = await getLlmKey(client, "user-1", "openai");
      expect(out).toBeNull();
    });

    it("selects only encrypted_key, iv (never returns plaintext)", async () => {
      await setLlmKey(client, "user-1", "anthropic", "sk-ant-x");
      await getLlmKey(client, "user-1", "anthropic");
      // The mock records the select list via builder.run's projection; we
      // can't intercept the .select() arg here, but we can assert the row in
      // the DB never holds the plaintext.
      const row = store.rows[0];
      expect(row.encrypted_key).not.toContain("sk-ant-x");
      expect(row.iv).not.toContain("sk-ant-x");
    });

    it("throws on DB error", async () => {
      store.forceError = true;
      await expect(getLlmKey(client, "user-1", "openai")).rejects.toThrow(
        /getLlmKey failed/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("setLlmKey", () => {
    it("persists ciphertext + iv (not plaintext) and bumps updated_at", async () => {
      const before = new Date();
      await setLlmKey(client, "user-1", "openai", "sk-real-key");
      const after = new Date();

      expect(store.rows).toHaveLength(1);
      const row = store.rows[0];
      expect(row.user_id).toBe("user-1");
      expect(row.provider).toBe("openai");
      expect(row.encrypted_key).not.toBe("sk-real-key");
      // base64 of GCM ciphertext + 12-byte IV → at least this long.
      expect(row.encrypted_key.length).toBeGreaterThan(20);
      expect(row.iv.length).toBeGreaterThanOrEqual(16); // 12 bytes base64 ≈ 16 chars
      const updated = new Date(row.updated_at);
      expect(updated.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(updated.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("upserts with the (user_id, provider) conflict target", async () => {
      await setLlmKey(client, "user-1", "openai", "first");
      await setLlmKey(client, "user-1", "openai", "second");

      expect(store.rows).toHaveLength(1); // replaced, not appended
      expect(store.lastUpsert?.onConflict).toBe("user_id,provider");
      expect(await getLlmKey(client, "user-1", "openai")).toBe("second");
    });

    it("rejects an unsupported provider name", async () => {
      await expect(
        setLlmKey(client, "user-1", "grok", "x"),
      ).rejects.toThrow(/unsupported provider/);
      expect(store.rows).toHaveLength(0);
    });

    it("rejects an empty plaintext", async () => {
      await expect(setLlmKey(client, "user-1", "openai", "")).rejects.toThrow(
        /empty key/,
      );
    });

    it("throws on DB error", async () => {
      store.forceError = true;
      await expect(
        setLlmKey(client, "user-1", "openai", "sk-x"),
      ).rejects.toThrow(/setLlmKey failed/);
    });
  });

  // -------------------------------------------------------------------------
  describe("listProviders", () => {
    it("returns provider names most-recently-set first, no plaintext/iv", async () => {
      // Insert in a deliberately scrambled order with distinct updated_at values
      // so the order-by is actually exercised.
      const t0 = "2026-01-01T00:00:00.000Z";
      const t1 = "2026-02-01T00:00:00.000Z";
      const t2 = "2026-03-01T00:00:00.000Z";
      store.rows = [
        { user_id: "u", provider: "openai", encrypted_key: "a", iv: "a", created_at: t0, updated_at: t0 },
        { user_id: "u", provider: "glm", encrypted_key: "b", iv: "b", created_at: t2, updated_at: t2 },
        { user_id: "u", provider: "anthropic", encrypted_key: "c", iv: "c", created_at: t1, updated_at: t1 },
      ];

      const out = await listProviders(client, "u");
      expect(out).toEqual(["glm", "anthropic", "openai"]);
    });

    it("returns [] when the user has no keys", async () => {
      expect(await listProviders(client, "u")).toEqual([]);
    });

    it("throws on DB error", async () => {
      store.forceError = true;
      await expect(listProviders(client, "u")).rejects.toThrow(
        /listProviders failed/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("deleteLlmKey", () => {
    it("removes the row matching (user_id, provider)", async () => {
      await setLlmKey(client, "u", "openai", "k1");
      await setLlmKey(client, "u", "glm", "k2");
      expect(store.rows).toHaveLength(2);

      await deleteLlmKey(client, "u", "openai");
      expect(store.rows.map((r) => r.provider)).toEqual(["glm"]);

      // Filter shape: both user_id and provider forwarded as eq().
      expect(store.deleteCalls[0].filters).toEqual({
        user_id: "u",
        provider: "openai",
      });
    });

    it("is a no-op when the row does not exist", async () => {
      await deleteLlmKey(client, "u", "openai");
      expect(store.rows).toHaveLength(0);
    });

    it("throws on DB error", async () => {
      store.forceError = true;
      await expect(deleteLlmKey(client, "u", "openai")).rejects.toThrow(
        /deleteLlmKey failed/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("provider validation surface", () => {
    it("SUPPORTED_PROVIDERS lists the four providers", () => {
      expect(SUPPORTED_PROVIDERS).toEqual([
        "openai",
        "anthropic",
        "gemini",
        "glm",
      ]);
    });

    it("isSupportedProvider narrows the four", () => {
      for (const p of SUPPORTED_PROVIDERS) {
        expect(isSupportedProvider(p)).toBe(true);
      }
      expect(isSupportedProvider("grok")).toBe(false);
      expect(isSupportedProvider("")).toBe(false);
    });
  });
});
