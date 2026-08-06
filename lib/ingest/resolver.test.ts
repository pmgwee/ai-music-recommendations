/**
 * `resolveToYoutube` — pure resolver tests (no network, no DB).
 *
 * Mocks only `CandidateSource.searchTracks`. Asserts the SP-3 contract:
 *   (a) ISRC match wins when the search result echoes the input ISRC
 *       (confidence "isrc").
 *   (b) Title+artist fallback is used when there is no ISRC, or when the ISRC
 *       search yields no echoing result (confidence "title").
 *   (c) Returns null when neither path yields a track — never fabricates.
 *   (d) Swallows a thrown `searchTracks` and falls through / returns null
 *       rather than crashing the importer.
 *   (e) ISRC comparison is case- and hyphen-insensitive (USUM71703991 vs
 *       usum717-03991).
 */
import { describe, it, expect } from "vitest";
import { resolveToYoutube } from "./resolver";
import type { CandidateSource, MusicTrack } from "@music-ai/engine";

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    trackId: `yt:${id}`,
    sources: { youtube: id },
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    thumbnail: null,
    ...overrides,
  };
}

function mockSource(
  searchImpl: (q: string, limit?: number) => Promise<MusicTrack[]>,
): CandidateSource {
  return {
    fetchRadio: async () => ({ seedId: "yt:s", tracks: [], continuation: null }),
    fetchRelated: async () => ({ alsoLike: [], similarArtistIds: [], playlistIds: [] }),
    fetchArtistSongs: async () => [],
    fetchPlaylistTracks: async () => [],
    extendRadio: async () => null,
    searchTracks: searchImpl,
  };
}

describe("resolveToYoutube", () => {
  it("(a) returns the ISRC-matching result with confidence 'isrc'", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      // First result carries a DIFFERENT isrc; second carries the matching one.
      // Asserts the resolver scans the whole page rather than trusting slot 0.
      return [
        track("aa", { isrc: "OTHER0000000" }),
        track("bb", { isrc: "USUM71703991" }),
      ];
    });
    const result = await resolveToYoutube(
      { title: "Blinding Lights", artist: "The Weeknd", isrc: "USUM71703991" },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("isrc");
    expect(result!.track.trackId).toBe("yt:bb");
    // Searched by the raw ISRC (the normalisation happens on the compare side).
    expect(calls).toEqual(["USUM71703991"]);
  });

  it("(a) ISRC match is case- and separator-insensitive", async () => {
    const source = mockSource(async () => [
      track("bb", { isrc: "usum717-03991" }),
    ]);
    const result = await resolveToYoutube(
      { title: "x", artist: "y", isrc: "USUM71703991" },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("isrc");
    expect(result!.track.trackId).toBe("yt:bb");
  });

  it("(b) falls back to title+artist when no ISRC is provided", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      return [track("tt")];
    });
    const result = await resolveToYoutube(
      { title: "Redbone", artist: "Childish Gambino" },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("title");
    expect(result!.track.trackId).toBe("yt:tt");
    expect(calls).toEqual(["Childish Gambino Redbone"]);
  });

  it("(b) falls back to title+artist when the ISRC search yields results but none echo the ISRC", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      // ISRC search returns covers that don't carry the exact ISRC; the title
      // search then runs and hits.
      if (q === "USUM71703991") {
        return [track("cover1", { isrc: "DIFFERENT0001" })];
      }
      return [track("real")];
    });
    const result = await resolveToYoutube(
      { title: "Blinding Lights", artist: "The Weeknd", isrc: "USUM71703991" },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("title");
    expect(result!.track.trackId).toBe("yt:real");
    expect(calls).toEqual(["USUM71703991", "The Weeknd Blinding Lights"]);
  });

  it("(c) returns null when both ISRC and title searches yield nothing", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      return [];
    });
    const result = await resolveToYoutube(
      { title: "Unfindable", artist: "Nobody", isrc: "NOEXIST000000" },
      source,
    );
    expect(result).toBeNull();
    // Both branches ran.
    expect(calls).toEqual(["NOEXIST000000", "Nobody Unfindable"]);
  });

  it("(c) returns null when there is no ISRC and the title search is empty", async () => {
    const source = mockSource(async () => []);
    const result = await resolveToYoutube(
      { title: "Unfindable", artist: "Nobody" },
      source,
    );
    expect(result).toBeNull();
  });

  it("(c) returns null on an empty title+artist query (no ISRC)", async () => {
    let calls = 0;
    const source = mockSource(async () => {
      calls++;
      return [];
    });
    const result = await resolveToYoutube({ title: "   ", artist: "" }, source);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("(d) swallows an ISRC-search throw and falls through to title search", async () => {
    const calls: string[] = [];
    const source = mockSource(async (q) => {
      calls.push(q);
      if (q === "THROW001") throw new Error("network");
      return [track("recover")];
    });
    const result = await resolveToYoutube(
      { title: "Recover", artist: "Author", isrc: "THROW001" },
      source,
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("title");
    expect(result!.track.trackId).toBe("yt:recover");
    expect(calls).toEqual(["THROW001", "Author Recover"]);
  });

  it("(d) returns null (does not throw) when title search throws after no ISRC", async () => {
    const source = mockSource(async () => {
      throw new Error("network");
    });
    const result = await resolveToYoutube(
      { title: "Anything", artist: "Anyone" },
      source,
    );
    expect(result).toBeNull();
  });
});
