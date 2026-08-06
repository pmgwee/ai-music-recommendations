import type { MusicTrack } from "./types";
import { assemble, pickSeeds, score, type ScoreContext } from "./ranking";
import { sequence } from "./similarity";
import { ensureTagVectors, type TagStore, type TrackInput } from "./tags";
import type { CandidateSource, LlmProvider } from "./seams";
import type {
  Candidate,
  CandidateOrigin,
  HistoryEntry,
  LikedTrack,
  Occurrence,
} from "./types";

/**
 * The recommender pipeline. Mirrors the two-stage architecture both Spotify and
 * Apple Music describe publicly:
 *
 *   1. CANDIDATE GENERATION — cheap, recall-oriented, hundreds of candidates
 *      pulled from five anonymous YouTube Music surfaces (`sources.ts`).
 *   2. RANKING + ASSEMBLY — behavioural scoring, diversity caps and an
 *      epsilon-greedy exploration budget (`ranking.ts`).
 *   3. SEQUENCING — order the slate so adjacent tracks flow (`similarity.ts`).
 *
 * Nothing here is authenticated. Nothing expires.
 *
 * SEAMS. Candidate generation and the tag cache are INJECTED — the engine never
 * imports `./sources` or any Supabase-backed store. Callers pass a
 * `CandidateSource`, a narrow `TagStore` (the cache), and an `LlmProvider`. This
 * keeps the engine pure (no next / @supabase / server-only) and lets the same
 * pipeline run in tests, the app, or against a future non-YouTube provider.
 */

/** Seeds per shelf build. Each is one HTTP call; the pool grows ~50/seed. */
const SEED_COUNT = 4;
/** Extra one-hop sources — an adjacent artist and an editorial playlist. */
const SIMILAR_ARTIST_FANOUT = 2;
const EDITORIAL_FANOUT = 1;

class CandidatePool {
  private readonly byId = new Map<string, Candidate>();

  add(track: MusicTrack, occurrence: Occurrence): void {
    const existing = this.byId.get(track.trackId);
    if (existing) {
      existing.occurrences.push(occurrence);
      return;
    }
    this.byId.set(track.trackId, { track, occurrences: [occurrence] });
  }

  addMany(
    tracks: MusicTrack[],
    sourceId: string,
    origin: CandidateOrigin,
    seedWeight: number,
  ): void {
    tracks.forEach((track, rank) => this.add(track, { sourceId, origin, rank, seedWeight }));
  }

