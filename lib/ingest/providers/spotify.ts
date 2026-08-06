/**
 * Spotify OAuth adapter + playlist/track fetchers (SP-3 Task 3).
 *
 * Same two-part shape as the YouTube adapter:
 *
 *  1. PKCE OAuth scaffolding — `buildSpotifyAuthUrl(state, codeChallenge)` +
 *     `exchangeSpotifyCode(code, codeVerifier)`. Real Spotify Accounts
 *     endpoints; live as soon as the operator sets `SPOTIFY_CLIENT_ID` /
 *     `SPOTIFY_CLIENT_SECRET` / `SPOTIFY_REDIRECT_URI`. Until then
 *     `isSpotifyConfigured()` returns false and the connect route surfaces
 *     "not_configured".
 *
 *  2. Spotify Web API fetchers — `listSpotifyPlaylists(token)` +
 *     `getSpotifyPlaylistTracks(token, playlistId)`. The crucial difference
 *     from YouTube: Spotify exposes `external_ids.isrc` on nearly every track,
 *     so each playlist item is lifted to `{title, artist, isrc, sourceId}` and
 *     the importer's ISRC-first resolver hits its authoritative-match path.
 *
 * Scope: `playlist-read-private` — read the user's private (non-public)
 * playlists. The lowest-risk Spotify scope for an import-as-taste flow: no
 * streaming, no playlist mutation, no listening history. (Spotify's Terms
 * still apply — see the SP-3 plan's "Open items: legal" note.)
 *
 * All network goes through global `fetch` so tests assert request shape +
 * response parsing without a network round trip.
 */
import type { ProviderTokenEnvelope, IngestProvider } from "../tokens";
import type { ImportInputTrack } from "../import";

/** Provider id (matches the `provider_tokens.provider` CHECK constraint). */
export const SPOTIFY_PROVIDER: IngestProvider = "spotify";

/** OAuth scope requested — private playlist reads only. */
export const SPOTIFY_SCOPE = "playlist-read-private";

/** Spotify OAuth 2.0 endpoints. */
const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Spotify Web API endpoints. */
const SPOTIFY_PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists";
const SPOTIFY_PLAYLIST_TRACKS_TEMPLATE =
  "https://api.spotify.com/v1/playlists/{playlistId}/tracks";

/** Page size for Spotify's list endpoints (max 50). */
const SPOTIFY_MAX_PAGE = 50;

// ---------------------------------------------------------------------------
// Env config — same three-required-vars shape as YouTube.
// ---------------------------------------------------------------------------

/** Read the Spotify OAuth env config (server-only). Returns null when any of
 *  the three required env vars is unset. */
