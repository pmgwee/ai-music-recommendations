import { describe, it, expect } from "vitest";
import { buildShelf, buildRadio, continueRadio } from "../src/recommend";
import type { CandidateSource } from "../src/seams";
import type { HistoryEntry, MusicTrack } from "../src/types";

/**
 * Task 9: the recommend pipeline must run end-to-end through INJECTED seams.
 * The engine never imports `./sources` or `createDbTagStore` directly — the
 * candidate source and tag store are passed in, so the engine stays pure and
 * testable without YouTube or Supabase.
 *
 * The mock candidate source below mirrors the InnerTube shape (radio queue with
 * one track). The mock tag store returns nothing cached, so `ensureTagVectors`
 * falls through to the LLM stub, which replies "[]" (no tags) — `sequence()`
 * then degrades to pure co-occurrence, still producing a smooth slate.
 */

const radioTrack: MusicTrack = {
  trackId: "yt:r1",
  sources: { youtube: "r1" },
  title: "r",
  artist: "a",
  thumbnail: null,
};

const mockSource: CandidateSource = {
  fetchRadio: async () => ({
    seedId: "yt:seed",
    tracks: [radioTrack],
    continuation: "tok-1",
  }),
  fetchRelated: async () => ({ alsoLike: [], similarArtistIds: [], playlistIds: [] }),
  fetchArtistSongs: async () => [],
  fetchPlaylistTracks: async () => [],
  extendRadio: async () => ({
    seedId: "yt:seed",
    tracks: [{ trackId: "yt:r2", sources: { youtube: "r2" }, title: "r2", artist: "b", thumbnail: null }],
    continuation: null,
  }),
};

const history: HistoryEntry[] = [{
  trackId: "yt:seed",
  title: "s",
  artist: "a",
  thumbnail: null,
  playCount: 3,
  lastPlayedAt: new Date().toISOString(),
  skipCount: 0,
  completeCount: 1,
}];

describe("buildShelf", () => {
  it("produces a slate through injected seams without touching youtube directly", async () => {
    const slate = await buildShelf({
      history,
      candidateSource: mockSource,
      // Empty cache → LLM stub returns "[]" → sequence() falls back to pure
      // co-occurrence (still produces an ordered slate).
      tagStore: { get: async () => new Map(), put: async () => {} },
      llm: { isConfigured: () => true, chat: async () => "[]" },
    });
    expect(slate.length).toBeGreaterThan(0);
    expect(slate[0]!.trackId.startsWith("yt:")).toBe(true);
  });
});

describe("buildRadio", () => {
  it("returns radio tracks through the injected candidate source", async () => {
    const result = await buildRadio({
      seedTrackId: "yt:seed",
      history,
      candidateSource: mockSource,
      tagStore: { get: async () => new Map(), put: async () => {} },
      llm: { isConfigured: () => true, chat: async () => "[]" },
    });
    expect(result.tracks.length).toBeGreaterThan(0);
    expect(result.continuation).toBe("tok-1");
  });
});

describe("continueRadio", () => {
  it("extends an in-flight queue via candidateSource.extendRadio", async () => {
    const result = await continueRadio({
      continuation: "tok-1",
      candidateSource: mockSource,
      exclude: [],
    });
    expect(result.tracks.length).toBe(1);
    expect(result.tracks[0]!.trackId).toBe("yt:r2");
    expect(result.continuation).toBeNull();
  });
});