  values(): Candidate[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}

function toHistoryMap(history: HistoryEntry[]): Map<string, HistoryEntry> {
  return new Map(history.map((entry) => [entry.trackId, entry]));
}

/** Settle every promise; a failed source contributes nothing and never throws. */
async function settle<T>(promises: Array<Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const out: T[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") out.push(result.value);
  }
  return out;
}

export interface ShelfOptions {
  limit?: number;
  now?: number;
  random?: () => number;
  /** Learned per-transition preferences (see `store.loadTransitionBias`). */
  transitionBias?: Map<string, number>;
  /** Explicitly liked tracks — strongest confidence signal, and strong seeds. */
  likes?: LikedTrack[];
  /** Tracks to remove entirely (not-interested / active snooze). */
  suppressed?: Set<string>;
  /**
   * Cold-start prior: the listener's imported YouTube "Liked Music".
   *
   * Used ONLY to seed neighbourhoods when there is no in-app behaviour yet, and
   * never as a confidence signal — an import is not the same statement as a
   * heart tapped here, and it may be years stale. Without this, a brand-new
   * listener with a large imported library got their own liked songs shuffled
   * back at them, which is precisely the loop this recommender exists to break.
   */
  coldStart?: MusicTrack[];
}

/**
 * Liked tracks that were never played still deserve to seed a neighbourhood —
 * a like on a shelf row is a clear statement of taste even with zero plays.
 * Merge them in as synthetic history so seed selection can see them.
 */
function mergeLikesIntoHistory(history: HistoryEntry[], likes: LikedTrack[]): HistoryEntry[] {
  const known = new Set(history.map((h) => h.trackId));
  const extra: HistoryEntry[] = [];
  for (const like of likes) {
    if (known.has(like.trackId)) continue;
    extra.push({
      trackId: like.trackId,
      title: like.title,
      artist: like.artist,
      thumbnail: like.thumbnail,
      playCount: 1,
      lastPlayedAt: like.likedAt,
      skipCount: 0,
      completeCount: 0,
    });
  }
  return [...history, ...extra];
}

export interface BuildShelfArgs {
  history: HistoryEntry[];
  candidateSource: CandidateSource;
  /** Narrow tag cache (the `music_track_tags` table in the app). null skips it. */
  tagStore: TagStore | null;
  /** LLM used to compute cold-start tag vectors on a cache miss. */
  llm: LlmProvider;
  options?: ShelfOptions;
}

/**
 * Build the discovery shelf from the listener's own history.
 *
 * This is the fix for the "same songs on a loop" problem: the shelf is no longer
 * a reshuffle of what you already played, it's a ranked slate drawn from
 * neighbourhoods around your history. Measured on a 24-track history, four seeds
 * yield ~160 candidates of which ~85% have never been played.
 *
 * Returns `[]` (never throws) when there's no history or every source failed.
 */
export async function buildShelf(args: BuildShelfArgs): Promise<MusicTrack[]> {
  const { history, candidateSource, tagStore, llm } = args;
  const {
    limit = 40,
    now = Date.now(),
    random = Math.random,
    transitionBias,
    likes = [],
    suppressed = new Set<string>(),
    coldStart = [],
  } = args.options ?? {};
  if (history.length === 0 && likes.length === 0 && coldStart.length === 0) return [];

  const likeIds = new Set(likes.map((l) => l.trackId));
  let seedPool = mergeLikesIntoHistory(history, likes);

  // Cold start only: borrow the imported library to find a starting
  // neighbourhood. Once any real in-app behaviour exists this contributes
  // nothing, so the prior fades on its own rather than needing to be expired.
  if (seedPool.length === 0) {
    seedPool = coldStart.slice(0, 30).map((track) => ({
      trackId: track.trackId,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail,
      playCount: 1,
      lastPlayedAt: new Date(now).toISOString(),
      skipCount: 0,
      completeCount: 0,
    }));
  }

  const seeds = pickSeeds(seedPool, SEED_COUNT, now, random, likeIds);
  if (seeds.length === 0) return [];

  const pool = new CandidatePool();

  // --- Stage 1a: song radio for each seed (the highest-yield source) ---------
  // The candidateSource strips the "yt:" prefix internally; pass the raw trackId.
  const radios = await settle(seeds.map((seed) => candidateSource.fetchRadio(seed.trackId)));
  radios.forEach((radio, index) => {
    const seed = seeds[index];
    pool.addMany(radio.tracks, radio.seedId, "radio", seed?.playCount ?? 1);
  });

  // --- Stage 1b: the related page of the strongest seed ----------------------
  // One call yields three more shelves: "You might also like" (playable),
  // "Similar artists" (Spotify's removed /related-artists), and YouTube's
  // editorial playlists (Apple's curated layer).
  const strongest = seeds[0];
  const related = strongest
    ? await candidateSource.fetchRelated(strongest.trackId)
    : { alsoLike: [], similarArtistIds: [], playlistIds: [] };

  pool.addMany(related.alsoLike, `also:${strongest?.trackId ?? ""}`, "also-like", strongest?.playCount ?? 1);

  // --- Stage 1c: one hop out — adjacent artists and editorial curation -------
  const [artistBatches, playlistBatches] = await Promise.all([
    settle(
      related.similarArtistIds
        .slice(0, SIMILAR_ARTIST_FANOUT)
        .map(async (id) => ({ id, tracks: await candidateSource.fetchArtistSongs(id) })),
    ),
    settle(
      related.playlistIds
        .slice(0, EDITORIAL_FANOUT)
        .map(async (id) => ({ id, tracks: await candidateSource.fetchPlaylistTracks(id) })),
    ),
  ]);
  for (const batch of artistBatches) {
    pool.addMany(batch.tracks, `artist:${batch.id}`, "similar-artist", 1);
  }
  for (const batch of playlistBatches) {
    pool.addMany(batch.tracks, `playlist:${batch.id}`, "editorial", 1);
  }

  if (pool.size === 0) return [];

  // --- Stage 2: rank and assemble -------------------------------------------
  // Suppressed tracks are DROPPED, not down-ranked: a listener who said "not
  // this" should not have to keep saying it.
  const context: ScoreContext = { history: toHistoryMap(seedPool), likes: likeIds, now };
  const scored = pool
    .values()
    .filter((candidate) => !suppressed.has(candidate.track.trackId))
    .map((candidate) => ({ candidate, value: score(candidate, context) }));

  if (scored.length === 0) return [];

  // Position-aware: open on the track the listener played most recently, so the
  // shelf starts on something trusted before it asks them to explore.
  const opener = history[0]
    ? {
        trackId: history[0].trackId,
        title: history[0].title,
        artist: history[0].artist,
        thumbnail: history[0].thumbnail,
        // The opener auto-plays first; it must resolve a YouTube id. Derive it
        // from the `yt:`-prefixed trackId — the same convention `sources.ts`
        // uses when seeding candidates from radio/related queues.
        sources: { youtube: history[0].trackId.replace(/^yt:/, "") },
        source: "local" as const,
      }
    : null;

  const slate = assemble(scored, { limit, opener, random });

  // --- Stage 3: sequence for smooth transitions ------------------------------
  // Tag the final SLATE (not the whole pool) so cold tracks — pairs that share
  // no co-occurrence source — can still be placed beside taste-neighbours via
  // the LLM tag prior. Cached per track, so only the first build pays the GLM
  // cost; a missing/failed tag just falls back to pure co-occurrence.
  const tagInputs: TrackInput[] = slate.map((c) => ({
    trackId: c.track.trackId,
    title: c.track.title,
    channel: c.track.artist,
  }));
  const tagVectors = await ensureTagVectors(tagInputs, tagStore, llm);
  return sequence(slate, 0, { transitionBias, tagVectors }).map((candidate) => candidate.track);
}

export interface RadioOptions {
  limit?: number;
  now?: number;
  /** Track ids already queued, so a continuation never repeats what's pending. */
  exclude?: string[];
  /** Learned per-transition preferences (see `store.loadTransitionBias`). */
  transitionBias?: Map<string, number>;
  /** Explicitly liked tracks — raises confidence in the ranking. */
  likes?: Set<string>;
  /** Tracks to remove entirely (not-interested / active snooze). */
  suppressed?: Set<string>;
}

export interface BuildRadioArgs {
  seedTrackId: string;
  history: HistoryEntry[];
  candidateSource: CandidateSource;
  tagStore: TagStore | null;
  llm: LlmProvider;
  options?: RadioOptions;
}

/**
 * Endless autoplay: given the track that just finished, produce the next batch.
 *
 * This is the Apple Music "Autoplay (∞)" surface — when the queue runs dry the
 * music continues instead of stopping. Deliberately more conservative than the
 * discovery shelf (Apple's Autoplay behaves the same way): it stays close to the
 * seed rather than reaching for novelty, and it filters what the listener has
 * skipped or just heard.
 */
export async function buildRadio(
  args: BuildRadioArgs,
): Promise<{ tracks: MusicTrack[]; continuation: string | null }> {
  const { seedTrackId, history, candidateSource, tagStore, llm } = args;
  const {
    limit = 25,
    now = Date.now(),
    exclude = [],
    transitionBias,
    likes = new Set<string>(),
    suppressed = new Set<string>(),
  } = args.options ?? {};

  const radio = await candidateSource.fetchRadio(seedTrackId);
  if (radio.tracks.length === 0) return { tracks: [], continuation: null };

  const historyMap = toHistoryMap(history);
  const excluded = new Set([...exclude, seedTrackId]);

  const pool = new CandidatePool();
  pool.addMany(radio.tracks, radio.seedId, "radio", 1);

  const context: ScoreContext = { history: historyMap, likes, now };
  const scored = pool
    .values()
    .filter((candidate) => !excluded.has(candidate.track.trackId))
    .filter((candidate) => !suppressed.has(candidate.track.trackId))
    // Never autoplay something previously skipped — unless it was later liked,
    // which supersedes an old skip (people do come back to a song).
    .filter((candidate) => {
      const skips = historyMap.get(candidate.track.trackId)?.skipCount ?? 0;
      return skips === 0 || likes.has(candidate.track.trackId);
    })
    .map((candidate) => ({ candidate, value: score(candidate, context) }));

  if (scored.length === 0) return { tracks: [], continuation: radio.continuation };

  // Lower epsilon than the shelf: autoplay should feel like a continuation of
  // what's playing, not a jump somewhere new.
  const slate = assemble(scored, { limit, epsilon: 0.05, maxPerArtist: 2 });
  const tagInputs: TrackInput[] = slate.map((c) => ({
    trackId: c.track.trackId,
    title: c.track.title,
    channel: c.track.artist,
  }));
  const tagVectors = await ensureTagVectors(tagInputs, tagStore, llm);
  const ordered = sequence(slate, 0, { transitionBias, tagVectors });

  return {
    tracks: ordered.map((candidate) => candidate.track),
    continuation: radio.continuation,
  };
}

export interface ContinueRadioArgs {
  continuation: string;
  candidateSource: CandidateSource;
  exclude?: string[];
}

/**
 * Extend an in-flight radio queue by one page. Used when a long session
 * exhausts the first 50 tracks — the queue is genuinely unbounded.
 */
export async function continueRadio(
  args: ContinueRadioArgs,
): Promise<{ tracks: MusicTrack[]; continuation: string | null }> {
  const { continuation, candidateSource, exclude = [] } = args;
  const page = await candidateSource.extendRadio(continuation);
  if (!page) return { tracks: [], continuation: null };
  const excluded = new Set(exclude);
  return {
    tracks: page.tracks.filter((track) => !excluded.has(track.trackId)),
    continuation: page.continuation,
  };
}
