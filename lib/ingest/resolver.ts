/**
 * ISRC-first Spotify→YouTube resolver (SP-3 Task 2).
 *
 * The load-bearing IP of multi-source mixing: a Spotify track (which always
 * carries an ISRC) is resolved to a playable YouTube track so playback stays
 * YouTube-native while taste stays Spotify-comprehensive. ISRCs are the global
 * recording-work identifier — two tracks sharing an ISRC are the same
 * recording, so an ISRC match is *authoritative* (confidence "isrc"); the
 * title+artist fallback is a best-effort guess (confidence "title") that the
 * caller may weight lower or surface differently in the UI.
 *
 * Why ISRC-first and not title-first: title search on YouTube Music returns
 * covers, live versions, and lyric videos ahead of the original recording; an
 * ISRC search pins the exact recording. Empirically YouTube Music indexes by
 * ISRC well enough that searching the bare ISRC returns the right track at or
 * near slot 0, so the match check is a confirmation rather than a scan.
 *
 * Never throws — every failure mode (network, no match, malformed input)
 * resolves to `null`. The importer counts nulls as `skipped` rather than
 * aborting the whole playlist.
 */
import type { CandidateSource, MusicTrack } from "@music-ai/engine";

/** Input track — the Spotify (or YouTube) playlist item shape. */
export interface ResolverInput {
  title: string;
  artist: string;
  /** ISRC when the source provider exposes one (Spotify always does). */
  isrc?: string;
}

/** A resolved YouTube track plus the confidence of the match. */
export type ResolvedTrack =
  | { track: MusicTrack; confidence: "isrc" }
  | { track: MusicTrack; confidence: "title" };

/** Normalise an ISRC for comparison: uppercase, strip whitespace, no hyphens. */
function normaliseIsrc(isrc: string): string {
  return isrc.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Resolve one external track to a playable YouTube Music track.
 *
 * Order:
 *   1. If `input.isrc` is present, `searchTracks(isrc)` and return the first
 *      result whose own `isrc` equals the query (confidence "isrc"). ISRCs are
 *      globally unique; this is an authoritative match.
 *   2. Otherwise (or if no ISRC match): `searchTracks(`${artist} ${title}`)`
 *      and return the first result (confidence "title").
 *   3. If both yield nothing → `null`. Never fabricates a track.
 *
 * Defensive: any thrown error from `searchTracks` is swallowed and treated as
 * an empty result for that branch (then the other branch runs, or we return
 * null). The importer must never crash on one bad track.
 */
export async function resolveToYoutube(
  input: ResolverInput,
  candidateSource: CandidateSource,
): Promise<ResolvedTrack | null> {
  const isrc = input.isrc?.trim();
  if (isrc) {
    const target = normaliseIsrc(isrc);
    try {
      const results = await candidateSource.searchTracks(isrc, 10);
      for (const track of results) {
        if (track.isrc && normaliseIsrc(track.isrc) === target) {
          return { track, confidence: "isrc" };
        }
      }
      // No ISRC-tagged result. Fall through to title search — YouTube Music
      // often returns the right track as the top hit even when it doesn't echo
      // the ISRC back, so the title fallback is a useful second chance, not a
      // admission of defeat.
    } catch (err) {
      console.error(
        "[ingest/resolver] isrc search failed:",
        isrc,
        (err as Error)?.message ?? err,
      );
    }
  }

  const query = `${input.artist} ${input.title}`.trim();
  if (!query) return null;
  try {
    const results = await candidateSource.searchTracks(query, 1);
    if (results[0]) {
      return { track: results[0], confidence: "title" };
    }
  } catch (err) {
    console.error(
      "[ingest/resolver] title search failed:",
      query,
      (err as Error)?.message ?? err,
    );
  }
  return null;
}
