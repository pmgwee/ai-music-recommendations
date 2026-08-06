import { NextResponse } from "next/server";
import type { TrackStore } from "@music-ai/engine";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createSupabaseTrackStore } from "@/lib/providers/track-store-supabase";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SP-0 DEV-MODE CONCESSION — DELETE IN SP-1.
 * ─────────────────────────────────────────────────────────────────────────────
 * SP-0 proves the four-seam architecture WITHOUT auth (auth/cookie/RLS is
 * SP-1's scope). These route handlers therefore bind the broad `TrackStore` to
 * the service-role admin client + a fixed dev user id (`MUSIC_DEV_USER_ID`) so
 * RLS doesn't block the architecture proof.
 *
 * SP-1 swaps `createSupabaseAdminClient()` for the cookie-bound server client
 * (`createSupabaseServerClient()`) and sources `userId` from the real session —
 * at which point this helper is deleted and the routes call the store factory
 * directly. The engine + provider impls are untouched by that swap: that's the
 * point of the seam boundary this proof exercises.
 *
 * KNOWN SP-0 LIMITATION (surfaced for the controller's UAT): the
 * `log_music_play` / `log_music_signal` / `log_music_transition` RPCs are
 * `security invoker` + granted to `authenticated` only, and they key their row
 * on `auth.uid()`. The service role has no auth context (`auth.uid() = NULL`),
 * so the WRITE-RPC paths may be denied or produce a NULL user_id. The plain
 * table reads in the store (`.eq("user_id", userId)`) pass `userId` explicitly
 * and work under the admin client, so `loadHistory` / `loadLikes` /
 * `loadSuppressions` / `loadTransitionBias` / `getTags` / `setTags` — i.e. the
 * shelf-build path — are functional. Whether recordPlay/recordSignal persist
 * under the service role is itself one of the things the live UAT confirms;
 * if they don't, SP-1's cookie client resolves it for free.
 */

export interface Sp0DevContext {
  /** The fixed dev user id (a UUID the controller created in auth.users). */
  devUserId: string;
  /** Broad TrackStore bound to the admin client + dev user. */
  trackStore: TrackStore;
}

/**
 * Resolve the SP-0 dev context. Returns the context on success, or a 503
 * `NextResponse` (clean JSON error, never a crash) when the admin client or the
 * dev user id is not configured. Route handlers must check for the `response`
 * field and return it as-is.
 */
export function resolveSp0DevContext(): Sp0DevContext | NextResponse {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      {
        error:
          "SP-0 dev-mode requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. " +
          "SP-1 swaps in the cookie-bound client + real auth.",
      },
      { status: 503 },
    );
  }
  const devUserId = process.env.MUSIC_DEV_USER_ID;
  if (!devUserId) {
    return NextResponse.json(
      {
        error:
          "SP-0 dev-mode requires MUSIC_DEV_USER_ID (a UUID in auth.users). " +
          "SP-1 swaps in real auth.",
      },
      { status: 503 },
    );
  }

  const admin = createSupabaseAdminClient();
  const trackStore = createSupabaseTrackStore(admin);
  return { devUserId, trackStore };
}
