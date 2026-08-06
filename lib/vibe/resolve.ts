/**
 * Vibe grounding — resolve the LLM's structured constraints to ONE concrete
 * seed track. SP-5's `/api/vibe` calls this between `parseVibe` and
 * `buildRadio`.
 *
 * The discipline here is the lesson from every DSP's vibe feature (Spotify AI
 * Playlist, YouTube "Ask Music", Apple Playlist Playground) and from GLIDE:
 * the model is never allowed to emit a free-form title or a hallucinated id.
 * `parseVibe` returns only the *name* of a seed (`seedNames[0]`, an artist or
 * "artist - song" string); this module turns that name into a real `trackId`
 * via the anonymous YouTube Music search seam. The retriever picks the song —
 * the LLM only captures intent.
 *
 * Two paths:
 *   - **named** — the LLM extracted a specific seed. Search for it verbatim.
 *   - **synthesized** — only tags (genres / moods / eras). Build a query from
 *     the tags via `synthSeedQuery` and search that. Less precise but still
 *     grounds the radio in a real track instead of a vague intent.
 *
 * Returns `null` when neither path yields a playable track — the caller then
 * answers with `{ error: "could_not_ground" }` rather than guessing.
 */
import type {
  CandidateSource,
  MusicTrack,
} from "@music-ai/engine";
import { synthSeedQuery, type VibeConstraints } from "@music-ai/engine";

export type VibeSeedVia = "named" | "synthesized";

export interface ResolvedVibeSeed {
  seed: MusicTrack;
  via: VibeSeedVia;
}

/**
 * Resolve a vibe's constraints to one concrete seed track.
 *
 * Order of precedence: a named seed wins (it's the strongest signal — the
 * user said "like X"); otherwise synthesise a query from the tags. We take the
 * FIRST search hit because YouTube's song-search relevance is good and because
 * `buildRadio` needs exactly one seed — going deeper would be cost for no
 * recall gain (the radio fans out to ~50 candidates from that one seed).
 */
export async function resolveVibeSeed(
  constraints: VibeConstraints,
  candidateSource: CandidateSource,
): Promise<ResolvedVibeSeed | null> {
  const named = constraints.seedNames[0];
  if (named) {
    const tracks = await candidateSource.searchTracks(named, 1);
    if (tracks[0]) {
      return { seed: tracks[0], via: "named" };
    }
  }
  // Either no name was given, or the named search returned nothing. Fall
  // through to a synthesised tag query so a tag-only prompt ("chill indie")
  // still grounds. `synthSeedQuery` joins genres + moods + eras (≤4 tokens).
  const synthed = synthSeedQuery(constraints);
  if (!synthed) return null;
  const tracks = await candidateSource.searchTracks(synthed, 1);
  if (tracks[0]) {
    return { seed: tracks[0], via: "synthesized" };
  }
  return null;
}
