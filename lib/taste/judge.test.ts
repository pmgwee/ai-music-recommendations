/**
 * Unit tests for the top-N diversity judge (`diversityJudge`).
 *
 * Each test pins one of the five guarantees the judge makes to its callers:
 *   (a) GATED       — no LLM or short slate → empty set, no LLM call.
 *   (b) MITIGATED   — prompt uses opaque refs (no real ids), shuffle uses rng.
 *   (c) BOUNDED     — at most 2 drops out of at most 10 considered.
 *   (d) DEFENSIVE   — LLM throw / malformed JSON / missing field → empty set.
 *   (e) (wiring is covered by the route handler's own integration behaviour.)
 *
 * The LLM is mocked with vi.fn so each test asserts both the resolved set AND
 * the exact `chat()` payload (prompt shape, json mode, temperature, etc.).
 */
import { describe, it, expect, vi } from "vitest";
import type { LlmProvider, MusicTrack } from "@music-ai/engine";
import { diversityJudge } from "./judge";
import type { TasteProfile } from "./profile";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function track(id: string, title = `Title ${id}`, artist = `Artist ${id}`): MusicTrack {
  return {
    trackId: id,
    sources: { youtube: id.replace(/^yt:/, "") },
    title,
    artist,
    thumbnail: null,
  };
}

/** Build a slate of N tracks with stable ids `yt:t1..yt:tN`. */
function slateOf(n: number): MusicTrack[] {
  const out: MusicTrack[] = [];
  for (let i = 1; i <= n; i++) out.push(track(`yt:t${i}`, `Title ${i}`, `Artist ${i}`));
  return out;
}

const FULL_PROFILE: TasteProfile = {
  topArtists: [
    { artist: "Fleetwood Mac", weight: 10 },
    { artist: "Daft Punk", weight: 8 },
  ],
  topTags: [
    { tag: "soft-rock", count: 5 },
    { tag: "electronic", count: 3 },
  ],
  stats: {
    totalPlays: 30,
    uniqueTracks: 12,
    skipRate: 0.1,
    completeRate: 0.7,
    likedCount: 4,
  },
};

/** A mock LlmProvider whose `chat` is a spy the test configures per-case. */
function mockLlm(opts: {
  configured?: boolean;
  respondWith?: string | (() => string) | Error;
}): { llm: LlmProvider; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async () => {
    if (opts.respondWith instanceof Error) throw opts.respondWith;
    return typeof opts.respondWith === "function" ? opts.respondWith() : (opts.respondWith ?? "");
  });
  const llm: LlmProvider = {
    isConfigured: () => opts.configured ?? true,
    chat,
  };
  return { llm, chat };
}

/** Deterministic RNG that cycles through a fixed sequence. Lets us pin the
 *  shuffle order (and so the t1..tN ↔ trackId mapping) in mitigation tests. */
function cyclicRng(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq[i % seq.length]!;
    i++;
    return v;
  };
}

