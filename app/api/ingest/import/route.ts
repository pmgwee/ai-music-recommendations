/**
 * POST /api/ingest/import — import one playlist as cold-start taste.
 *
 * Body: `{ provider, playlistId, playlistName? }`. Session-gated + rate-limited
 * (3/min — imports are scrape-costly: per-track ISRC search through
 * InnerTube). Loads the decrypted token, fetches the playlist's tracks via the
 * provider fetcher, runs `importPlaylist` (the SP-3 T2 pipeline — resolve each
 * track → ISRC-first YouTube match → upsert music_plays / music_imports /
 * music_track_sources), returns the result.
 *
 * Returns:
 *   - 401 `{ error: "not_connected" }` when no token row exists for the
 *     provider — the UI surfaces the connect button.
 *   - 503 `{ error: "not_configured" }` when the provider's OAuth env is unset
 *     (no token could exist; defense in depth).
 *   - 400 `{ error: "invalid_body" }` / `{ error: "invalid_provider" }`.
 *   - 502 `{ error: "provider_fetch_failed" }` when the track listing fails.
 *   - 200 `{ ok: true, provider, resolved, skipped, sampled }`.
 */
import { NextResponse } from "next/server";
import {
  createYoutubeCandidateSource,
  type CandidateSource,
} from "@music-ai/engine";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { rateLimit } from "@/lib/rate-limit";
import { isIngestProvider, getProviderToken } from "@/lib/ingest/tokens";
import { importPlaylist } from "@/lib/ingest/import";
import {
  getYoutubePlaylistTracks,
  isYoutubeConfigured,
} from "@/lib/ingest/providers/youtube";
import {
  getSpotifyPlaylistTracks,
  isSpotifyConfigured,
} from "@/lib/ingest/providers/spotify";

/** Per-user cap. Imports are scrape-costly (per-track ISRC search); 3/min is
 *  generous for a human importing a handful of playlists and stops a script. */
const RATE_LIMIT_OPS = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;

  const rl = rateLimit({
    key: `ingest-import:${auth.userId}`,
    limit: RATE_LIMIT_OPS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // Parse body defensively (bad JSON → 400, never an HTML error page).
  let body: {
    provider?: unknown;
    playlistId?: unknown;
    playlistName?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { provider, playlistId, playlistName } = body;
  if (typeof provider !== "string" || !isIngestProvider(provider)) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }
  if (typeof playlistId !== "string" || !playlistId) {
    return NextResponse.json({ error: "invalid_playlist_id" }, { status: 400 });
  }
  const name = typeof playlistName === "string" ? playlistName : playlistId;

  if (provider === "youtube" && !isYoutubeConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (provider === "spotify" && !isSpotifyConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const token = await getProviderToken(supabase, auth.userId, provider);
  if (!token) {
    return NextResponse.json(
      { error: "not_connected", provider },
      { status: 401 },
    );
  }

  // Fetch the playlist's tracks via the provider adapter.
  let tracks;
  try {
    tracks =
      provider === "youtube"
        ? await getYoutubePlaylistTracks(token.access, playlistId)
        : await getSpotifyPlaylistTracks(token.access, playlistId);
  } catch (err) {
    console.error(
      `[api/ingest/import] ${provider} tracks fetch failed:`,
      err,
    );
    return NextResponse.json(
      { error: "provider_fetch_failed", provider },
      { status: 502 },
    );
  }

  // Run the import-as-taste pipeline. The candidate source is the anonymous
  // InnerTube one (no credentials — used for ISRC + title+artist searches).
  const candidateSource: CandidateSource = createYoutubeCandidateSource();

  try {
    const result = await importPlaylist({
      supabase,
      userId: auth.userId,
      provider,
      playlist: { id: playlistId, name },
      tracks,
      candidateSource,
    });
    return NextResponse.json({ ok: true, provider, ...result });
  } catch (err) {
    console.error("[api/ingest/import] importPlaylist failed:", err);
    return NextResponse.json({ error: "import_failed" }, { status: 500 });
  }
}
