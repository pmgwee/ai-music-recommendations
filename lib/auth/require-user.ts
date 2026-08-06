import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/** Result of {@link requireUser}: a resolved userId, or a 401 response. */
export type RequireUserResult =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

/**
 * Resolve the signed-in user from the cookie-bound Supabase server client, or
 * return a clean 401 JSON response (never a throw) when there is no session.
 *
 * Route handlers call this first and return `response` as-is on the `!ok`
 * branch. The cookie-bound client + populated `auth.uid()` is what makes the
 * `log_music_*` security-invoker RPCs resolve to the caller's row — this is
 * the gate that replaces the SP-0 admin-dev concession.
 */
export async function requireUser(
  supabase: SupabaseClient<Database>,
): Promise<RequireUserResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, userId: user.id };
}
