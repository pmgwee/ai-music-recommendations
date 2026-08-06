/**
 * Supabase implementation of the engine's `TrackStore` seam.
 *
 * Reads (history / likes / suppressions / transitions / tag-cache read) run on
 * the cookie-bound server client — RLS scopes every row to the signed-in user.
 * The single write that is catalog-global rather than user-scoped — `setTags`
 * (a track's genre/mood/era is the same for everyone) — goes through the
 * service-role admin client, because `music_track_tags` has no insert/update
 * policy for cookie-scoped callers.
 *
 * Ported from subscription-agent's `lib/music/store.ts` + `tags-store.ts`,
 * renamed to the source-neutral schema (video_id → track_id, channel → artist,
 * from_video_id → from_track_id, to_video_id → to_track_id). The engine types
 * (`HistoryEntry` / `LikedTrack` / `Suppressions` / `MusicTrack`) use the
 * canonical `trackId` / `artist` spellings, so DB rows are mapped at the boundary.
 *
 * `recordPlay` / `recordSignal` use the `log_music_play` / `log_music_signal`
 * RPCs (atomic upsert-increment, `security invoker` → RLS applies as the
 * caller; `auth.uid()` keys the row). The `userId` parameter these methods
 * receive is the engine's view of the same identity the cookie carries — the
 * RPC itself does not take a user argument.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  TrackStore,
  MusicTrack,
  HistoryEntry,
  LikedTrack,
  Suppressions,
  TrackSources,
} from "@music-ai/engine";
import type { Database } from "../supabase/types";
import { createSupabaseAdminClient, isAdminConfigured } from "../supabase/admin";

type ServerClient = SupabaseClient<Database>;

/** How much history feeds seed selection. Deeper than the old 24-row shelf. */
const HISTORY_LIMIT = 60;

/**
 * @param serverClient Cookie-bound server client (RLS-enforced).
 */
