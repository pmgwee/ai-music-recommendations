/**
 * GET /api/ingest/[provider]/playlists — list the connected user's playlists.
 *
 * Session-gated. Loads the decrypted OAuth token from `provider_tokens`; if no
 * row exists (or the encryption root key isn't configured) → 401
 * `{ error: "not_connected" }` so the UI surfaces the connect button. Calls
 * the provider fetcher (mockable in the lib test) and returns the list. 5
 * calls/min per user — coarse enough for the library page (one fetch on load
 * + a refresh after connecting) and stops a tight loop hammering the provider
 * API (which has its own quota).
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { rateLimit } from "@/lib/rate-limit";
import { isIngestProvider, getProviderToken } from "@/lib/ingest/tokens";
import {
  listYoutubePlaylists,
  isYoutubeConfigured,
} from "@/lib/ingest/providers/youtube";
import {
  listSpotifyPlaylists,
  isSpotifyConfigured,
} from "@/lib/ingest/providers/spotify";

/** Per-user cap. Generous for a human (load + refresh), stops a loop. */
const RATE_LIMIT_OPS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider } = await ctx.params;
  if (!isIngestProvider(provider)) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;

  const rl = rateLimit({
    key: `ingest-playlists:${auth.userId}:${provider}`,
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

  // Creds must be set (otherwise no row could have been written, and the
  // fetcher's URLs would be meaningless — but we check anyway as defense in
  // depth).
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

  try {
    const playlists =
      provider === "youtube"
        ? await listYoutubePlaylists(token.access)
        : await listSpotifyPlaylists(token.access);
    return NextResponse.json({ provider, playlists });
  } catch (err) {
    console.error(`[api/ingest/${provider}/playlists] fetch failed:`, err);
    // 502 — upstream provider error. The UI surfaces "couldn't reach provider".
    return NextResponse.json(
      { error: "provider_fetch_failed", provider },
      { status: 502 },
    );
  }
}
