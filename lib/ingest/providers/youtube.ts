/**
 * YouTube (Google) OAuth adapter + playlist/track fetchers (SP-3 Task 3).
 *
 * Two responsibilities, kept in one module because they share the OAuth client
 * env config:
 *
 *  1. PKCE OAuth scaffolding — `buildYoutubeAuthUrl(state, codeVerifier)` +
 *     `exchangeYoutubeCode(code, codeVerifier)`. Real Google OAuth endpoints
 *     (accounts.google.com); the flow is **live as soon as the operator sets
 *     `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REDIRECT_URI`**.
 *     Until then `isYoutubeConfigured()` returns false and the connect route
 *     surfaces a clean "not_configured" rather than firing a doomed redirect.
 *
 *  2. YouTube Data API v3 fetchers — `listYoutubePlaylists(token)` +
 *     `getYoutubePlaylistTracks(token, playlistId)`. These are the read paths
 *     the playlists/import routes use post-connect. They take the plaintext
 *     access token (decrypted from `provider_tokens` by the caller); they do
 *     NOT touch the DB or the env client secret.
 *
 * Scope: `youtube.readonly` — read-only access to the user's YouTube library
 * (playlists + playlistItems). No uploads, no ratings. Google verification is
 * required for public use (Sensitive scope); dev mode works with test users.
 *
 * All network goes through global `fetch` so tests mock the request shape
 * (URL/headers/body) and assert the response parsing without a network round
 * trip — same pattern as `lib/providers/llm-byok.test.ts`.
 */
import type { ProviderTokenEnvelope, IngestProvider } from "../tokens";
import type { ImportInputTrack } from "../import";

/** Provider id (matches the `provider_tokens.provider` CHECK constraint). */
export const YOUTUBE_PROVIDER: IngestProvider = "youtube";

/** OAuth scope requested — read-only library access. */
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

/** Google OAuth 2.0 endpoints (web server flow, PKCE-enabled). */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** YouTube Data API v3 endpoints (playlist + playlistItem listing). */
const YT_PLAYLISTS_URL = "https://www.googleapis.com/youtube/v3/playlists";
const YT_PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";

/** Maximum results per page for playlist/playlistItems listing. The API caps
 *  at 50; we page through everything. */
const YT_MAX_PAGE = 50;

// ---------------------------------------------------------------------------
// Env config — client creds + redirect URI. All three must be set for the flow
// to be "configured"; the connect route gates on `isYoutubeConfigured()`.
// ---------------------------------------------------------------------------

/** Read the YouTube OAuth env config (server-only). Returns null when any of
 *  the three required env vars is unset. */