// ---------------------------------------------------------------------------
// (a) GUARDS — gated behaviour
// ---------------------------------------------------------------------------
describe("diversityJudge guards", () => {
  it("returns an empty set when the LLM is not configured", async () => {
    const { llm, chat } = mockLlm({ configured: false, respondWith: '{"drop":["t1"]}' });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE);
    expect(drops.size).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it("returns an empty set when the slate has fewer than 8 tracks", async () => {
    const { llm, chat } = mockLlm({ configured: true, respondWith: '{"drop":["t1"]}' });
    const drops = await diversityJudge(llm, slateOf(7), FULL_PROFILE);
    expect(drops.size).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it("runs the judge at exactly 8 tracks (boundary)", async () => {
    const { llm, chat } = mockLlm({ configured: true, respondWith: '{"drop":[]}' });
    await diversityJudge(llm, slateOf(8), FULL_PROFILE, cyclicRng([0]));
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (b) MITIGATION — opaque refs + profile in prompt + shuffle via rng
// ---------------------------------------------------------------------------
describe("diversityJudge prompt mitigation", () => {
  it("uses opaque t1..tN refs (no real trackIds / videoIds leak into the prompt)", async () => {
    const { llm, chat } = mockLlm({ configured: true, respondWith: '{"drop":[]}' });
    // Deterministic shuffle keeps ref assignment stable for the assertion.
    await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));

    const payload = chat.mock.calls[0]![0] as { messages: { content: string }[] };
    const allPromptText = payload.messages.map((m) => m.content).join("\n");

    // Real ids must NOT appear anywhere in the prompt.
    for (let i = 1; i <= 10; i++) {
      expect(allPromptText).not.toContain(`yt:t${i}`);
    }
    // Refs DO appear.
    expect(allPromptText).toContain("t1");
    expect(allPromptText).toContain("t10");
    // Track titles + artists DO appear (so the LLM has signal to judge fit).
    expect(allPromptText).toContain("Title 1");
    expect(allPromptText).toContain("Artist 1");
  });

  it("includes the listener's top artists + top tags in the prompt", async () => {
    const { llm, chat } = mockLlm({ configured: true, respondWith: '{"drop":[]}' });
    await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));

    const payload = chat.mock.calls[0]![0] as { messages: { content: string }[] };
    const user = payload.messages[1]!.content;
    expect(user).toContain("Fleetwood Mac");
    expect(user).toContain("Daft Punk");
    expect(user).toContain("soft-rock");
    expect(user).toContain("electronic");
  });

  it("calls chat with json mode, temperature 0, bounded tokens, thinkingDisabled", async () => {
    const { llm, chat } = mockLlm({ configured: true, respondWith: '{"drop":[]}' });
    await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));

    const payload = chat.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.json).toBe(true);
    expect(payload.temperature).toBe(0);
    expect(payload.maxTokens).toBe(200);
    expect(payload.thinkingDisabled).toBe(true);
  });

  it("shuffle uses the injected rng (deterministic with a fixed sequence)", async () => {
    // With cyclicRng([0]) the Fisher–Yates j = floor(0*(i+1)) = 0 every step,
    // so each iteration swaps out[i] ↔ out[0]. Tracing n=10 by hand, the final
    // order is [t2,t3,...,t10,t1] — so the first ref `t1` labels yt:t2.
    const { llm, chat } = mockLlm({
      configured: true,
      // Drop t1 → should map back to the SECOND input track (yt:t2).
      respondWith: '{"drop":["t1"]}',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));
    expect(drops).toEqual(new Set(["yt:t2"]));
  });

  it("shuffle rng affects the ref ↔ trackId mapping", async () => {
    // Different rng → different mapping. Same response `{drop:[t1]}` must
    // therefore resolve to a different trackId than the [0] case above.
    const { llm, chat } = mockLlm({
      configured: true,
      respondWith: '{"drop":["t1"]}',
    });
    // rng=0.999 → j=floor(0.999*(i+1)) → swaps toward the end. With i=9,
    // j=floor(9.99)=9 (no swap); i=8, j=floor(8.991)=8 (no swap); ... i=0, j=0.
    // Net effect: identity ordering, so t1 → yt:t1.
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0.999]));
    expect(drops).toEqual(new Set(["yt:t1"]));
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (c) BOUNDED — cap of 2 drops, at most 10 tracks considered
// ---------------------------------------------------------------------------
describe("diversityJudge bounds", () => {
  it("caps drops at 2 even when the LLM flags more", async () => {
    const { llm } = mockLlm({
      configured: true,
      respondWith: '{"drop":["t1","t2","t3","t4","t5"]}',
    });
    // rng=0.999 → identity mapping (see prior test), so t1..tN ↔ yt:t1..yt:tN.
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0.999]));
    expect(drops.size).toBe(2);
    expect(drops).toEqual(new Set(["yt:t1", "yt:t2"]));
  });

  it("considers at most 10 tracks — refs t11+ never appear in the prompt", async () => {
    const { llm, chat } = mockLlm({ configured: true, respondWith: '{"drop":[]}' });
    await diversityJudge(llm, slateOf(20), FULL_PROFILE, cyclicRng([0]));
    const payload = chat.mock.calls[0]![0] as { messages: { content: string }[] };
    const text = payload.messages.map((m) => m.content).join("\n");
    // Only t1..t10 exist in the prompt.
    expect(text).toContain("t10");
    expect(text).not.toContain("t11");
    expect(text).not.toMatch(/t1[1-9]\b/);
    expect(text).not.toContain("t20");
  });

  it("makes exactly one LLM call per invocation", async () => {
    const { llm, chat } = mockLlm({ configured: true, respondWith: '{"drop":["t1"]}' });
    await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("ignores refs that were never issued (hallucinated / out of range)", async () => {
    const { llm } = mockLlm({
      configured: true,
      respondWith: '{"drop":["t1","t99","tbanana","t1"]}',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0.999]));
    expect(drops).toEqual(new Set(["yt:t1"]));
  });

  it("dedupes refs that resolve to the same trackId", async () => {
    const { llm } = mockLlm({
      configured: true,
      respondWith: '{"drop":["t1","t1"]}',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0.999]));
    expect(drops.size).toBe(1);
  });

  it("tolerates non-string entries in the drop array", async () => {
    const { llm } = mockLlm({
      configured: true,
      // numbers/null/object should be skipped, not crash.
      respondWith: '{"drop":["t1", 2, null, {}, "t2"]}',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0.999]));
    expect(drops).toEqual(new Set(["yt:t1", "yt:t2"]));
  });
});

