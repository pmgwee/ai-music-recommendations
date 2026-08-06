/**
 * Unit tests for `buildTasteProfile` — pure aggregation over a mock TrackStore.
 *
 * Covers:
 *   - top artists weighted correctly (play + complete − skip, summed per artist)
 *   - top tags tallied across history (dedupe within a track, sorted desc)
 *   - stats arithmetic (totalPlays, uniqueTracks, skipRate, completeRate, likes)
 *   - empty history → empty profile (no throw)
 *   - getTags rejection → that track contributes no tags, profile still resolves
 */
import { describe, it, expect } from "vitest";
import type { HistoryEntry, LikedTrack, TrackStore } from "@music-ai/engine";
import { buildTasteProfile } from "./profile";

function historyRow(opts: Partial<HistoryEntry>): HistoryEntry {
  return {
    trackId: opts.trackId ?? "yt:t1",
    title: opts.title ?? "T",
    artist: opts.artist ?? "A",
    thumbnail: null,
    playCount: opts.playCount ?? 1,
    lastPlayedAt: opts.lastPlayedAt ?? "2026-08-01T00:00:00Z",
    skipCount: opts.skipCount ?? 0,
    completeCount: opts.completeCount ?? 0,
    sources: opts.sources ?? {},
  };
}

function makeTrackStore(args: {
  history?: HistoryEntry[];
  tags?: Record<string, string[] | null>;
  likes?: LikedTrack[];
  getTagsThrows?: boolean;
}): Pick<TrackStore, "loadHistory" | "getTags" | "loadLikes"> {
  const tags = args.tags ?? {};
  return {
    async loadHistory() {
      return args.history ?? [];
    },
    async loadLikes() {
      return args.likes ?? [];
    },
    async getTags(trackId: string) {
      if (args.getTagsThrows) throw new Error("boom");
      if (trackId in tags) return tags[trackId]!;
      return null;
    },
  };
}

