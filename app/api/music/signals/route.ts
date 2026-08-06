import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseTrackStore } from "@/lib/providers/track-store-supabase";
import { requireUser } from "@/lib/auth/require-user";
import { rateLimit, getClientIP } from "@/lib/rate-limit";

/**
 * Record a behavioural signal (skip | complete) through the broad TrackStore
 * seam. The player emits skip (abandoned inside the first 30s) and complete
 * (natural ENDED) via its `onSignal` prop; the provider wires that to this
 * route. Manual Skip/Complete buttons on the proof page also POST here for UAT
 * probing. Bound to the cookie-bound server client + the signed-in user —
 * returns 401 JSON with no session.
 *
 * Coarse per-IP limit (60/min) fires BEFORE the auth check so a tight client
 * loop is throttled before it spends any Supabase session-lookup budget.
 */
export async function POST(req: Request) {
  const ip = getClientIP(req);
  const ipRL = rateLimit({ key: `ip:${ip}:signals`, limit: 60, windowMs: 60_000 });
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

  let body: { trackId?: string; signal?: "skip" | "complete" };
  try {
    body = (await req.json()) as { trackId?: string; signal?: "skip" | "complete" };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { trackId, signal } = body;
  if (!trackId) {
    return NextResponse.json({ error: "missing trackId" }, { status: 400 });
  }
  if (signal !== "skip" && signal !== "complete") {
    return NextResponse.json({ error: "signal must be 'skip' or 'complete'" }, { status: 400 });
  }

  const trackStore = createSupabaseTrackStore(supabase);
  await trackStore.recordSignal(auth.userId, trackId, signal);
  return NextResponse.json({ ok: true });
}
