/**
 * GET /api/ingest/[provider]/connect — start the OAuth PKCE flow.
 *
 * Sequence:
 *   1. Session-gated (`requireUser` — 401 JSON without).
 *   2. Provider ∈ {youtube, spotify} (`isIngestProvider` — 400 otherwise).
 *   3. Provider's OAuth env set (`is{Provider}Configured`). If unset → return
 *      `{ error: "not_configured" }` with status 503 so the UI surfaces "the
 *      operator hasn't registered an OAuth client yet" cleanly. This is the
 *      SP-3 T3 gating contract: the routes are scaffolded but inert until the
 *      user supplies client creds.
 *   4. Generate `codeVerifier` + `state` (random), derive `codeChallenge`,
 *      stash `{state, codeVerifier}` in a signed httponly PKCE cookie
 *      (10 min, samesite=lax) — see `lib/ingest/pkce-cookie.ts`.
 *   5. Build the provider auth URL and 302 to it.
 *
 * `state` is double-purposed: it carries `next` (the page to land on after
 * connect) so a connect-from-/library returns to /library. We keep the OAuth
 * `state` short (random nonce) and put the `next` in the PKCE cookie payload
 * alongside the verifier — the cookie is signed, so `next` can't be tampered
 * with post-issuance, and the callback is the only reader.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { isIngestProvider } from "@/lib/ingest/tokens";
import {
  setPkceCookie,
  type PkceCookiePayload,
} from "@/lib/ingest/pkce-cookie";
import {
  buildYoutubeAuthUrl,
  deriveCodeChallenge as deriveYoutubeChallenge,
  generateCodeVerifier as generateYoutubeVerifier,
  isYoutubeConfigured,
} from "@/lib/ingest/providers/youtube";
import {
  buildSpotifyAuthUrl,
  deriveCodeChallenge as deriveSpotifyChallenge,
  generateCodeVerifier as generateSpotifyVerifier,
  isSpotifyConfigured,
} from "@/lib/ingest/providers/spotify";

/** Random opaque state — 16 bytes base64url. Short to fit any provider's
 *  state-length requirement (both Google + Spotify accept ≥16 chars). */
function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** Pick the `next` path to land on after a successful connect. Defaults to
 *  /library (the import surface). Clamped to a server-relative path. */
function nextPath(req: Request): string {
  const url = new URL(req.url);
  const next = url.searchParams.get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/library";
  return next;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider } = await ctx.params;
  if (!isIngestProvider(provider)) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  // Auth first — a connect attempt without a session is a misre direct.
  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;

  // Gate on creds — the SP-3 T3 contract.
  if (provider === "youtube" && !isYoutubeConfigured()) {
    return notConfigured("youtube");
  }
  if (provider === "spotify" && !isSpotifyConfigured()) {
    return notConfigured("spotify");
  }

  // Build the PKCE pair + state.
  const state = generateState();
  const next = nextPath(req);
  let authUrl: string;
  let codeVerifier: string;

  if (provider === "youtube") {
    codeVerifier = generateYoutubeVerifier();
    const codeChallenge = await deriveYoutubeChallenge(codeVerifier);
    authUrl = buildYoutubeAuthUrl({ state, codeVerifier, codeChallenge });
  } else {
    codeVerifier = generateSpotifyVerifier();
    const codeChallenge = await deriveSpotifyChallenge(codeVerifier);
    authUrl = buildSpotifyAuthUrl({ state, codeChallenge });
  }

  // Stash the verifier + state + next in the signed PKCE cookie. The callback
  // reads it back, verifies state, and consumes the verifier (single-use).
  const payload: PkceCookiePayload = {
    state,
    codeVerifier,
    next,
  };
  await setPkceCookie(provider, payload);

  return NextResponse.redirect(authUrl);
}

function notConfigured(provider: string) {
  return NextResponse.json(
    {
      error: "not_configured",
      provider,
      message: `OAuth client credentials for ${provider} are not set. The operator must register a ${provider} OAuth client and set the env vars.`,
    },
    { status: 503 },
  );
}
