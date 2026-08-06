import { NextResponse } from "next/server";
import type { MusicTrack } from "@music-ai/engine";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseTrackStore } from "@/lib/providers/track-store-supabase";
import { requireUser } from "@/lib/auth/require-user";
import { rateLimit, getClientIP } from "@/lib/rate-limit";

/**
 * Record a play through the broad TrackStore seam. The player fires
 * `onTrackStart` once per track on first real playback (PLAYING after load);
 * the provider wires that to this route. Bound to the cookie-bound server
 * client + the signed-in user — returns 401 JSON with no session.
 *
 * Coarse per-IP limit (60/min) fires BEFORE the auth check so a tight client
 * loop is throttled before it spends any Supabase session-lookup budget —
 * these routes are called per user action, and a runaway loop would hammer the
 * DB. (Auth routes /login /signup are NOT limited here: Supabase's built-in
 * email-signup abuse limits cover that path.)
 */
export async function POST(req: Request) {
  const ip = getClientIP(req);
  const ipRL = rateLimit({ key: `ip:${ip}:plays`, limit: 60, windowMs: 60_000 });
  if (!ipRL.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(ipRL.retryAfterMs / 1000)) },
      },
    );
  }

  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;

  let body: { track?: MusicTrack };
  try {
    body = (await req.json()) as { track?: MusicTrack };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const track = body?.track;
  if (!track?.trackId) {
    return NextResponse.json({ error: "missing track.trackId" }, { status: 400 });
  }

  const trackStore = createSupabaseTrackStore(supabase);
  await trackStore.recordPlay(auth.userId, track);
  return NextResponse.json({ ok: true });
}
