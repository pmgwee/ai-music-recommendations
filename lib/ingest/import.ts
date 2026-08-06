/**
 * Playlist import — the import-as-taste pipeline (SP-3 Task 2).
 *
 * Imported tracks become a **cold-start history prior** that fades as real
 * behaviour accrues: each resolved track is upserted into `music_plays` with
 * `play_count=1` (ON CONFLICT DO NOTHING, so a re-import or a track the user
 * already plays never inflates the count). The engine's `buildShelf` already
 * weights history softly, so the prior influences seed selection early and
 * washes out as real plays/skips accumulate — no special "imported" ranker
 * branch needed.
 *
 * Three tables, three write paths:
 *   - `music_plays`     — cookie client, ON CONFLICT DO NOTHING (cold-start seed;
 *                         never overwrites real history).
 *   - `music_imports`   — cookie client, upsert on the composite PK (idempotent
 *                         re-import: refreshes name/imported_at in place).
 *   - `music_track_sources` — admin (service-role) client. Catalog-global table
 *                         with no owner-write policy (same shape as
 *                         `music_track_tags`); the cookie client can't write it.
 *
 * Per-source budget: a 2000-track Spotify library must not drown a 20-track
 * YouTube one. If `tracks.length > BUDGET`, a deterministic uniform sample of
 * size BUDGET is taken (seeded Fisher-Yates; re-imports are stable, original
 * order preserved in the sample). `sampled: true` flags it to the caller/UI.
 *
 * Never throws — every per-track failure resolves to `skipped++`. A bad track
 * (unresolvable, network blip) must never abort the whole playlist.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandidateSource } from "@music-ai/engine";
import type { Database } from "../supabase/types";
import { createSupabaseAdminClient, isAdminConfigured } from "../supabase/admin";
import { resolveToYoutube } from "./resolver";

/** Per-source backstop so one huge playlist can't drown the ranker. */
export const IMPORT_BUDGET = 200;

/** A playlist track in the source provider's terms. */
export interface ImportInputTrack {
  title: string;
  artist: string;
  /** ISRC when the source provider exposes one (Spotify always; YouTube rarely). */
  isrc?: string;
  /** Provider-native id in the source playlist (Spotify track id / YT video id). */
  sourceId: string;
}

export interface ImportPlaylistArgs {
  /** Cookie-bound server client — owner-all RLS on music_plays + music_imports. */
  supabase: SupabaseClient<Database>;
  userId: string;
  provider: "youtube" | "spotify";
  playlist: { id: string; name: string };
  tracks: ImportInputTrack[];
  candidateSource: CandidateSource;
}

export interface ImportResult {
  resolved: number;
  skipped: number;
  /** True when the input exceeded the budget and was sampled down. */
  sampled: boolean;
}

/**
 * Deterministic uniform sample of size `budget` from `items`. Seeded
 * Fisher-Yates then take the first `budget` indices (re-imports of the same
 * playlist are stable across runs); the sample is re-sorted to original order
 * so the user sees playlist order, not shuffle order. When `items.length <=
 * budget` the array is returned untouched.
 */
export function sampleToBudget<T>(items: readonly T[], budget: number): T[] {
  if (items.length <= budget) return [...items];
  if (budget <= 0) return [];
  // Seed derived from the inputs so the SAME playlist always samples the SAME
  // tracks — important for idempotent re-imports and for reproducible tests.
  const seed = (items.length * 2654435761) ^ (budget * 40503);
  const rand = mulberry32(seed >>> 0);
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx
    .slice(0, budget)
    .sort((a, b) => a - b)
    .map((i) => items[i]);
}

/** Minimal seeded PRNG (mulberry32) — deterministic sampling, no deps. */
function mulberry32(state: number): () => number {
  let a = state;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Import one playlist's tracks as cold-start taste. See the module doc for the
 * three-table write plan and the budget contract.
 *
 * NOTE on `trackStore`: the SP-3 plan's args mention a trackStore, but the
 * engine's `recordPlay` RPC does `play_count + 1` on conflict — wrong for an
 * idempotent cold-start seed (a re-import or a track with real history would
 * double-count). We use the cookie client directly with
 * `ignoreDuplicates: true` so the prior is planted exactly once and real
 * history is never overwritten.
 */
export async function importPlaylist(
  args: ImportPlaylistArgs,
): Promise<ImportResult> {
  const sampledTracks = sampleToBudget(args.tracks, IMPORT_BUDGET);
  const sampled = sampledTracks.length < args.tracks.length;

  // Admin client for music_track_sources. Created lazily and only when
  // configured — the write is best-effort (same pattern as setTags).
  const admin = isAdminConfigured() ? createSupabaseAdminClient() : null;

  let resolved = 0;
  let skipped = 0;

  for (const t of sampledTracks) {
    try {
      const match = await resolveToYoutube(t, args.candidateSource);
      if (!match) {
        skipped++;
        continue;
      }
      const { track } = match;
      const trackId = track.trackId;

      // --- music_plays: cold-start prior (ON CONFLICT DO NOTHING) ---
      // Only seeds when no row exists; a real-played or previously-imported
      // track is left untouched. play_count stays at 1.
      const playsUpsert = await args.supabase.from("music_plays").upsert(
        {
          user_id: args.userId,
          track_id: trackId,
          title: track.title,
          artist: track.artist ?? "",
          thumbnail: track.thumbnail ?? null,
          play_count: 1,
          skip_count: 0,
          complete_count: 0,
        },
        { onConflict: "user_id,track_id", ignoreDuplicates: true },
      );
      if (playsUpsert.error) {
        console.error("[ingest/import] music_plays seed failed:", playsUpsert.error.message);
        // Don't skip — the music_imports row still records provenance, and a
        // flaky music_plays write shouldn't lose the mapping.
      }

      // --- music_imports: provenance row (idempotent upsert on composite PK) ---
      const importsUpsert = await args.supabase.from("music_imports").upsert(
        {
          user_id: args.userId,
          provider: args.provider,
          source_playlist_id: args.playlist.id,
          source_playlist_name: args.playlist.name,
          track_id: trackId,
          isrc: t.isrc ?? null,
        },
        {
          onConflict: "user_id,provider,source_playlist_id,track_id",
        },
      );
      if (importsUpsert.error) {
        console.error("[ingest/import] music_imports upsert failed:", importsUpsert.error.message);
      }

      // --- music_track_sources: provider routing (catalog-global, admin only) ---
      if (admin) {
        const srcUpsert = await admin.from("music_track_sources").upsert(
          {
            track_id: trackId,
            provider: args.provider,
            source_id: t.sourceId,
          },
          { onConflict: "track_id,provider" },
        );
        if (srcUpsert.error) {
          console.error("[ingest/import] music_track_sources upsert failed:", srcUpsert.error.message);
        }
      }

      resolved++;
    } catch (err) {
      // A thrown error on one track (resolver threw despite its own guards,
      // supabase timed out, etc.) is counted as skipped, not propagated.
      console.error(
        "[ingest/import] track failed:",
        `${t.artist} ${t.title}`,
        (err as Error)?.message ?? err,
      );
      skipped++;
    }
  }

  return { resolved, skipped, sampled };
}
