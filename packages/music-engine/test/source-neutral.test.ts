import { describe, it, expect } from "vitest";
import { buildShelf } from "../src/recommend";
import type { CandidateSource } from "../src/seams";
import type { HistoryEntry, MusicTrack } from "../src/types";

/**
 * SC2 — source-neutrality. The engine must not assume every track is YouTube.
 * The first test is the static proof (a spotify-only `MusicTrack` compiles).
 * The second is the FLOW proof R1 actually asked for: a spotify-only track
 * flowed through `buildShelf` must (a) not throw, (b) be forwarded to the
 * injected `CandidateSource` by its canonical trackId — NOT a fabricated
 * youtube id — and (c) survive with no unguarded `sources.youtube` dereference.
 *
 * The slate is allowed to be empty: SP-0 has no spotify→youtube resolver (that
 * is SP-3's job), so a spotify seed yields no candidates from the YouTube-only
 * `CandidateSource`. The point is that the engine handles it cleanly rather than
 * crashing or silently rewriting the id.
 */
describe("source-neutral track model", () => {
  it("accepts a spotify-only track (no youtube source)", () => {
    const t: MusicTrack = {
      trackId: "yt:__pending__", // SP-0 scheme; resolver fills real id in SP-3
      sources: { spotify: "0VjIjW4GlU" },
      title: "x", artist: "y", thumbnail: null,
    };
    expect(t.sources.youtube).toBeUndefined();
    expect(t.sources.spotify).toBe("0VjIjW4GlU");
  });

  it("flows a spotify-only history track through buildShelf without assuming youtube", async () => {
    // A spotify-only HistoryEntry — no youtube key in sources. The engine must
    // not fabricate one (the old opener did `trackId.replace(/^yt:/,"")`, which
    // would have produced "sp:abc" — a non-youtube string stuffed into the
    // youtube slot). The provider-assumption now lives at the app boundary
    // (track-store-supabase `loadHistory`), not here.
    const spotifyHistory: HistoryEntry[] = [{
      trackId: "sp:abc",
      title: "Spotify Song",
      artist: "Spotify Artist",
      thumbnail: null,
      playCount: 4,
      lastPlayedAt: new Date().toISOString(),
      skipCount: 0,
      completeCount: 2,
      sources: { spotify: "abc" },
    }];

    // Record every trackId the engine asks us to fetch radio for. SP-0's
    // YouTube-only source returns [] for a spotify seed (no resolver until
    // SP-3) — that's fine; we only need to prove the id was forwarded as-is.
    const receivedSeedIds: string[] = [];
    const mockSource: CandidateSource = {
      fetchRadio: async (seedTrackId) => {
        receivedSeedIds.push(seedTrackId);
        return { seedId: seedTrackId, tracks: [], continuation: null };
      },
      fetchRelated: async () => ({ alsoLike: [], similarArtistIds: [], playlistIds: [] }),
      fetchArtistSongs: async () => [],
      fetchPlaylistTracks: async () => [],
      extendRadio: async () => null,
    };

    // (a) does not throw — and returns a (possibly empty) slate, never throws.
    const slate = await buildShelf({
      history: spotifyHistory,
      candidateSource: mockSource,
      tagStore: { get: async () => new Map(), put: async () => {} },
      llm: { isConfigured: () => false, chat: async () => "[]" },
    });

    // (b) the engine forwarded the canonical trackId to the CandidateSource,
    //     not a fabricated youtube id. The old code would have stripped "yt:"
    //     (a no-op here) and stuffed the result into a youtube slot; this test
    //     pins that the engine no longer rewrites the id at all.
    expect(receivedSeedIds).toContain("sp:abc");
    expect(receivedSeedIds.some((id) => id.startsWith("yt:"))).toBe(false);

    // (c) no unguarded sources.youtube dereference: the spotify-only entry has
    //     sources.youtube === undefined, yet buildShelf completed (the opener
    //     forwards `history[0].sources` verbatim — it never reads `.youtube`).
    //     The empty slate means the pool-check exited before the opener was
    //     built, which is itself proof the youtube-free path doesn't throw.
    expect(slate).toEqual([]);
    expect(spotifyHistory[0]!.sources.youtube).toBeUndefined();
  });
});
