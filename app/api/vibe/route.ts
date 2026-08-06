import { NextResponse } from "next/server";
import {
  buildRadio,
  createYoutubeCandidateSource,
  parseVibe,
} from "@music-ai/engine";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseTrackStore } from "@/lib/providers/track-store-supabase";
import { requireUser } from "@/lib/auth/require-user";
import { createByokLlm, NullLlm } from "@/lib/providers/llm-byok";
import { toNarrowTagStore } from "@/lib/providers/tag-store-adapter";
import { rateLimit } from "@/lib/rate-limit";
import { resolveVibeSeed } from "@/lib/vibe/resolve";

/**
 * POST /api/vibe — one-prompt playlists (SP-5).
 *
 * Pipeline (spec SP-5 D2/D3):
 *   1. parseVibe(prompt, llm) → structured VibeConstraints (genres/moods/eras/
 *      seedNames/exclude/length). The LLM only captures intent — it never picks
 *      songs or emits ids.
 *   2. resolveVibeSeed(constraints, candidateSource) → one concrete seed track,
 *      grounded via anonymous YouTube search (the LLM's `seedNames[0]` is
 *      resolved, never trusted as-is).
 *   3. buildRadio({ seedTrackId, history, candidateSource, tagStore, llm }) →
 *      a personalised radio that skips the user's skipped tracks and ranks by
 *      their taste.
 *   4. Post-filter by `exclude` (a title containing an exclude word is dropped)
 *      and cap at `length`.
 *
 * Auth: session-gated (`requireUser`). Rate limit: 6/min/user — each build
 * spends one LLM call + up to two anonymous searches + one radio fetch, all
 * against the user's BYOK budget / shared InnerTube quota, so a tight client
 * loop has real cost.
 *
 * Clean degrades (never a 500):
 *   - no BYOK LLM → `{ tracks: [], error: "vibe_needs_llm" }` (the surface
 *     needs intent parsing; NullLlm.isConfigured() is false → parseVibe returns
 *     null, but we surface the clearer error up front instead).
 *   - parseVibe returns null → `{ tracks: [], error: "could_not_parse" }`.
 *   - no seed grounds → `{ tracks: [], error: "could_not_ground" }`.
 */
export async function POST(req: Request): Promise<Response> {
  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

  // 6/min/user — bounds LLM + 2× search + 1 radio per build against BYOK +
  // the operator's shared InnerTube quota. Generous for a human (each prompt
  // is deliberate), stops a tight client loop.
  const rl = rateLimit({ key: `vibe:${userId}`, limit: 6, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // Parse the request body. Malformed JSON → clean 400, not a throw.
  let body: { prompt?: unknown };
  try {
    body = (await req.json()) as { prompt?: unknown };
  } catch {
    return NextResponse.json(
      { tracks: [], error: "invalid_json" },
      { status: 400 },
    );
  }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json(
      { tracks: [], error: "empty_prompt" },
      { status: 400 },
    );
  }

  try {
    // BYOK (SP-2): the LLM is the signed-in user's own key, not server GLM.
    // createByokLlm returns null when no key is configured — pass NullLlm so
    // the engine's call shape is unchanged (parseVibe checks isConfigured()).
    const llm = (await createByokLlm(supabase, userId)) ?? NullLlm;
    if (!llm.isConfigured()) {
      // Clean degrade: the vibe surface fundamentally needs intent parsing.
      return NextResponse.json({ tracks: [], error: "vibe_needs_llm" });
    }

    const constraints = await parseVibe(prompt, llm);
    if (!constraints) {
      return NextResponse.json({ tracks: [], error: "could_not_parse" });
    }

    const candidateSource = createYoutubeCandidateSource();
    const resolved = await resolveVibeSeed(constraints, candidateSource);
    if (!resolved) {
      return NextResponse.json({ tracks: [], error: "could_not_ground" });
    }

    const trackStore = createSupabaseTrackStore(supabase);
    const [history, likes] = await Promise.all([
      trackStore.loadHistory(userId),
      trackStore.loadLikes(userId),
    ]);

    const radio = await buildRadio({
      seedTrackId: resolved.seed.trackId,
      history,
      candidateSource,
      tagStore: toNarrowTagStore(trackStore),
      llm,
      options: { likes: new Set(likes.map((l) => l.trackId)) },
    });

    // Post-filter by exclude words (lowercased substring match on title).
    // `exclude` already arrives lowercased from parseVibe, but we normalise
    // again so a future caller can't bypass the casing contract.
    const exclude = constraints.exclude.map((w) => w.toLowerCase());
    const filtered = exclude.length
      ? radio.tracks.filter((t) => {
          const title = t.title.toLowerCase();
          return !exclude.some((w) => w && title.includes(w));
        })
      : radio.tracks;
    const tracks = filtered.slice(0, constraints.length);

    return NextResponse.json({
      tracks,
      constraints,
      via: resolved.via,
    });
  } catch (err) {
    console.error("[api/vibe] failed:", err);
    // Every step above is defensive (returns null/[] on failure), so reaching
    // here is truly unexpected — surface a clean 500, not a throw.
    return NextResponse.json(
      { tracks: [], error: "vibe_build_failed" },
      { status: 500 },
    );
  }
}
