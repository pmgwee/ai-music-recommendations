/**
 * /api/llm-key — handler-level tests (SP-2 Task 4).
 *
 * Mocks both collaborators the route touches:
 *   - `@/lib/supabase/server` — returns a hand-rolled client whose
 *     `auth.getUser()` either resolves a user (authed path) or returns null
 *     (the 401 path). `requireUser` runs against this UNmocked, so the gate's
 *     real shape (401 JSON `{error:"unauthorized"}`) is exercised end-to-end.
 *   - `@/lib/byok/store` — captures `listProviders` / `setLlmKey` /
 *     `deleteLlmKey` invocations + their args, so we assert the route issues
 *     the right calls and NEVER echoes the plaintext key back.
 *
 * `rateLimit` is reset between tests (`__resetRateLimiterForTests`) so each
 * test starts from a clean bucket; the per-user cap (10/min) is high enough
 * that sequential tests would otherwise trip it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available before the route module imports.
// ---------------------------------------------------------------------------
const supabaseMock = vi.hoisted(() => ({
  client: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve(supabaseMock.client),
}));

const storeMock = vi.hoisted(() => ({
  listProviders: vi.fn(),
  setLlmKey: vi.fn(),
  deleteLlmKey: vi.fn(),
  // `isSupportedProvider` is the real predicate — exercised against the same
  // set the production store uses, so the route's provider validation is
  // tested through the real code path.
  isSupportedProvider: (name: string) =>
    ["openai", "anthropic", "gemini", "glm"].includes(name),
}));

vi.mock("@/lib/byok/store", () => ({
  listProviders: (...args: never[]) => storeMock.listProviders(...args),
  setLlmKey: (...args: never[]) => storeMock.setLlmKey(...args),
  deleteLlmKey: (...args: never[]) => storeMock.deleteLlmKey(...args),
  isSupportedProvider: storeMock.isSupportedProvider,
}));

import { GET, POST, DELETE } from "./route";
import { __resetRateLimiterForTests } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setUser(user: { id: string } | null): void {
  supabaseMock.client.auth.getUser.mockResolvedValue({
    data: { user },
    error: null,
  });
}

function makeJsonRequest(
  method: string,
  body?: unknown,
): Request {
  return new Request("http://test/api/llm-key", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe("/api/llm-key", () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    setUser({ id: "user-1" });
    storeMock.listProviders.mockResolvedValue([]);
    storeMock.setLlmKey.mockResolvedValue(undefined);
    storeMock.deleteLlmKey.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    __resetRateLimiterForTests();
  });

  // -------------------------------------------------------------------------
  describe("auth gate", () => {
    it("GET returns 401 when there is no session", async () => {
      setUser(null);
      const res = await GET();
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: "unauthorized" });
      // Unauthed → the store is never touched.
      expect(storeMock.listProviders).not.toHaveBeenCalled();
    });

    it("POST returns 401 when there is no session", async () => {
      setUser(null);
      const res = await POST(makeJsonRequest("POST", { provider: "openai", key: "x" }));
      expect(res.status).toBe(401);
      expect(storeMock.setLlmKey).not.toHaveBeenCalled();
    });

    it("DELETE returns 401 when there is no session", async () => {
      setUser(null);
      const res = await DELETE(makeJsonRequest("DELETE", { provider: "openai" }));
      expect(res.status).toBe(401);
      expect(storeMock.deleteLlmKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("GET", () => {
    it("returns the configured provider list", async () => {
      storeMock.listProviders.mockResolvedValue(["openai", "glm"]);
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ providers: ["openai", "glm"] });
      expect(storeMock.listProviders).toHaveBeenCalledWith(
        supabaseMock.client,
        "user-1",
      );
    });

    it("returns an empty list when the user has no keys", async () => {
      storeMock.listProviders.mockResolvedValue([]);
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ providers: [] });
    });

    it("returns 500 + empty list when the store throws", async () => {
      storeMock.listProviders.mockRejectedValue(new Error("db down"));
      const res = await GET();
      expect(res.status).toBe(500);
      const body = await json(res) as { providers: string[] };
      expect(body.providers).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST", () => {
    it("persists the key via setLlmKey and returns {ok,provider}", async () => {
      const res = await POST(
        makeJsonRequest("POST", { provider: "openai", key: "sk-test-123" }),
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual({ ok: true, provider: "openai" });
      // The plaintext flows into setLlmKey (encrypted server-side by the store)
      // and is NEVER present in the response body.
      expect(storeMock.setLlmKey).toHaveBeenCalledWith(
        supabaseMock.client,
        "user-1",
        "openai",
        "sk-test-123",
      );
      const text = JSON.stringify(body);
      expect(text).not.toContain("sk-test-123");
    });

    it("accepts all four supported providers", async () => {
      for (const p of ["openai", "anthropic", "gemini", "glm"]) {
        const res = await POST(
          makeJsonRequest("POST", { provider: p, key: "k" }),
        );
        expect(res.status).toBe(200);
        expect(await json(res)).toEqual({ ok: true, provider: p });
      }
    });

    it("rejects an unsupported provider with 400", async () => {
      const res = await POST(
        makeJsonRequest("POST", { provider: "grok", key: "x" }),
      );
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_provider" });
      expect(storeMock.setLlmKey).not.toHaveBeenCalled();
    });

    it("rejects an empty key with 400", async () => {
      const res = await POST(
        makeJsonRequest("POST", { provider: "openai", key: "" }),
      );
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_key" });
      expect(storeMock.setLlmKey).not.toHaveBeenCalled();
    });

    it("rejects a key longer than the cap with 400", async () => {
      const res = await POST(
        makeJsonRequest("POST", { provider: "openai", key: "x".repeat(5000) }),
      );
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_key" });
      expect(storeMock.setLlmKey).not.toHaveBeenCalled();
    });

    it("returns 400 on malformed JSON body", async () => {
      const req = new Request("http://test/api/llm-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json{",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_json" });
    });

    it("returns 500 when the store throws", async () => {
      storeMock.setLlmKey.mockRejectedValue(new Error("db down"));
      const res = await POST(
        makeJsonRequest("POST", { provider: "openai", key: "k" }),
      );
      expect(res.status).toBe(500);
      const body = await json(res);
      // Never leak the plaintext in an error path either.
      expect(JSON.stringify(body)).not.toContain('"k"');
      expect(body).toEqual({ error: "set_failed" });
    });
  });

  // -------------------------------------------------------------------------
  describe("DELETE", () => {
    it("removes the key via deleteLlmKey and returns {ok:true}", async () => {
      const res = await DELETE(
        makeJsonRequest("DELETE", { provider: "openai" }),
      );
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true });
      expect(storeMock.deleteLlmKey).toHaveBeenCalledWith(
        supabaseMock.client,
        "user-1",
        "openai",
      );
    });

    it("rejects an unsupported provider with 400", async () => {
      const res = await DELETE(
        makeJsonRequest("DELETE", { provider: "grok" }),
      );
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_provider" });
      expect(storeMock.deleteLlmKey).not.toHaveBeenCalled();
    });

    it("returns 500 when the store throws", async () => {
      storeMock.deleteLlmKey.mockRejectedValue(new Error("db down"));
      const res = await DELETE(
        makeJsonRequest("DELETE", { provider: "openai" }),
      );
      expect(res.status).toBe(500);
      expect(await json(res)).toEqual({ error: "delete_failed" });
    });
  });

  // -------------------------------------------------------------------------
  describe("rate limit", () => {
    it("returns 429 once the per-user cap is exceeded", async () => {
      // The route's cap is 10/min/user. Make 10 successful GETs, then assert
      // the 11th is rate-limited. (rateLimit is reset in beforeEach.)
      for (let i = 0; i < 10; i++) {
        const r = await GET();
        expect(r.status).toBe(200);
      }
      const over = await GET();
      expect(over.status).toBe(429);
      const body = await json(over) as { error: string };
      expect(body.error).toBe("rate_limited");
    });
  });
});
