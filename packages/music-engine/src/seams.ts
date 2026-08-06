/**
 * The four provider seams — interfaces the engine consumes; the app provides
 * launch implementations. See spec §8 for the contracts.
 *
 * Physical boundary (spec §3): the engine package has zero app-framework
 * dependencies (no next / @supabase/* / react / server-only). Anything that
 * touches those worlds lives behind one of these seams.
 *
 * NOTE: `RadioQueue` and `RelatedShelves` are imported from `./sources`, which
 * is ported in Task 8. Until then this file's typecheck is intentionally
 * pending — `LlmProvider` (the only seam Task 7 actually exercises, via the
 * vibe test) has no dependency on `./sources` and compiles standalone.
 */
import type { MusicTrack, HistoryEntry, LikedTrack, Suppressions } from "./types";
import type { RadioQueue, RelatedShelves } from "./sources";

/**
 * Any subscribable stream. The concrete type (minimal emitter / RxJS / React
 * signal) is chosen by the app impl — spec §8 explicitly defers this from
 * SP-0's contract lock.
 */
export type Observable<T> = { subscribe: (cb: (v: T) => void) => () => void };

/** Replaces the direct lib/ai/zai.ts import the engine used to carry. */
export interface LlmProvider {
  isConfigured(): boolean;
  chat(opts: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    temperature?: number;
    json?: boolean;
    maxTokens?: number;
    thinkingDisabled?: boolean;
  }): Promise<string>;
}

/** Abstracts use-yt-player.ts transport. */
export interface PlayerProvider {
  load(track: MusicTrack): Promise<void>;
  play(): void;
  pause(): void;
  next(): void;
  seek(seconds: number): void;
  setVolume(v: number): void; // 0..100
  // observable state stream — concrete type chosen in the app impl.
  state$: Observable<{
    current: MusicTrack | null;
    isPlaying: boolean;
    position: number;
    duration: number;
  }>;
}

/** Interfaces only in the engine; the Supabase impl lives in the app. */
export interface TrackStore {
  loadHistory(userId: string): Promise<HistoryEntry[]>;
  loadLikes(userId: string): Promise<LikedTrack[]>;
  loadSuppressions(userId: string): Promise<Suppressions>;
  recordPlay(userId: string, track: MusicTrack): Promise<void>;
  recordSignal(userId: string, trackId: string, signal: "skip" | "complete"): Promise<void>;
  loadTransitionBias(userId: string): Promise<Map<string, number>>;
  // tag cache (LLM prior) — keyed by trackId
  getTags(trackId: string): Promise<string[] | null>;
  setTags(trackId: string, tags: string[]): Promise<void>;
}

/** InnerTube impl lives in-engine behind this seam. */
export interface CandidateSource {
  fetchRadio(seedTrackId: string): Promise<RadioQueue>;
  fetchRelated(seedTrackId: string): Promise<RelatedShelves>;
  fetchArtistSongs(channelId: string): Promise<MusicTrack[]>;
  fetchPlaylistTracks(playlistId: string): Promise<MusicTrack[]>;
  extendRadio(continuation: string): Promise<RadioQueue | null>;
  /**
   * Anonymous YouTube Music search — grounds a free-text query (a vibe seed
   * name, or a synthesised tag query) to real, playable tracks. SP-5's vibe
   * surface uses this to resolve the LLM's `seedNames[0]` to a concrete
   * `trackId` before `buildRadio` takes over; the LLM is never allowed to emit
   * a free-form id (see `vibe.ts`). Returns at most `limit` tracks (default 10).
   *
   * Like the other sources, this is signed-out InnerTube — no credential,
   * nothing to expire.
   */
  searchTracks(query: string, limit?: number): Promise<MusicTrack[]>;
}
