/**
 * `importPlaylist` — import-as-taste pipeline tests (no network, no DB).
 *
 * Mocks `CandidateSource.searchTracks` (the resolver's only dependency) and a
 * hand-rolled supabase client pair (cookie + admin) so we can assert which
 * client received which write. Asserts the SP-3 contract:
 *   (a) ISRC-bearing inputs resolve and seed all three tables.
 *   (b) Unresolved tracks are counted as `skipped`, not aborted.
 *   (c) Budget sampling kicks in above IMPORT_BUDGET (sampled=true, count bounded).
 *   (d) music_track_sources writes go through the ADMIN client; music_plays and
 *       music_imports go through the COOKIE client.
 *   (e) music_plays upsert uses ignoreDuplicates:true (cold-start ON CONFLICT
 *       DO NOTHING — never inflates an existing play_count).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CandidateSource, MusicTrack } from "@music-ai/engine";
import type { ImportInputTrack } from "./import";

// vi.mock the admin module so the admin path is exercisable without env vars.
const adminHolder = vi.hoisted(() => ({
  client: null as unknown,
  configured: true,
}));
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => adminHolder.client,
  isAdminConfigured: () => adminHolder.configured,
}));

import { importPlaylist, sampleToBudget, IMPORT_BUDGET } from "./import";

// ---------------------------------------------------------------------------
// Mock supabase client — records writes on per-client stores so we can assert
// which client (cookie vs admin) received which upsert.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

interface ClientLog {
  upserts: Array<{ table: string; rows: Row | Row[]; opts?: { onConflict?: string; ignoreDuplicates?: boolean } }>;
  tables: Record<string, Row[]>;
}

function newLog(): ClientLog {
  return { upserts: [], tables: {} };
}

function makeClient(log: ClientLog) {
  function from(table: string) {
    const opts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    const builder = {
      upsert(rows: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        if (o?.onConflict) opts.onConflict = o.onConflict;
        if (o?.ignoreDuplicates) opts.ignoreDuplicates = o.ignoreDuplicates;
        log.upserts.push({ table, rows, opts: { ...opts } });
        const arr = Array.isArray(rows) ? rows : [rows];
        const tbl = log.tables[table] ?? (log.tables[table] = []);
        for (const r of arr) tbl.push({ ...r });
        return Promise.resolve({ data: rows, error: null });
      },
      // thenable — `await builder` lands here.
      then<T>(onFulfilled?: (v: { data: unknown; error: unknown }) => T | PromiseLike<T>) {
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    };
    return builder;
  }
  return { from };
}

function track(id: string, isrc?: string): MusicTrack {
  return {
    trackId: `yt:${id}`,
    sources: { youtube: id },
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    thumbnail: null,
    ...(isrc ? { isrc } : {}),
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

function inputTrack(i: number, isrc?: string): ImportInputTrack {
  return {
    title: `Title${i}`,
    artist: `Artist${i}`,
    ...(isrc ? { isrc } : {}),
    sourceId: `src-${i}`,
  };
}

describe("sampleToBudget", () => {
  it("returns all items when length <= budget", () => {
    const items = [1, 2, 3];
    expect(sampleToBudget(items, 5)).toEqual([1, 2, 3]);
    expect(sampleToBudget(items, 3)).toEqual([1, 2, 3]);
  });

  it("returns exactly budget items when length > budget", () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    const out = sampleToBudget(items, IMPORT_BUDGET);
    expect(out).toHaveLength(IMPORT_BUDGET);
    // Every output item is a real input item.
    for (const v of out) expect(items).toContain(v);
    // No duplicates.
    expect(new Set(out).size).toBe(out.length);
  });

  it("is deterministic — same input yields same sample across calls", () => {
    const items = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const a = sampleToBudget(items, 50);
    const b = sampleToBudget(items, 50);
    expect(a).toEqual(b);
  });

  it("preserves original (ascending index) order in the sample", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const out = sampleToBudget(items, 10);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(out[i - 1]);
    }
  });

  it("handles budget 0", () => {
    expect(sampleToBudget([1, 2, 3], 0)).toEqual([]);
  });
});

describe("importPlaylist", () => {
  let cookieLog: ClientLog;
  let adminLog: ClientLog;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cookieClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let adminClient: any;

  beforeEach(() => {
    cookieLog = newLog();
    adminLog = newLog();
    cookieClient = makeClient(cookieLog);
    adminClient = makeClient(adminLog);
    adminHolder.client = adminClient;
    adminHolder.configured = true;
  });

  it("(a) resolves an ISRC track and seeds music_plays + music_imports + music_track_sources", async () => {
    const source = mockSource(async (q) => {
      if (q === "USUM71703991") return [track("bb", "USUM71703991")];
      return [track("tt")];
    });
    const result = await importPlaylist({
      supabase: cookieClient,
      userId: "user-1",
      provider: "spotify",
      playlist: { id: "pl-1", name: "Favourites" },
      tracks: [inputTrack(1, "USUM71703991")],
      candidateSource: source,
    });

    expect(result.resolved).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.sampled).toBe(false);

    // music_plays seeded via cookie client with ignoreDuplicates:true.
    const playsUpsert = cookieLog.upserts.find((u) => u.table === "music_plays");
    expect(playsUpsert).toBeTruthy();
    expect(playsUpsert!.opts).toMatchObject({
      onConflict: "user_id,track_id",
      ignoreDuplicates: true,
    });
    expect(playsUpsert!.rows).toMatchObject({ track_id: "yt:bb", play_count: 1 });

    // music_imports provenance row via cookie client.
    const importsUpsert = cookieLog.upserts.find((u) => u.table === "music_imports");
    expect(importsUpsert).toBeTruthy();
    expect(importsUpsert!.opts).toMatchObject({
      onConflict: "user_id,provider,source_playlist_id,track_id",
    });
    expect(importsUpsert!.rows).toMatchObject({
      track_id: "yt:bb", provider: "spotify", source_playlist_id: "pl-1", isrc: "USUM71703991",
    });

    // music_track_sources via ADMIN client (catalog-global).
    const srcUpsert = adminLog.upserts.find((u) => u.table === "music_track_sources");
    expect(srcUpsert).toBeTruthy();
    expect(srcUpsert!.opts).toMatchObject({ onConflict: "track_id,provider" });
    expect(srcUpsert!.rows).toMatchObject({
      track_id: "yt:bb", provider: "spotify", source_id: "src-1",
    });

    // No cross-contamination: admin never saw music_plays/music_imports.
    expect(adminLog.upserts.some((u) => u.table === "music_plays")).toBe(false);
    expect(adminLog.upserts.some((u) => u.table === "music_imports")).toBe(false);
    // And cookie never saw music_track_sources.
    expect(cookieLog.upserts.some((u) => u.table === "music_track_sources")).toBe(false);
  });

  it("(b) counts unresolved tracks as skipped and continues the rest", async () => {
    const source = mockSource(async () => []); // nothing resolves
    const result = await importPlaylist({
      supabase: cookieClient,
      userId: "user-1",
      provider: "spotify",
      playlist: { id: "pl-2", name: "Empty" },
      tracks: [inputTrack(1), inputTrack(2), inputTrack(3)],
      candidateSource: source,
    });
    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(3);
    // No writes fired for unresolved tracks.
    expect(cookieLog.upserts).toHaveLength(0);
    expect(adminLog.upserts).toHaveLength(0);
  });

  it("(b) mixed: one resolves, one skips, writes only for the resolved one", async () => {
    const source = mockSource(async (q) => {
      // Track 1 resolves via title; track 2 resolves nothing.
      if (q.includes("Title1")) return [track("r1")];
      return [];
    });
    const result = await importPlaylist({
      supabase: cookieClient,
      userId: "user-1",
      provider: "youtube",
      playlist: { id: "pl-3", name: "Mix" },
      tracks: [inputTrack(1), inputTrack(2)],
      candidateSource: source,
    });
    expect(result.resolved).toBe(1);
    expect(result.skipped).toBe(1);
    // Exactly one music_plays + one music_imports (for the resolved track).
    expect(cookieLog.upserts.filter((u) => u.table === "music_plays")).toHaveLength(1);
    expect(cookieLog.upserts.filter((u) => u.table === "music_imports")).toHaveLength(1);
    expect(adminLog.upserts.filter((u) => u.table === "music_track_sources")).toHaveLength(1);
  });

  it("(c) samples down to IMPORT_BUDGET when tracks exceed it (sampled=true)", async () => {
    const source = mockSource(async (q) => {
      // Everything resolves via title.
      return q.includes("Title") ? [track("yt" + q.slice(-2))] : [];
    });
    const many = Array.from({ length: IMPORT_BUDGET + 50 }, (_, i) => inputTrack(i));
    const result = await importPlaylist({
      supabase: cookieClient,
      userId: "user-1",
      provider: "spotify",
      playlist: { id: "pl-big", name: "Huge" },
      tracks: many,
      candidateSource: source,
    });
    expect(result.sampled).toBe(true);
    // resolved count is bounded by the budget (every sampled track resolves).
    expect(result.resolved).toBe(IMPORT_BUDGET);
    expect(cookieLog.upserts.filter((u) => u.table === "music_plays")).toHaveLength(IMPORT_BUDGET);
  });

  it("(c) does not sample when at or below budget (sampled=false)", async () => {
    const source = mockSource(async () => [track("x")]);
    const result = await importPlaylist({
      supabase: cookieClient,
      userId: "user-1",
      provider: "spotify",
      playlist: { id: "pl-exact", name: "Exact" },
      tracks: Array.from({ length: IMPORT_BUDGET }, (_, i) => inputTrack(i)),
      candidateSource: source,
    });
    expect(result.sampled).toBe(false);
    expect(result.resolved).toBe(IMPORT_BUDGET);
  });

  it("(d) skips music_track_sources when admin is not configured, still seeds the other two", async () => {
    adminHolder.configured = false;
    const source = mockSource(async () => [track("ok")]);
    const result = await importPlaylist({
      supabase: cookieClient,
      userId: "user-1",
      provider: "spotify",
      playlist: { id: "pl-4", name: "NoAdmin" },
      tracks: [inputTrack(1)],
      candidateSource: source,
    });
    expect(result.resolved).toBe(1);
    expect(cookieLog.upserts.some((u) => u.table === "music_plays")).toBe(true);
    expect(cookieLog.upserts.some((u) => u.table === "music_imports")).toBe(true);
    // Admin path skipped entirely.
    expect(adminLog.upserts).toHaveLength(0);
  });

  it("(e) music_plays upsert always uses ignoreDuplicates (never inflates play_count)", async () => {
    const source = mockSource(async () => [track("z")]);
    await importPlaylist({
      supabase: cookieClient,
      userId: "user-1",
      provider: "spotify",
      playlist: { id: "pl-5", name: "Idem" },
      tracks: [inputTrack(1), inputTrack(1)], // same track twice
      candidateSource: source,
    });
    const playsUpserts = cookieLog.upserts.filter((u) => u.table === "music_plays");
    expect(playsUpserts).toHaveLength(2);
    for (const u of playsUpserts) {
      expect(u.opts?.ignoreDuplicates).toBe(true);
    }
  });
});