export function getYoutubeEnv(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} | null {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** True when all three YouTube OAuth env vars are set. The connect route uses
 *  this to return "not_configured" cleanly instead of building a doomed URL. */
export function isYoutubeConfigured(): boolean {
  return getYoutubeEnv() !== null;
}

// ---------------------------------------------------------------------------
// PKCE helpers. PKCE (RFC 7636) protects the authorization-code exchange from
// a malicious browser extension / intercepting proxy: the client proves
// possession of the `code_verifier` by sending its SHA-256 hash
// (`code_challenge`) at the auth-URL step, then sends the verifier itself at
// the token-exchange step. Google supports S256 (the only secure method).
// ---------------------------------------------------------------------------

/**
 * Build a high-entropy PKCE `code_verifier` (43-128 chars, [A-Z/a-z/0-9/-._~]).
 * 96 base64url chars from 72 bytes ≈ 430 bits of entropy — well above the
 * 256-bit floor.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(72);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Derive the `code_challenge` (S256 method) from a `code_verifier`:
 * `challenge = base64url( SHA-256( verifier ) )`. Per RFC 7636 §4.2.
 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64UrlEncode(new Uint8Array(digest));
}

/** base64url encoder (no padding) — the URL-safe variant OAuth expects. */
function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Build the Google OAuth authorization URL the browser is redirected to. The
 * caller generates `codeVerifier`, persists it + `state` in a short-lived
 * httponly cookie (the callback reads it back), and passes both in.
 *
 * `access_type=offline` requests a refresh token (so the server can mint new
 * access tokens without re-prompting); `prompt=consent` forces the consent
 * screen so Google returns a refresh token even on repeat connections (a
 * refresh token is only issued on the first `offline` grant for a given
 * client+user pair unless `prompt=consent` is set).
 */
export function buildYoutubeAuthUrl(args: {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}): string {
  const env = getYoutubeEnv();
  if (!env) {
    throw new Error(
      "[ingest/providers/youtube] buildYoutubeAuthUrl called without env " +
        "(YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REDIRECT_URI). " +
        "Gate the route on isYoutubeConfigured() first.",
    );
  }
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Shape of the token response from Google's token endpoint. */
interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Exchange an authorization code for an access + refresh token (PKCE).
 *
 * POSTs to `https://oauth2.googleapis.com/token` with `grant_type=
 * authorization_code`, the `code`, the `code_verifier` (must hash to the
 * `code_challenge` sent at the auth URL), and the client id + secret +
 * redirect_uri. Returns the parsed token envelope (the same shape stored in
 * `provider_tokens`). Throws on non-2xx or a malformed response.
 *
 * Tested via mocked `fetch` — the request URL/headers/body + the response
 * parsing are asserted, no network.
 */
export async function exchangeYoutubeCode(
  code: string,
  codeVerifier: string,
): Promise<{ token: ProviderTokenEnvelope; scope: string }> {
  const env = getYoutubeEnv();
  if (!env) {
    throw new Error(
      "[ingest/providers/youtube] exchangeYoutubeCode called without env.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.redirectUri,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    code_verifier: codeVerifier,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(
      `[ingest/providers/youtube] token exchange failed (${res.status}): ${detail}`,
    );
  }

  const json = (await res.json()) as GoogleTokenResponse;
  if (!json.access_token) {
    throw new Error(
      "[ingest/providers/youtube] token response missing access_token",
    );
  }

  const token: ProviderTokenEnvelope = {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : undefined,
  };
  return { token, scope: json.scope ?? YOUTUBE_SCOPE };
}

// ---------------------------------------------------------------------------
// YouTube Data API fetchers. Take the plaintext access token (the caller
// decrypts from provider_tokens); they don't read env or the DB. All paged.
// ---------------------------------------------------------------------------

/** A YouTube playlist listed for the connected user. */
export interface YoutubePlaylist {
  id: string;
  title: string;
  /** Item count per YouTube's own metadata; may be absent for new playlists. */
  itemCount?: number;
  /** YouTube playlist thumbnail (first thumbnail), if any. */
  thumbnail?: string;
}

/**
 * List the connected user's own playlists (mine=true). Pages through all
 * results; throws on a non-2xx response (the route surfaces a structured
 * error). Note: returns up to a hard ceiling of 500 playlists (10 pages × 50)
 * — well above any real user library; the ceiling stops a pathological account
 * from looping the API forever.
 */
export async function listYoutubePlaylists(
  token: string,
): Promise<YoutubePlaylist[]> {
  const out: YoutubePlaylist[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      part: "snippet,contentDetails",
      mine: "true",
      maxResults: String(YT_MAX_PAGE),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${YT_PLAYLISTS_URL}?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(
        `[ingest/providers/youtube] playlists fetch failed (${res.status}): ${detail}`,
      );
    }
    const json = (await res.json()) as {
      items?: Array<{
        id: string;
        snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
        contentDetails?: { itemCount?: number };
      }>;
      nextPageToken?: string;
    };
    for (const item of json.items ?? []) {
      out.push({
        id: item.id,
        title: item.snippet?.title ?? "",
        itemCount: item.contentDetails?.itemCount,
        thumbnail: item.snippet?.thumbnails?.default?.url,
      });
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

/**
 * Fetch all tracks in one playlist (YouTube Data API `playlistItems`). Each
 * item becomes a `{title, artist, sourceId}` ImportInputTrack — ISRC is rarely
 * exposed by YouTube Data API, so the importer's ISRC-first resolver falls
 * through to title+artist search for these (the title-fallback path). Pages
 * through the whole playlist; same 500-item hard ceiling.
 */
export async function getYoutubePlaylistTracks(
  token: string,
  playlistId: string,
): Promise<ImportInputTrack[]> {
  const out: ImportInputTrack[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      part: "snippet,contentDetails",
      playlistId,
      maxResults: String(YT_MAX_PAGE),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${YT_PLAYLIST_ITEMS_URL}?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(
        `[ingest/providers/youtube] playlistItems fetch failed (${res.status}): ${detail}`,
      );
    }
    const json = (await res.json()) as {
      items?: Array<{
        snippet?: {
          title?: string;
          videoOwnerChannelTitle?: string;
          resourceId?: { videoId?: string };
        };
        contentDetails?: { videoId?: string; videoPublishedAt?: string };
      }>;
      nextPageToken?: string;
    };
    for (const item of json.items ?? []) {
      const videoId =
        item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
      if (!videoId) continue;
      const rawTitle = item.snippet?.title ?? "";
      // YouTube titles occasionally come as "Artist - Title" or just "Title".
      // Split on " - " once so the resolver's `${artist} ${title}` search
      // matches the way YouTube Music indexes the recording.
      const { title, artist } = splitTitleArtist(rawTitle);
      if (!title) continue;
      out.push({ title, artist, sourceId: videoId });
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

/** Best-effort "Artist - Title" split. Falls back to whole-title + "" so the
 *  resolver still gets a query string for one-element titles. */
function splitTitleArtist(raw: string): { title: string; artist: string } {
  const idx = raw.indexOf(" - ");
  if (idx < 0) return { title: raw.trim(), artist: "" };
  return {
    artist: raw.slice(0, idx).trim(),
    title: raw.slice(idx + 3).trim(),
  };
}

/** Read response text safely (never throws — used only for error detail). */
async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 500 ? text.slice(0, 500) + "…" : text;
  } catch {
    return "<no body>";
  }
}