describe("buildTasteProfile", () => {
  it("returns an empty profile for empty history", async () => {
    const store = makeTrackStore({});
    const profile = await buildTasteProfile(store, "user-1");
    expect(profile.topArtists).toEqual([]);
    expect(profile.topTags).toEqual([]);
    expect(profile.stats).toEqual({
      totalPlays: 0,
      uniqueTracks: 0,
      skipRate: 0,
      completeRate: 0,
      likedCount: 0,
    });
  });

  it("weights artists by playCount + completeCount - skipCount (descending)", async () => {
    const store = makeTrackStore({
      history: [
        // A: 5 + 3 - 1 = 7
        historyRow({ trackId: "yt:a", artist: "A", playCount: 5, completeCount: 3, skipCount: 1 }),
        // B: 2 + 2 - 0 = 4
        historyRow({ trackId: "yt:b", artist: "B", playCount: 2, completeCount: 2 }),
        // C: 10 + 0 - 4 = 6 (skips subtract)
        historyRow({ trackId: "yt:c", artist: "C", playCount: 10, skipCount: 4 }),
      ],
    });
    const profile = await buildTasteProfile(store, "user-1");
    expect(profile.topArtists.map((a) => [a.artist, a.weight])).toEqual([
      ["A", 7],
      ["C", 6],
      ["B", 4],
    ]);
  });

  it("sums weights when the same artist appears on multiple tracks", async () => {
    const store = makeTrackStore({
      history: [
        historyRow({ trackId: "yt:a1", artist: "A", playCount: 2, completeCount: 1 }),
        historyRow({ trackId: "yt:a2", artist: "A", playCount: 3, skipCount: 1 }),
        historyRow({ trackId: "yt:b1", artist: "B", playCount: 1 }),
      ],
    });
    const profile = await buildTasteProfile(store, "user-1");
    // A: (2+1-0) + (3+0-1) = 5
    // B: 1
    expect(profile.topArtists.map((a) => [a.artist, a.weight])).toEqual([
      ["A", 5],
      ["B", 1],
    ]);
  });

  it("aggregates tags across history tracks, dedupes per-track, sorts desc", async () => {
    const store = makeTrackStore({
      history: [
        historyRow({ trackId: "yt:a", artist: "A" }),
        historyRow({ trackId: "yt:b", artist: "B" }),
        historyRow({ trackId: "yt:c", artist: "C" }),
      ],
      tags: {
        "yt:a": ["pop", "upbeat"],
        "yt:b": ["pop", "chill", "upbeat"], // dup within track shouldn't double-count
        "yt:c": null, // null tags are skipped
      },
    });
    const profile = await buildTasteProfile(store, "user-1");
    // pop appears on a + b = 2; upbeat on a + b = 2; chill on b = 1
    // pop and upbeat tie at 2 — order between ties is alphabetical (localeCompare).
    expect(profile.topTags).toEqual([
      { tag: "pop", count: 2 },
      { tag: "upbeat", count: 2 },
      { tag: "chill", count: 1 },
    ]);
  });

  it("computes stats (totalPlays, uniqueTracks, skipRate, completeRate, likedCount)", async () => {
    const store = makeTrackStore({
      history: [
        historyRow({ trackId: "yt:a", playCount: 10, skipCount: 2, completeCount: 5 }),
        historyRow({ trackId: "yt:b", playCount: 4, skipCount: 1, completeCount: 1 }),
      ],
      likes: [
        // 3 likes — only length matters here
        { trackId: "yt:a", title: "T", artist: "A", thumbnail: null, likedAt: "x" },
        { trackId: "yt:b", title: "T", artist: "B", thumbnail: null, likedAt: "x" },
        { trackId: "yt:z", title: "T", artist: "Z", thumbnail: null, likedAt: "x" },
      ],
    });
    const profile = await buildTasteProfile(store, "user-1");
    expect(profile.stats).toEqual({
      totalPlays: 14,
      uniqueTracks: 2,
      skipRate: 3 / 14,
      completeRate: 6 / 14,
      likedCount: 3,
    });
  });

  it("caps topArtists at 10 and topTags at 12", async () => {
    const history: HistoryEntry[] = [];
    const tags: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++) {
      const id = `yt:t${i}`;
      history.push(historyRow({ trackId: id, artist: `Artist ${i}`, playCount: 20 - i }));
      tags[id] = [`tag${i}`];
    }
    const store = makeTrackStore({ history, tags });
    const profile = await buildTasteProfile(store, "user-1");
    expect(profile.topArtists).toHaveLength(10);
    expect(profile.topTags).toHaveLength(12);
    // Top artist is the highest-weighted: Artist 0 (weight 20).
    expect(profile.topArtists[0]!.artist).toBe("Artist 0");
  });

  it("still resolves when getTags throws (that track contributes no tags)", async () => {
    const store = makeTrackStore({
      history: [
        historyRow({ trackId: "yt:a", artist: "A" }),
        historyRow({ trackId: "yt:b", artist: "B" }),
      ],
      tags: { "yt:a": ["pop"] },
      getTagsThrows: true, // every getTags call throws
    });
    const profile = await buildTasteProfile(store, "user-1");
    // getTags threw for both → no tags aggregated, but profile still resolves.
    expect(profile.topTags).toEqual([]);
    expect(profile.topArtists.map((a) => a.artist)).toEqual(["A", "B"]);
  });

  it("skips rows with blank/unknown artist (does not lump under '')", async () => {
    const store = makeTrackStore({
      history: [
        historyRow({ trackId: "yt:a", artist: "A", playCount: 3 }),
        historyRow({ trackId: "yt:b", artist: "  ", playCount: 5 }),
      ],
    });
    const profile = await buildTasteProfile(store, "user-1");
    expect(profile.topArtists).toEqual([{ artist: "A", weight: 3 }]);
  });
});