// ---------------------------------------------------------------------------
// (d) DEFENSIVE — every failure mode collapses to empty set, never throws
// ---------------------------------------------------------------------------
describe("diversityJudge defensive parsing", () => {
  it("returns empty set when the LLM throws", async () => {
    const { llm, chat } = mockLlm({
      configured: true,
      respondWith: new Error("network blew up"),
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));
    expect(drops.size).toBe(0);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("returns empty set when the response is not JSON", async () => {
    const { llm } = mockLlm({ configured: true, respondWith: "the tracks are all great" });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));
    expect(drops.size).toBe(0);
  });

  it("returns empty set when the JSON is valid but has no drop field", async () => {
    const { llm } = mockLlm({
      configured: true,
      respondWith: '{"keep": ["t1"], "reason": "all good"}',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));
    expect(drops.size).toBe(0);
  });

  it("returns empty set when drop is not an array", async () => {
    const { llm } = mockLlm({
      configured: true,
      respondWith: '{"drop": "t1"}',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));
    expect(drops.size).toBe(0);
  });

  it("extracts JSON from a ```json fenced response", async () => {
    const { llm } = mockLlm({
      configured: true,
      respondWith: '```json\n{"drop": ["t1"]}\n```',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0.999]));
    expect(drops).toEqual(new Set(["yt:t1"]));
  });

  it("extracts JSON from loose prose around the object", async () => {
    const { llm } = mockLlm({
      configured: true,
      respondWith: 'Sure! Here you go: {"drop": ["t2"]} — hope that helps.',
    });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0.999]));
    expect(drops).toEqual(new Set(["yt:t2"]));
  });

  it("returns empty set when drop array is empty", async () => {
    const { llm } = mockLlm({ configured: true, respondWith: '{"drop": []}' });
    const drops = await diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0]));
    expect(drops.size).toBe(0);
  });

  it("never throws — even on pathological input the route handler's try/catch is never hit", async () => {
    // Several pathological LLM responses; none should reject the promise.
    const cases = ["", "{", "[", "null", "undefined", "{drop: t1}", "\x00\xff"];
    for (const c of cases) {
      const { llm } = mockLlm({ configured: true, respondWith: c });
      await expect(
        diversityJudge(llm, slateOf(10), FULL_PROFILE, cyclicRng([0])),
      ).resolves.toBeInstanceOf(Set);
    }
  });
});
