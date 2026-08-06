import { NextResponse } from "next/server";
import {
  buildShelf,
  createYoutubeCandidateSource,
} from "@music-ai/engine";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseTrackStore } from "@/lib/providers/track-store-supabase";
import { requireUser } from "@/lib/auth/require-user";
import { createGlmLlm } from "@/lib/providers/llm-glm";
import { toNarrowTagStore } from "@/lib/providers/tag-store-adapter";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Discovery shelf, wired end-to-end through the four injected seams: broad
 * `TrackStore` (cookie-bound), `CandidateSource` (anonymous InnerTube),
 * `LlmProvider` (GLM), and the narrow `TagStore` adapter (LLM tag cache).
 *
 * The `TrackStore` is bound to the cookie-bound server client + the signed-in
 * user — `auth.uid()` is populated, so the `log_music_*` security-invoker RPCs
 * resolve to the caller's row (the SP-0 write-path limitation is resolved by
 * this binding). With no session the route returns 401 JSON.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

  // Per-user cap: 8 shelf builds/min is generous for a human, stops a loop.
  // The InnerTube candidate source is the operator's scrape-costly shared
  // resource — a tight client loop would burn through that budget fast.
  const rl = rateLimit({ key: `shelf:${userId}`, limit: 8, windowMs: 60_000 });
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
    const history = await trackStore.loadHistory(userId);
    const likes = await trackStore.loadLikes(userId);

    const candidateSource = createYoutubeCandidateSource();
    const llm = createGlmLlm();

    // Bridge the broad TrackStore → the narrow TagStore `buildShelf` consumes.
    const tagStore = toNarrowTagStore(trackStore);

    const slate = await buildShelf({
      history,
      candidateSource,
      tagStore,
      llm,
      options: { likes },
    });

    return NextResponse.json({ tracks: slate });
  } catch (err) {
    console.error("[api/music/shelf] failed:", err);
    // buildShelf is defensive (returns [] on internal failure), so reaching
    // here means something truly unexpected — surface a clean 500, not a throw.
    return NextResponse.json(
      { error: "shelf build failed", tracks: [] },
      { status: 500 },
    );
  }
}
