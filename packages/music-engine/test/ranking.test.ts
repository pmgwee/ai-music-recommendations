import { describe, it, expect } from "vitest";
import { score, ScoreContext } from "../src/ranking";
import type { Candidate, HistoryEntry } from "../src/types";

const history: HistoryEntry[] = [{
  trackId: "yt:seed", title: "s", artist: "a", thumbnail: null,
  playCount: 5, lastPlayedAt: new Date().toISOString(), skipCount: 0, completeCount: 2,
  sources: { youtube: "seed" },
}];
const ctx: ScoreContext = {
  history: new Map(history.map((h) => [h.trackId, h])),
  likes: new Set(["yt:liked"]),
  now: Date.now(),
};
const candidate: Candidate = {
  track: { trackId: "yt:c1", sources: { youtube: "c1" }, title: "c", artist: "a", thumbnail: null },
  occurrences: [{ sourceId: "yt:seed", origin: "radio", rank: 0, seedWeight: 5 }],
};

describe("ranking", () => {
  it("scores a candidate without referencing sources.youtube", () => {
    const v = score(candidate, ctx);
    expect(typeof v).toBe("number");
    expect(Number.isFinite(v)).toBe(true);
  });
});
