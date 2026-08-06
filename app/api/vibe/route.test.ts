/**
 * /api/vibe — handler-level tests (SP-5 Task 2).
 *
 * Mocks every collaborator the route touches:
 *   - `@/lib/supabase/server` — `auth.getUser()` resolves a user (or returns
 *     null for the 401 branch).
 *   - `@music-ai/engine` — `parseVibe`, `buildRadio`, `createYoutubeCandidateSource`
 *     are stubbed so the route's control flow (degrade codes, exclude filter,
 *     length cap, `via` propagation) is asserted without InnerTube or a real
 *     LLM. `createYoutubeCandidateSource` is exercised but its return value is
 *     only forwarded — search happens inside `resolveVibeSeed`.
 *   - `@/lib/providers/llm-byok` — `createByokLlm` returns either a configured
 *     LLM stub, `NullLlm`, or `null` to drive the `vibe_needs_llm` branch.
 *   - `@/lib/vibe/resolve` — `resolveVibeSeed` returns a synthetic `{seed,via}`
 *     or `null` to drive the `could_not_ground` branch.
 *   - `@/lib/providers/track-store-supabase` — the track store returns empty
 *     history/likes (the engine pipeline is mocked, so their contents don't
 *     matter for these tests).
 *
 * `rateLimit` is reset between tests so the per-user cap (6/min) doesn't trip
 * the sequential test sequence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — available before the route module imports.
// ---------------------------------------------------------------------------
const supabaseMock = vi.hoisted(() => ({
  client: {
    auth: { getUser: vi.fn() },
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => Promise.resolve(supabaseMock.client),
}));

const engineMock = vi.hoisted(() => ({
  parseVibe: vi.fn() as Mock,
  buildRadio: vi.fn() as Mock,
  createYoutubeCandidateSource: vi.fn() as Mock,
}));

vi.mock("@music-ai/engine", () => ({
  parseVibe: (...args: never[]) => engineMock.parseVibe(...args),
  buildRadio: (...args: never[]) => engineMock.buildRadio(...args),
  createYoutubeCandidateSource: (...args: never[]) =>
    engineMock.createYoutubeCandidateSource(...args),
}));

const byokMock = vi.hoisted(() => ({
  // Returns an object with `isConfigured()` so the route can call it. The test
  // swaps this between a "configured" stub and NullLlm to drive each branch.
  createByokLlm: vi.fn() as Mock,
  NullLlm: { isConfigured: () => false, chat: async () => "[]" },
}));

vi.mock("@/lib/providers/llm-byok", () => ({
  createByokLlm: (...args: never[]) => byokMock.createByokLlm(...args),
  NullLlm: byokMock.NullLlm,
}));

const resolveMock = vi.hoisted(() => ({
  resolveVibeSeed: vi.fn() as Mock,
}));

vi.mock("@/lib/vibe/resolve", () => ({
  resolveVibeSeed: (...args: never[]) => resolveMock.resolveVibeSeed(...args),
}));

const trackStoreMock = vi.hoisted(() => ({
  loadHistory: vi.fn() as Mock,
  loadLikes: vi.fn() as Mock,
}));

vi.mock("@/lib/providers/track-store-supabase", () => ({
  createSupabaseTrackStore: () => ({
    loadHistory: (...args: never[]) => trackStoreMock.loadHistory(...args),
    loadLikes: (...args: never[]) => trackStoreMock.loadLikes(...args),
    // Unused by this route but required by the seam shape in case other code
    // reaches the same instance.
    loadSuppressions: async () => ({ notInterested: new Set(), snoozedUntil: new Map() }),
    loadTransitionBias: async () => new Map(),
    recordPlay: async () => {},
    recordSignal: async () => {},
    getTags: async () => null,
    setTags: async () => {},
  }),
}));

import { POST } from "./route";
import { __resetRateLimiterForTests } from "@/lib/rate-limit";
import type { MusicTrack, VibeConstraints } from "@music-ai/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setUser(user: { id: string } | null): void {
  supabaseMock.client.auth.getUser.mockResolvedValue({
    data: { user },
    error: null,
  });
}

function vibeRequest(prompt: string): Request {
  return new Request("http://test/api/vibe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

function constraints(overrides: Partial<VibeConstraints> = {}): VibeConstraints {
  return {
    genres: ["indie"],
    moods: ["chill"],
    eras: [],
    seedNames: ["Seed Name"],
    exclude: [],
    length: 25,
    ...overrides,
  };
}

function ytTrack(id: string, title = `Song ${id}`): MusicTrack {
  return {
    trackId: `yt:${id}`,
    sources: { youtube: id },
    title,
    artist: "Artist",
    thumbnail: null,
  };
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

// A configured LLM stub — `isConfigured()` true so the route proceeds.
const configuredLlm = { isConfigured: () => true, chat: async () => "{}" };

describe("/api/vibe", () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    setUser({ id: "user-1" });

    // Defaults: a successful path. Each test overrides only what it needs.
    byokMock.createByokLlm.mockResolvedValue(configuredLlm);
    engineMock.parseVibe.mockResolvedValue(constraints());
    engineMock.createYoutubeCandidateSource.mockReturnValue({
      fetchRadio: async () => ({ seedId: "yt:s", tracks: [], continuation: null }),
      fetchRelated: async () => ({ alsoLike: [], similarArtistIds: [], playlistIds: [] }),
      fetchArtistSongs: async () => [],
      fetchPlaylistTracks: async () => [],
      extendRadio: async () => null,
      searchTracks: async () => [],
    });
    resolveMock.resolveVibeSeed.mockResolvedValue({
      seed: ytTrack("seed1"),
      via: "named" as const,
    });
    engineMock.buildRadio.mockResolvedValue({
      tracks: [ytTrack("r1"), ytTrack("r2")],
      continuation: null,
    });
    trackStoreMock.loadHistory.mockResolvedValue([]);
    trackStoreMock.loadLikes.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    __resetRateLimiterForTests();
  });

  // -------------------------------------------------------------------------
  describe("auth gate", () => {
    it("returns 401 when there is no session", async () => {
      setUser(null);
      const res = await POST(vibeRequest("chill sunday"));
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: "unauthorized" });
      expect(byokMock.createByokLlm).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("input validation", () => {
    it("returns 400 on malformed JSON body", async () => {
      const req = new Request("http://test/api/vibe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json{",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ tracks: [], error: "invalid_json" });
    });

    it("returns 400 on empty prompt", async () => {
      const res = await POST(vibeRequest("   "));
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ tracks: [], error: "empty_prompt" });
    });

    it("returns 400 when prompt is missing", async () => {
      const req = new Request("http://test/api/vibe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ tracks: [], error: "empty_prompt" });
    });
  });

  // -------------------------------------------------------------------------
  describe("rate limit", () => {
    it("returns 429 once the per-user cap (6/min) is exceeded", async () => {
      for (let i = 0; i < 6; i++) {
        const r = await POST(vibeRequest("x"));
        expect(r.status).toBe(200);
      }
      const over = await POST(vibeRequest("x"));
      expect(over.status).toBe(429);
      const body = (await json(over)) as { error: string };
      expect(body.error).toBe("rate_limited");
    });
  });

  // -------------------------------------------------------------------------
  describe("degrade paths (clean JSON, never 500)", () => {
    it("returns vibe_needs_llm when the user has no BYOK key", async () => {
      // createByokLlm returns null → route uses NullLlm → isConfigured false.
      byokMock.createByokLlm.mockResolvedValue(null);
      const res = await POST(vibeRequest("dreamy indie"));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ tracks: [], error: "vibe_needs_llm" });
      // parseVibe is never called when the LLM isn't configured.
      expect(engineMock.parseVibe).not.toHaveBeenCalled();
    });

    it("returns vibe_needs_llm when createByokLlm returns NullLlm", async () => {
      byokMock.createByokLlm.mockResolvedValue(byokMock.NullLlm);
      const res = await POST(vibeRequest("dreamy indie"));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ tracks: [], error: "vibe_needs_llm" });
    });

    it("returns could_not_parse when parseVibe yields null", async () => {
      engineMock.parseVibe.mockResolvedValue(null);
      const res = await POST(vibeRequest("garbage"));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ tracks: [], error: "could_not_parse" });
      // resolveVibeSeed is never called when parsing failed.
      expect(resolveMock.resolveVibeSeed).not.toHaveBeenCalled();
    });

    it("returns could_not_ground when resolveVibeSeed yields null", async () => {
      resolveMock.resolveVibeSeed.mockResolvedValue(null);
      const res = await POST(vibeRequest("anything"));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ tracks: [], error: "could_not_ground" });
      // buildRadio is never called when no seed grounded.
      expect(engineMock.buildRadio).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("happy path + post-filter", () => {
    it("grounds via the resolver, runs buildRadio, returns tracks + constraints + via", async () => {
      const res = await POST(vibeRequest("like Arctic Monkeys but dreamier"));
      expect(res.status).toBe(200);
      const body = (await json(res)) as {
        tracks: MusicTrack[];
        constraints: VibeConstraints;
        via: string;
      };
      expect(body.via).toBe("named");
      expect(body.constraints.genres).toEqual(["indie"]);
      expect(body.tracks).toHaveLength(2);
      expect(body.tracks[0]!.trackId).toBe("yt:r1");

      // The seed trackId came from the resolver, not from the LLM.
      expect(engineMock.buildRadio).toHaveBeenCalledOnce();
      const callArgs = engineMock.buildRadio.mock.calls[0]![0] as { seedTrackId: string };
      expect(callArgs.seedTrackId).toBe("yt:seed1");
    });

    it("drops tracks whose title contains an exclude word (case-insensitive)", async () => {
      engineMock.parseVibe.mockResolvedValue(
        constraints({ exclude: ["remix", "karaoke"] }),
      );
      engineMock.buildRadio.mockResolvedValue({
        tracks: [
          ytTrack("a", "Original Song"),
          ytTrack("b", "Song (Remix)"),           // contains "remix" → drop
          ytTrack("c", "Karaoke Version"),         // contains "karaoke" → drop
          ytTrack("d", "Another Original"),
        ],
        continuation: null,
      });
      const res = await POST(vibeRequest("indie but no remixes"));
      const body = (await json(res)) as { tracks: MusicTrack[] };
      expect(body.tracks.map((t) => t.trackId)).toEqual(["yt:a", "yt:d"]);
    });

    it("caps the output at constraints.length", async () => {
      engineMock.parseVibe.mockResolvedValue(constraints({ length: 3 }));
      engineMock.buildRadio.mockResolvedValue({
        tracks: [ytTrack("1"), ytTrack("2"), ytTrack("3"), ytTrack("4"), ytTrack("5")],
        continuation: null,
      });
      const res = await POST(vibeRequest("upbeat"));
      const body = (await json(res)) as { tracks: MusicTrack[] };
      expect(body.tracks).toHaveLength(3);
      expect(body.tracks.map((t) => t.trackId)).toEqual(["yt:1", "yt:2", "yt:3"]);
    });

    it("forwards via='synthesized' when the resolver synthesises a tag query", async () => {
      resolveMock.resolveVibeSeed.mockResolvedValue({
        seed: ytTrack("synth"),
        via: "synthesized" as const,
      });
      const res = await POST(vibeRequest("chill indie"));
      const body = (await json(res)) as { via: string };
      expect(body.via).toBe("synthesized");
    });
  });

  // -------------------------------------------------------------------------
  describe("defensive 500", () => {
    it("returns vibe_build_failed (500) when buildRadio throws", async () => {
      engineMock.buildRadio.mockRejectedValue(new Error("inner tube gone"));
      const res = await POST(vibeRequest("anything"));
      expect(res.status).toBe(500);
      expect(await json(res)).toEqual({ tracks: [], error: "vibe_build_failed" });
    });
  });
});
