/** Per-provider ids for one canonical track. youtube = 11-char videoId; spotify = track id. */
export interface TrackSources {
  youtube?: string;
  spotify?: string;
}

/** A playable track — the engine's shared currency. Keys on canonical `trackId`,
 *  NOT on any provider id. Playback resolves the best available source. */
export interface MusicTrack {
  /** Canonical id. SP-0: "yt:<videoId>". SP-3: ISRC when known, else source-tagged. */
  trackId: string;
  /** ISRC — global canonical recording id. Unused in SP-0; load-bearing in SP-3. */
  isrc?: string;
  sources: TrackSources;
  title: string;
  artist: string;       // was `channel` in subscription-agent
  thumbnail: string | null;
  durationMs?: number;
  /** Provenance for shelf badges. */
  source?: "local" | "recommended";
}

export type CandidateOrigin =
  | "radio" | "also-like" | "similar-artist" | "editorial" | "history";

export interface Occurrence {
  sourceId: string;
  origin: CandidateOrigin;
  rank: number;
  seedWeight: number;
}

export interface Candidate {
  track: MusicTrack;
  occurrences: Occurrence[];
}

export interface LikedTrack {
  trackId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  likedAt: string;
}

export interface Suppressions {
  notInterested: Set<string>;
  snoozedUntil: Map<string, string>;
}

export interface HistoryEntry {
  trackId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  playCount: number;
  lastPlayedAt: string;
  skipCount: number;
  completeCount: number;
}
