/**
 * Taste profile aggregation — pure derivation from the user's own data.
 *
 * The engine's `TrackStore` seam is the only data source: `loadHistory`
 * (HistoryEntry[] capped at 60 rows by the Supabase impl), `getTags(trackId)`
 * (the LLM-derived tag cache, catalog-global per track), and `loadLikes`.
 *
 * Design notes:
 *   - **Top artists** are weighted by `playCount + completeCount - skipCount`
 *     (the same substance as the engine's preference signal — a play is the
 *     baseline, a completion reinforces, a skip subtracts). Descending, top 10.
 *   - **Top tags** are tallied across the user's history tracks via `getTags`
 *     per track. We iterate every history row (already capped at 60), skip
 *     nulls, and take the top 12. Tags are catalog-global, so this aggregates
 *     "what kinds of tracks has this listener played" rather than per-user
 *     tag weights — which is the right signal for a taste surface.
 *   - **Stats** are simple sums over history + likes: total plays, unique
 *     tracks (history length), skip rate, complete rate, liked count. Rates
 *     are fractions of play sessions (each play can emit at most one signal),
 *     so `skipRate + completeRate ≤ 1`.
 *
 * Defensiveness: empty history → empty profile, never a throw. Every
 * aggregation is wrapped so a malformed row or a failed `getTags` can't take
 * the whole profile down — the engine stays the source of truth, this layer
 * only reports what it can read.
 *
 * Pure: no Next, no Supabase import — depends only on the engine seam type,
 * which keeps it unit-testable with a hand-rolled TrackStore.
 */
import type { TrackStore } from "@music-ai/engine";

export interface TasteArtist {
  artist: string;
  /** playCount + completeCount - skipCount, summed across that artist's rows. */
  weight: number;
}

export interface TasteTag {
  tag: string;
  /** Number of history tracks (not plays) carrying this tag. */
  count: number;
}

export interface TasteStats {
  /** Sum of `playCount` across history rows. */
  totalPlays: number;
  /** History length (unique tracks the listener has played). */
  uniqueTracks: number;
  /** Sum(skipCount) / Sum(playCount). 0 when there are no plays. */
  skipRate: number;
  /** Sum(completeCount) / Sum(playCount). 0 when there are no plays. */
  completeRate: number;
  /** Number of liked tracks (length of `loadLikes`). */
  likedCount: number;
}

export interface TasteProfile {
  topArtists: TasteArtist[];
  topTags: TasteTag[];
  stats: TasteStats;
}

/** Cap the displayed lists so the UI stays scannable. */
const TOP_ARTISTS_CAP = 10;
const TOP_TAGS_CAP = 12;

/**
 * Build a taste profile for `userId` from `trackStore`. Always resolves to a
 * `TasteProfile` (possibly empty) — never throws.
 */
export async function buildTasteProfile(
  trackStore: Pick<TrackStore, "loadHistory" | "getTags" | "loadLikes">,
  userId: string,
): Promise<TasteProfile> {
  // Load the three sources defensively — a failure in any one degrades to
  // empty, never throws the whole profile.
  const [history, likes] = await Promise.all([
    safeCall(() => trackStore.loadHistory(userId), []),
    safeCall(() => trackStore.loadLikes(userId), []),
  ]);

  // --- stats -----------------------------------------------------------------
  let totalPlays = 0;
  let totalSkips = 0;
  let totalCompletes = 0;
  for (const row of history) {
    const plays = num(row.playCount);
    totalPlays += plays;
    totalSkips += num(row.skipCount);
    totalCompletes += num(row.completeCount);
  }
  const stats: TasteStats = {
    totalPlays,
    uniqueTracks: history.length,
    skipRate: totalPlays > 0 ? totalSkips / totalPlays : 0,
    completeRate: totalPlays > 0 ? totalCompletes / totalPlays : 0,
    likedCount: likes.length,
  };

  // --- top artists (weighted play+complete-skip, desc) ----------------------
  const artistWeights = new Map<string, number>();
  for (const row of history) {
    const artist = (row.artist ?? "").trim();
    if (!artist) continue; // unknown artist — don't lump under ""
    const playCount = num(row.playCount);
    const skipCount = num(row.skipCount);
    const completeCount = num(row.completeCount);
    const weight = playCount + completeCount - skipCount;
    artistWeights.set(artist, (artistWeights.get(artist) ?? 0) + weight);
  }
  const topArtists: TasteArtist[] = [...artistWeights.entries()]
    .map(([artist, weight]) => ({ artist, weight }))
    .sort((a, b) => b.weight - a.weight || a.artist.localeCompare(b.artist))
    .slice(0, TOP_ARTISTS_CAP);

  // --- top tags (tally per-track tags across history) -----------------------
  // getTags is per-trackId and catalog-global. We fan out one call per history
  // row in parallel — loadHistory already caps at 60, so this is bounded.
  const tagCounts = new Map<string, number>();
  const tagSets = await Promise.all(
    history.map((row) =>
      safeCall(() => trackStore.getTags(row.trackId), null as string[] | null),
    ),
  );
  for (const tags of tagSets) {
    if (!tags) continue;
    // Dedupe within a track so a track that appears N times in history (it
    // can't — history is one row per trackId — but be safe) doesn't
    // over-count. Also collapses dup tags within one track's tag list.
    const unique = new Set(tags.map((t) => String(t).trim()).filter(Boolean));
    for (const tag of unique) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const topTags: TasteTag[] = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, TOP_TAGS_CAP);

  return { topArtists, topTags, stats };
}

/** Coerce a possibly-null DB number to a finite non-negative int. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Await `fn()`, returning `fallback` on any throw. Never propagulates. */
async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
