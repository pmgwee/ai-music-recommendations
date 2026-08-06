/**
 * `resolveVibeSeed` — pure resolver tests (no network, no DB).
 *
 * Mocks only the `CandidateSource.searchTracks` seam. Asserts:
 *   - a named seed grounds via `searchTracks(seedName)` and reports `via: named`
 *   - a tag-only prompt synthesises a query (no `searchTracks("")` call) and
 *     reports `via: synthesized`
 *   - empty constraints (no names, no tags) → null, no search call
 *   - search returns [] → null (the caller surfaces "could_not_ground")
 *   - when a named seed search yields nothing, we fall back to synthesise
 */
import { describe, it, expect } from "vitest";
import { resolveVibeSeed } from "./resolve";
import type { CandidateSource, MusicTrack } from "@music-ai/engine";

function track(id: string): MusicTrack {
  return {
    trackId: `yt:${id}`,
    sources: { youtube: id },
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    thumbnail: null,
  };
}

function mockSource(searchImpl: (q: string, limit?: number) => Promise<MusicTrack[]>): CandidateSource {
  return {
    fetchRadio: async () => ({ seedId: "yt:s", tracks: [], continuation: null }),
    fetchRelated: async () => ({ alsoLike: [], similarArtistIds: [], playlistIds: [] }),
    fetchArtistSongs: async () => [],
    fetchPlaylistTracks: async () => [],
    extendRadio: async () => null,
    searchTracks: searchImpl,
  };
}

describe("resolveVibeSeed", () => {
  it("grounds a named seed via searchTracks(seedName) and reports via='named'", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      return [track("aa")];
    });
    const result = await resolveVibeSeed(
      { genres: ["indie"], moods: ["dreamy"], eras: [], seedNames: ["Arctic Monkeys - Do I Wanna Know"], exclude: [], length: 20 },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.via).toBe("named");
    expect(result!.seed.trackId).toBe("yt:aa");
    // The named seed was searched verbatim.
    expect(calls).toEqual(["Arctic Monkeys - Do I Wanna Know"]);
  });

  it("synthesises a query from tags when no seed name is present (via='synthesized')", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      return [track("synth1")];
    });
    const result = await resolveVibeSeed(
      { genres: ["indie", "rock"], moods: ["chill"], eras: ["2010s"], seedNames: [], exclude: [], length: 25 },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.via).toBe("synthesized");
    expect(result!.seed.trackId).toBe("yt:synth1");
    // Exactly one search call, with the synthesised query (tags joined, ≤4).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("indie rock chill 2010s");
  });

  it("returns null and searches nothing when constraints are empty (no names, no tags)", async () => {
    let calls = 0;
    const source = mockSource(async () => {
      calls++;
      return [];
    });
    const result = await resolveVibeSeed(
      { genres: [], moods: [], eras: [], seedNames: [], exclude: [], length: 25 },
      source,
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("returns null when the named search yields nothing AND there are no tags to synthesise", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      return [];
    });
    const result = await resolveVibeSeed(
      { genres: [], moods: [], eras: [], seedNames: ["Obscure Artist - Unfindable"], exclude: [], length: 10 },
      source,
    );
    expect(result).toBeNull();
    // Named search ran; no synth query because no tags.
    expect(calls).toEqual(["Obscure Artist - Unfindable"]);
  });

  it("falls back to a synthesised query when the named search returns nothing", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      // First call (named) returns nothing; second call (synth) hits.
      if (calls.length === 1) return [];
      return [track("fallback")];
    });
    const result = await resolveVibeSeed(
      { genres: ["pop"], moods: ["happy"], eras: [], seedNames: ["Mystery Seed"], exclude: [], length: 15 },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.via).toBe("synthesized");
    expect(result!.seed.trackId).toBe("yt:fallback");
    expect(calls).toEqual(["Mystery Seed", "pop happy"]);
  });
});
