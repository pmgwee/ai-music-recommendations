/**
 * GET /api/ingest/[provider]/callback — complete the OAuth PKCE flow.
 *
 * The provider (Google / Spotify) redirects here with `?code=...&state=...`
 * on success or `?error=...` on user-cancel/denied. Sequence:
 *   1. Session-gated (the cookie was set under the user's session — a
 *      callback without one is a stale/direct hit).
 *   2. Read + verify the signed PKCE cookie. Missing / bad HMAC → 400
 *      ("stale_or_tampered"). The cookie's `state` must equal the `state`
 *      query param (CSRF defense) — mismatch → 400.
 *   3. Exchange the code (provider lib, mockable) → token envelope.
 *   4. Persist via `setProviderToken` (encrypted at rest).
 *   5. Clear the single-use PKCE cookie + redirect to `<next>?connected=<provider>`
 *      (or `/library?connected=<provider>` when next was absent).
 *
 * Any error is redirected to `/library?error=<slug>` so the user lands back on
 * a useful surface rather than a JSON 500. The slugs are surfaced by the UI.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { isIngestProvider, setProviderToken } from "@/lib/ingest/tokens";
import {
  getPkceCookie,
  clearPkceCookie,
} from "@/lib/ingest/pkce-cookie";
import { exchangeYoutubeCode } from "@/lib/ingest/providers/youtube";
import { exchangeSpotifyCode } from "@/lib/ingest/providers/spotify";

/** Safe redirect target (server-relative, no open-redirect). */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/library";
  return next;
}

/** Redirect to /library (or `next`) carrying an error slug so the UI surfaces
 *  it. Always used in lieu of a JSON error — the user is mid-OAuth-handshake. */
function redirectWithError(
  provider: string,
  slug: string,
  next?: string,
): NextResponse {
  const url = new URL(safeNext(next), "http://n");
  url.searchParams.set("error", slug);
  url.searchParams.set("provider", provider);
  return NextResponse.redirect(url.toString().replace("http://n", ""));
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider } = await ctx.params;
  if (!isIngestProvider(provider)) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const providerError =
    url.searchParams.get("error") ?? url.searchParams.get("error_description");

  // PKCE cookie — must be present + verify (signed).
  const pkce = await getPkceCookie(provider);
  if (!pkce) {
    return redirectWithError(provider, "stale_or_tampered");
  }

  const next = pkce.next;

  // Provider-reported error (user clicked cancel, app not approved, etc.).
  if (providerError) {
    await clearPkceCookie(provider);
    return redirectWithError(provider, "provider_denied", next);
  }
  // Missing code or state mismatch (CSRF guard).
  if (!code || !stateParam || stateParam !== pkce.state) {
    await clearPkceCookie(provider);
    return redirectWithError(provider, "state_mismatch", next);
  }

  try {
    // Exchange the code → token envelope + granted scope. Provider lib handles
    // the fetch (mockable from tests via the lib's own test file).
    const { token, scope } =
      provider === "youtube"
        ? await exchangeYoutubeCode(code, pkce.codeVerifier)
        : await exchangeSpotifyCode(code, pkce.codeVerifier);

    // Persist the encrypted token envelope.
    await setProviderToken(supabase, auth.userId, provider, token, scope);

    // Consume the single-use PKCE cookie.
    await clearPkceCookie(provider);

    const target = new URL(safeNext(next), "http://n");
    target.searchParams.set("connected", provider);
    return NextResponse.redirect(
      target.toString().replace("http://n", ""),
    );
  } catch (err) {
    console.error(
      `[api/ingest/${provider}/callback] exchange or store failed:`,
      err,
    );
    await clearPkceCookie(provider);
    return redirectWithError(provider, "exchange_failed", next);
  }
}
