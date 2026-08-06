/**
 * Task 11 — Supabase TrackStore.
 *
 * Hand-rolled in-memory supabase client mock: supports the chained query shape
 * the impl uses (`from().select().eq().order().limit()` → thenable `{data,error}`,
 * `from().upsert()` → thenable, `.maybeSingle()`, and `rpc()`), plus a vi.mock of
 * `../supabase/admin` so `setTags`'s service-role path is exercisable without env.
 *
 * The mock's `rpc("log_music_play")` simulates `auth.uid()` by keying rows on
 * `store.authUid` — mirroring the production RPC, which derives the user from
 * the request cookie rather than from an argument.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MusicTrack } from "@music-ai/engine";

// --- vi.mock the admin module so setTags is exercisable without env vars ---
const adminHolder = vi.hoisted(() => ({ client: null as unknown, configured: true }));
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => adminHolder.client,
  isAdminConfigured: () => adminHolder.configured,
}));

// Imported AFTER vi.mock registration (vitest hoists vi.mock above all imports).
import { createSupabaseTrackStore } from "./track-store-supabase";

// ---------------------------------------------------------------------------
// Mock supabase client
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

interface MockStore {
  tables: Record<string, Row[]>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  upserts: Array<{ table: string; rows: Row | Row[]; onConflict?: string }>;
  /** Simulates `auth.uid()` for the security-invoker RPCs. */
  authUid: string;
  /** When true, every select / rpc resolves with an error (defensive path). */
  forceError: boolean;
}

function makeStore(authUid = "user-1"): MockStore {
  return {
    tables: {
      music_plays: [],
      music_likes: [],
      music_suppressions: [],
      music_transitions: [],
      music_track_tags: [],
    },
    rpcCalls: [],
    upserts: [],
    authUid,
    forceError: false,
  };
}