export function createSupabaseTrackStore(
  serverClient: ServerClient,
): TrackStore {
  return {
    // -------------------------------------------------------------------------
    async loadHistory(userId: string): Promise<HistoryEntry[]> {
      const { data, error } = await serverClient
        .from("music_plays")
        .select(
          "track_id, title, artist, thumbnail, play_count, last_played_at, skip_count, complete_count",
        )
        .eq("user_id", userId)
        .order("last_played_at", { ascending: false })
        .limit(HISTORY_LIMIT);

      if (error || !data) {
        if (error) console.error("[track-store] history load failed:", error.message);
        return [];
      }

      return data.map((row) => ({
        trackId: row.track_id,
        title: row.title,
        artist: row.artist,
        thumbnail: row.thumbnail,
        playCount: row.play_count,
        lastPlayedAt: row.last_played_at,
        skipCount: row.skip_count ?? 0,
        completeCount: row.complete_count ?? 0,
        // SP-0 stores `yt:`-prefixed trackIds. Derive the youtube provider id
        // app-side (the engine stays source-neutral — it never assumes a
        // provider). A future non-youtube trackId yields `{}`.
        sources: row.track_id.startsWith("yt:")
          ? { youtube: row.track_id.slice(3) }
          : {},
      }));
    },

    // -------------------------------------------------------------------------
    async loadLikes(userId: string): Promise<LikedTrack[]> {
      const { data, error } = await serverClient
        .from("music_likes")
        .select("track_id, title, artist, thumbnail, liked_at")
        .eq("user_id", userId)
        .order("liked_at", { ascending: false })
        .limit(500);

      if (error || !data) {
        if (error) console.error("[track-store] likes load failed:", error.message);
        return [];
      }

      return data.map((row) => ({
        trackId: row.track_id,
        title: row.title,
        artist: row.artist,
        thumbnail: row.thumbnail,
        likedAt: row.liked_at,
      }));
    },

    // -------------------------------------------------------------------------
    async loadSuppressions(userId: string): Promise<Suppressions> {
      const suppressions: Suppressions = {
        notInterested: new Set(),
        snoozedUntil: new Map(),
      };

      const { data, error } = await serverClient
        .from("music_suppressions")
        .select("track_id, kind, until")
        .eq("user_id", userId)
        .limit(2000);

      if (error || !data) {
        if (error) console.error("[track-store] suppressions load failed:", error.message);
        return suppressions;
      }

      const now = Date.now();
      for (const row of data) {
        if (row.kind === "not_interested") {
          suppressions.notInterested.add(row.track_id);
          continue;
        }
        // An expired snooze is simply not returned — the row can stay until it
        // is overwritten, so lapsing needs no cleanup job.
        if (row.until && Date.parse(row.until) > now) {
          suppressions.snoozedUntil.set(row.track_id, row.until);
        }
      }
      return suppressions;
    },

    // -------------------------------------------------------------------------
    async loadTransitionBias(userId: string): Promise<Map<string, number>> {
      const bias = new Map<string, number>();

      const { data, error } = await serverClient
        .from("music_transitions")
        .select("from_track_id, to_track_id, skips, completions")
        .eq("user_id", userId)
        .limit(2000);

      if (error || !data) {
        if (error) console.error("[track-store] transition load failed:", error.message);
        return bias;
      }

      for (const row of data) {
        const total = row.skips + row.completions;
        if (total === 0) continue;
        // Laplace-smoothed completion rate, recentred on 0 and damped by
        // evidence: one observation moves the needle a little, ten move it a
        // lot. Bounded ±0.5 so a couple of early points can nudge, never dictate.
        const rate = (row.completions + 1) / (total + 2);
        const confidence = Math.min(1, total / 10);
        bias.set(`${row.from_track_id}>${row.to_track_id}`, (rate - 0.5) * confidence);
      }

      return bias;
    },

    // -------------------------------------------------------------------------
    async recordPlay(userId: string, track: MusicTrack): Promise<void> {
      // `log_music_play` is `security invoker` — `auth.uid()` on the cookie
      // keys the row, so the passed `userId` (the engine's view of the same
      // identity) is not forwarded as an RPC argument.
      void userId;
      const { error } = await serverClient.rpc("log_music_play", {
        p_track_id: track.trackId,
        p_title: track.title,
        p_artist: track.artist ?? "",
        // Generated arg type is non-null text; "" is falsy everywhere it's read.
        p_thumbnail: track.thumbnail ?? "",
      });
      if (error) console.error("[track-store] recordPlay failed:", error.message);
    },

    // -------------------------------------------------------------------------
    async recordSignal(
      userId: string,
      trackId: string,
      signal: "skip" | "complete",
    ): Promise<void> {
      // No-op if the track was never played (music_plays has no row to update).
      // `auth.uid()` resolves the user.
      void userId;
      const { error } = await serverClient.rpc("log_music_signal", {
        p_track_id: trackId,
        p_signal: signal,
      });
      if (error) console.error("[track-store] recordSignal failed:", error.message);
    },

    // -------------------------------------------------------------------------
    // Tag cache (LLM prior) — catalog-global (no user_id). Reads via the server
    // client (RLS allows authenticated read); writes via service role only.
    // -------------------------------------------------------------------------
    async getTags(trackId: string): Promise<string[] | null> {
      const { data, error } = await serverClient
        .from("music_track_tags")
        .select("tags")
        .eq("track_id", trackId)
        .maybeSingle();
      if (error || !data) return null;
      return Array.isArray(data.tags) ? (data.tags as string[]) : null;
    },

    async setTags(trackId: string, tags: string[]): Promise<void> {
      // Service role not configured (dev/mock) → skip persistence; the ranker
      // recomputes on the fly. Never throw — the cache is best-effort.
      if (!isAdminConfigured()) return;
      const admin = createSupabaseAdminClient();
      const { error } = await admin
        .from("music_track_tags")
        .upsert({ track_id: trackId, tags }, { onConflict: "track_id" });
      if (error) console.error("[track-store] setTags failed:", error.message);
    },
  };
}
