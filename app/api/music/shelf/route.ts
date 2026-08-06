import { NextResponse } from "next/server";
import {
  buildShelf,
  createYoutubeCandidateSource,
} from "@music-ai/engine";
import { createGlmLlm } from "@/lib/providers/llm-glm";
import { toNarrowTagStore } from "@/lib/providers/tag-store-adapter";
import { resolveSp0DevContext } from "@/lib/music/sp0-dev";

/**
 * SP-0 SC3 proof — the discovery shelf, wired end-to-end through the four
 * injected seams: broad `TrackStore` (admin-bound), `CandidateSource`
 * (anonymous InnerTube), `LlmProvider` (GLM), and the narrow `TagStore` adapter
 * (LLM tag cache). See `lib/music/sp0-dev.ts` for the SP-0 dev-mode concession.
 *
 * With empty history + no likes, `buildShelf` returns `[]` — the UAT seeds a
 * play first, then this route returns a real neighbourhood slate.
 */
export async function GET() {
  const ctx = resolveSp0DevContext();
  if (ctx instanceof NextResponse) return ctx;
  const { devUserId, trackStore: broad } = ctx;

  try {
    const history = await broad.loadHistory(devUserId);
    const likes = await broad.loadLikes(devUserId);

    const candidateSource = createYoutubeCandidateSource();
    const llm = createGlmLlm();

    // Bridge the broad TrackStore → the narrow TagStore `buildShelf` consumes.
    const tagStore = toNarrowTagStore(broad);

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