function createMockClient(store: MockStore) {
  const ok = (data: unknown) => Promise.resolve({ data, error: null });

  function rpc(name: string, args: Record<string, unknown>) {
    store.rpcCalls.push({ name, args });
    if (store.forceError) return ok(null).then(() => ({ data: null, error: { message: "forced" } }));

    if (name === "log_music_play") {
      const tbl = store.tables.music_plays;
      const uid = store.authUid;
      const trackId = args.p_track_id as string;
      const now = new Date().toISOString();
      const fields = {
        title: args.p_title,
        artist: (args.p_artist as string) ?? "",
        thumbnail: args.p_thumbnail,
      };
      const existing = tbl.find((r) => r.user_id === uid && r.track_id === trackId);
      if (existing) {
        existing.play_count = ((existing.play_count as number) ?? 0) + 1;
        existing.last_played_at = now;
        Object.assign(existing, fields);
      } else {
        tbl.push({
          id: `id-${trackId}`,
          user_id: uid,
          track_id: trackId,
          ...fields,
          play_count: 1,
          skip_count: 0,
          complete_count: 0,
          first_played_at: now,
          last_played_at: now,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }

    if (name === "log_music_signal") {
      const tbl = store.tables.music_plays;
      const uid = store.authUid;
      const row = tbl.find((r) => r.user_id === uid && r.track_id === args.p_track_id);
      if (row) {
        if (args.p_signal === "skip") row.skip_count = ((row.skip_count as number) ?? 0) + 1;
        if (args.p_signal === "complete") row.complete_count = ((row.complete_count as number) ?? 0) + 1;
      }
      return Promise.resolve({ data: null, error: null });
    }

    return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }

  function from(table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    let orderCol: string | undefined;
    let orderAsc = true;
    let limitN: number | undefined;
    let mode: "many" | "maybeSingle" = "many";

    function run() {
      if (store.forceError) return { data: null, error: { message: "forced" } };
      let rows = [...(store.tables[table] ?? [])];
      for (const f of filters) rows = rows.filter((r) => r[f.col] === f.val);
      if (orderCol) {
        rows.sort((a, b) => {
          const av = a[orderCol!];
          const bv = b[orderCol!];
          if (av === bv) return 0;
          const cmp = String(av) < String(bv) ? -1 : 1;
          return orderAsc ? cmp : -cmp;
        });
      }
      if (mode === "maybeSingle") {
        return { data: rows[0] ?? null, error: null };
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    }

    const builder = {
      select(_cols?: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      maybeSingle() {
        mode = "maybeSingle";
        return builder;
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
        store.upserts.push({ table, rows, onConflict: opts?.onConflict });
        const arr = Array.isArray(rows) ? rows : [rows];
        const tbl = store.tables[table] ?? (store.tables[table] = []);
        for (const r of arr) {
          const pk = (r as Row).track_id;
          const existing = pk ? tbl.find((x) => x.track_id === pk) : undefined;
          if (existing) Object.assign(existing, r);
          else tbl.push({ ...r });
        }
        return Promise.resolve({ data: rows, error: null });
      },
      // thenable — `await builder` lands here.
      then<T>(onFulfilled?: (v: { data: unknown; error: unknown }) => T | PromiseLike<T>) {
        return Promise.resolve(run()).then(onFulfilled);
      },
    };
    return builder;
  }

  return { from, rpc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createSupabaseTrackStore", () => {
  let store: MockStore;
  // The mock is structurally partial (just `from` + `rpc`); the impl's typed
  // `SupabaseClient<Database>` param is satisfied via cast at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let serverClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let adminClient: any;

  beforeEach(() => {
    store = makeStore("user-1");
    serverClient = createMockClient(store);
    adminClient = createMockClient(store);
    adminHolder.client = adminClient;
    adminHolder.configured = true;
  });

  it("recordPlay then loadHistory round-trips via track_id/artist columns", async () => {
    const track: MusicTrack = {
      trackId: "yt:dQw4w9WgXcQ",
      sources: { youtube: "dQw4w9WgXcQ" },
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      thumbnail: "https://img.example/rick.jpg",
    };
    const ts = createSupabaseTrackStore(serverClient);

    await ts.recordPlay("user-1", track);

    // The RPC must speak the source-neutral schema (p_track_id / p_artist —
    // NOT the old p_video_id / p_channel).
    const play = store.rpcCalls.find((c) => c.name === "log_music_play");
    expect(play).toBeTruthy();
    expect(play!.args).toEqual({
      p_track_id: "yt:dQw4w9WgXcQ",
      p_title: "Never Gonna Give You Up",
      p_artist: "Rick Astley",
      p_thumbnail: "https://img.example/rick.jpg",
    });

    const history = await ts.loadHistory("user-1");
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      trackId: "yt:dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      thumbnail: "https://img.example/rick.jpg",
      playCount: 1,
      lastPlayedAt: expect.any(String),
      skipCount: 0,
      completeCount: 0,
      sources: { youtube: "dQw4w9WgXcQ" },
    });
  });

  it("recordSignal(skip) increments skip_count on the matching play row", async () => {
    const track: MusicTrack = {
      trackId: "yt:abc",
      sources: {},
      title: "T",
      artist: "A",
      thumbnail: null,
    };
    const ts = createSupabaseTrackStore(serverClient);
    await ts.recordPlay("user-1", track);
    await ts.recordSignal("user-1", "yt:abc", "skip");

    const sig = store.rpcCalls.find((c) => c.name === "log_music_signal");
    expect(sig).toBeTruthy();
    expect(sig!.args).toEqual({ p_track_id: "yt:abc", p_signal: "skip" });

    const history = await ts.loadHistory("user-1");
    expect(history[0].skipCount).toBe(1);
    expect(history[0].completeCount).toBe(0);
  });

  it("recordPlay is idempotent on play_count (upsert-increment)", async () => {
    const track: MusicTrack = {
      trackId: "yt:dup",
      sources: {},
      title: "T",
      artist: "A",
      thumbnail: null,
    };
    const ts = createSupabaseTrackStore(serverClient);
    await ts.recordPlay("user-1", track);
    await ts.recordPlay("user-1", track);

    const history = await ts.loadHistory("user-1");
    expect(history).toHaveLength(1);
    expect(history[0].playCount).toBe(2);
  });

  it("setTags writes via admin client; getTags reads via server client", async () => {
    const ts = createSupabaseTrackStore(serverClient);
    await ts.setTags("yt:xyz", ["pop", "80s"]);
    expect(store.upserts.some((u) => u.table === "music_track_tags")).toBe(true);

    const tags = await ts.getTags("yt:xyz");
    expect(tags).toEqual(["pop", "80s"]);
  });

  it("getTags returns null when no row exists", async () => {
    const ts = createSupabaseTrackStore(serverClient);
    const tags = await ts.getTags("yt:missing");
    expect(tags).toBeNull();
  });

  it("loadHistory is defensive — returns [] on error (widget must not 500)", async () => {
    store.forceError = true;
    const ts = createSupabaseTrackStore(serverClient);
    const history = await ts.loadHistory("user-1");
    expect(history).toEqual([]);
  });

  it("loadTransitionBias computes the Laplace-smoothed, damped bias", async () => {
    store.tables.music_transitions = [
      { user_id: "user-1", from_track_id: "yt:a", to_track_id: "yt:b", skips: 0, completions: 9, updated_at: "" },
      { user_id: "user-1", from_track_id: "yt:a", to_track_id: "yt:c", skips: 5, completions: 0, updated_at: "" },
    ];
    const ts = createSupabaseTrackStore(serverClient);
    const bias = await ts.loadTransitionBias("user-1");
    // 9 completions, 0 skips → strong positive; 5 skips, 0 completions → strong negative.
    expect(bias.get("yt:a>yt:b")!).toBeGreaterThan(0);
    expect(bias.get("yt:a>yt:c")!).toBeLessThan(0);
  });
});
