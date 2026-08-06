import { NextResponse } from "next/server";
import type { MusicTrack } from "@music-ai/engine";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseTrackStore } from "@/lib/providers/track-store-supabase";
import { requireUser } from "@/lib/auth/require-user";

/**
 * Record a play through the broad TrackStore seam. The player fires
 * `onTrackStart` once per track on first real playback (PLAYING after load);
 * the provider wires that to this route. Bound to the cookie-bound server
 * client + the signed-in user — returns 401 JSON with no session.
 */
export async function POST(req: Request) {
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
