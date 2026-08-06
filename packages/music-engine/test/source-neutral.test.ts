import { describe, it, expect } from "vitest";
import type { MusicTrack } from "../src/types";

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
});
