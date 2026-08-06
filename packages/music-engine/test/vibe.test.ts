import { describe, it, expect } from "vitest";
import { parseVibe } from "../src/vibe";
import type { LlmProvider } from "../src/seams";

const stub: LlmProvider = {
  isConfigured: () => true,
  chat: async () =>
    JSON.stringify({ genres: ["pop"], moods: ["happy"], eras: [], seedNames: [], exclude: [], length: 10 }),
};

describe("vibe", () => {
  it("parses constraints via injected LlmProvider", async () => {
    const c = await parseVibe("upbeat pop for the gym", stub);
    expect(c).not.toBeNull();
    expect(c!.genres).toContain("pop");
    expect(c!.length).toBe(10);
  });
});