export function getSpotifyEnv(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} | null {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** True when all three Spotify OAuth env vars are set. */
export function isSpotifyConfigured(): boolean {
  return getSpotifyEnv() !== null;
}

// ---------------------------------------------------------------------------
// PKCE helpers (same shape as YouTube; duplicated because base64url + verifier
// length differ between providers in the spec floor but the implementations
// coincide). Spotify mandates PKCE even for the Authorization Code flow
// (client secret in the exchange) since 2025.
// ---------------------------------------------------------------------------

/** Generate a 96-char base64url PKCE verifier (same construction as YouTube). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(72);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Derive the S256 code_challenge from a code_verifier (RFC 7636 §4.2). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Build the Spotify authorization URL. The caller generates + persists the
 * `codeVerifier` and `state` in a short-lived httponly cookie before
 * redirecting here.
 */
export function buildSpotifyAuthUrl(args: {
  state: string;
  codeChallenge: string;
}): string {
  const env = getSpotifyEnv();
  if (!env) {
    throw new Error(
      "[ingest/providers/spotify] buildSpotifyAuthUrl called without env " +
        "(SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REDIRECT_URI). " +
        "Gate the route on isSpotifyConfigured() first.",
    );
  }
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: "code",
    scope: SPOTIFY_SCOPE,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/** Shape of the token response from Spotify's token endpoint. */
interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Exchange an authorization code for an access + refresh token. Spotify accepts
 * the standard Authorization Code + PKCE exchange: client_id + client_secret
 * (Basic auth) + the code + code_verifier + redirect_uri. Returns the parsed
 * envelope to persist in `provider_tokens`.
 *
 * Spotify only issues a `refresh_token` once per (client, user) pair — on the
 * first `consent` grant — so re-connection without clearing server state can
 * yield a response with no refresh. The store treats refresh as optional.
 */
export async function exchangeSpotifyCode(
  code: string,
  codeVerifier: string,
): Promise<{ token: ProviderTokenEnvelope; scope: string }> {
  const env = getSpotifyEnv();
  if (!env) {
    throw new Error(
      "[ingest/providers/spotify] exchangeSpotifyCode called without env.",
    );
  }
  const basic = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString(
    "base64",
  );
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(
      `[ingest/providers/spotify] token exchange failed (${res.status}): ${detail}`,
    );
  }

  const json = (await res.json()) as SpotifyTokenResponse;
  if (!json.access_token) {
    throw new Error(
      "[ingest/providers/spotify] token response missing access_token",
    );
  }

  const token: ProviderTokenEnvelope = {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : undefined,
  };
  return { token, scope: json.scope ?? SPOTIFY_SCOPE };
}

// ---------------------------------------------------------------------------
// Spotify Web API fetchers. Take the plaintext access token; no env/DB access.
// ---------------------------------------------------------------------------

/** A Spotify playlist listed for the connected user. */
export interface SpotifyPlaylist {
  id: string;
  name: string;
  /** Track/episode count per Spotify's metadata; absent for empty playlists. */
  tracksTotal?: number;
  /** First cover image URL (Spotify returns an array, largest first). */
  thumbnail?: string;
  /** Whether the playlist is owned by the current user (Spotify returns the
   *  user's followed playlists too; the importer doesn't care, but the UI may). */
  owner?: string;
}

/**
 * List the connected user's playlists (their own + followed). Pages through
 * all results; same 500-playlist hard ceiling as YouTube. Throws on a non-2xx
 * response.
 */
export async function listSpotifyPlaylists(
  token: string,
): Promise<SpotifyPlaylist[]> {
  const out: SpotifyPlaylist[] = [];
  let url: string | undefined = `${SPOTIFY_PLAYLISTS_URL}?limit=${SPOTIFY_MAX_PAGE}`;
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(
        `[ingest/providers/spotify] playlists fetch failed (${res.status}): ${detail}`,
      );
    }
    const json = (await res.json()) as {
      items?: Array<{
        id: string;
        name?: string;
        images?: Array<{ url?: string }>;
        tracks?: { total?: number };
        owner?: { display_name?: string; id?: string };
      }>;
      next?: string | null;
    };
    for (const item of json.items ?? []) {
      out.push({
        id: item.id,
        name: item.name ?? "",
        tracksTotal: item.tracks?.total,
        thumbnail: item.images?.[0]?.url,
        owner: item.owner?.display_name ?? item.owner?.id,
      });
    }
    url = json.next ?? undefined;
  }
  return out;
}

/**
 * Fetch all tracks in one Spotify playlist. Each item becomes a
 * `{title, artist, isrc, sourceId}` ImportInputTrack — ISRC is the load-bearing
 * field here: Spotify returns `external_ids.isrc` on virtually every track, and
 * the ISRC-first resolver treats that as an authoritative match (the highest
 * confidence path). Skips episodes (podcasts) and null tracks (removed tracks
 * show up as `null` in Spotify's `items` array). Pages through the whole
 * playlist; 500-item hard ceiling.
 */
export async function getSpotifyPlaylistTracks(
  token: string,
  playlistId: string,
): Promise<ImportInputTrack[]> {
  const out: ImportInputTrack[] = [];
  const endpoint = SPOTIFY_PLAYLIST_TRACKS_TEMPLATE.replace(
    "{playlistId}",
    encodeURIComponent(playlistId),
  );
  let url: string | undefined = `${endpoint}?limit=${SPOTIFY_MAX_PAGE}&additional_types=track`;
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(
        `[ingest/providers/spotify] playlist tracks fetch failed (${res.status}): ${detail}`,
      );
    }
    const json = (await res.json()) as {
      items?: Array<{
        track?: {
          id?: string;
          name?: string;
          external_ids?: { isrc?: string };
          artists?: Array<{ name?: string }>;
          type?: string;
        };
      } | null>;
      next?: string | null;
    };
    for (const item of json.items ?? []) {
      const track = item?.track;
      // Skip episodes (podcasts), null tracks (removed), and non-tracks.
      if (!track || track.type === "episode") continue;
      if (!track.name) continue;
      const artist = (track.artists ?? [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(", ");
      const isrc = track.external_ids?.isrc?.trim() || undefined;
      const sourceId = track.id ?? "";
      out.push({
        title: track.name,
        artist,
        isrc,
        sourceId,
      });
    }
    url = json.next ?? undefined;
  }
  return out;
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
