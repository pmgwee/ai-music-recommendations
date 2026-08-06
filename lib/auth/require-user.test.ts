/**
 * requireUser — the route-handler auth gate introduced when the SP-0 admin-dev
 * concession was deleted (SP-1 Task 2). Verifies both branches: a signed-in
 * user resolves to its id, and a missing session yields a clean 401 JSON
 * response (the shape every music route returns as-is on the `!ok` branch).
 *
 * The hand-rolled mock mirrors the style of `track-store-supabase.test.ts` —
 * only the `auth.getUser()` surface is exercised, so no real client is built.
 */
import { describe, it, expect } from "vitest";
import { requireUser } from "./require-user";
import type { Database } from "@/lib/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<Database>;

function makeClient(user: { id: string } | null): Client {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
    },
  } as unknown as Client;
}

describe("requireUser", () => {
  it("returns ok:true with the session user's id", async () => {
    const r = await requireUser(makeClient({ id: "user-1" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userId).toBe("user-1");
  });

  it("returns a 401 JSON response (not a throw) when there is no session", async () => {
    const r = await requireUser(makeClient(null));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      const body = await r.response.json();
      expect(body).toEqual({ error: "unauthorized" });
    }
  });
});
