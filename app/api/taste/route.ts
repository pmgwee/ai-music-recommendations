import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseTrackStore } from "@/lib/providers/track-store-supabase";
import { requireUser } from "@/lib/auth/require-user";
import { rateLimit } from "@/lib/rate-limit";
import { buildTasteProfile } from "@/lib/taste/profile";

/**
 * GET /api/taste — the signed-in user's taste profile (top artists, top tags,
 * stats), derived purely from their own listening data via the engine's
 * TrackStore seam.
 *
 * Session-gated (`requireUser`) + per-user rate-limited (10/min — generous for
 * a human, stops a tight client loop hammering the getTags fan-out). The
 * underlying aggregation is defensive (empty history → empty profile, never
 * throws), so any failure mode here is an infrastructure error, surfaced as
 * a clean 500 JSON.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

  // 10/min/user — each call fans out up to 60 getTags reads + 1 history scan,
  // so a client loop has real cost. The page itself fetches once on mount.
  const rl = rateLimit({ key: `taste:${userId}`, limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  try {
    const trackStore = createSupabaseTrackStore(supabase);
    const profile = await buildTasteProfile(trackStore, userId);
    return NextResponse.json(profile);
  } catch (err) {
    console.error("[api/taste] failed:", err);
    return NextResponse.json(
      { error: "taste profile build failed" },
      { status: 500 },
    );
  }
}
