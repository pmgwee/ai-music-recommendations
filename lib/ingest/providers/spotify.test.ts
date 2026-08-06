/**
 * Spotify provider adapter tests.
 *
 * Same fetch-mock shape as youtube.test.ts; asserts:
 *   - `buildSpotifyAuthUrl` produces the Spotify Accounts URL with PKCE.
 *   - `exchangeSpotifyCode` POSTs with Basic auth + body + parses the envelope.
 *   - `listSpotifyPlaylists` uses the bearer + pages via `next`.
 *   - `getSpotifyPlaylistTracks` extracts `{title, artist, isrc, sourceId}`
 *     from each track and skips null/episode items.
 *   - The "not_configured" gating when env unset.
 *
 * The ISRC extraction is the load-bearing assertion: Spotify tracks MUST lift
 * `external_ids.isrc` into the ImportInputTrack so the resolver hits its
 * authoritative-match path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildSpotifyAuthUrl,
  deriveCodeChallenge,
  exchangeSpotifyCode,
  generateCodeVerifier,
  getSpotifyPlaylistTracks,
  isSpotifyConfigured,
  listSpotifyPlaylists,
  SPOTIFY_SCOPE,
} from "./spotify";

// ---------------------------------------------------------------------------
// fetch mock (mirrors youtube.test.ts)
// ---------------------------------------------------------------------------
type FetchCall = {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
};

function makeResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? (status >= 200 && status < 300);
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => payload,
  };
}

function installFetchMock() {
  const calls: FetchCall[] = [];
  const queue: ReturnType<typeof makeResponse>[] = [];
  const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    calls.push({
      url: _url.toString(),
      init: {
        method: _init?.method,
        headers: (_init?.headers as Record<string, string>) ?? {},
        body: (_init?.body as string | undefined) ?? undefined,
      },
    });
    const next = queue.shift();
    if (!next) throw new Error("test forgot to queue a fetch response");
    return next;
  });
  vi.stubGlobal("fetch", fetchFn);
  return {
    calls,
    queueResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
      queue.push(makeResponse(body, init));
    },
  };
}

const SP_ENV = {
  clientId: "spotify-client-id",
  clientSecret: "spotify-secret",
  redirectUri: "http://localhost:3000/api/ingest/spotify/callback",
};

beforeEach(() => {
  vi.stubEnv("SPOTIFY_CLIENT_ID", SP_ENV.clientId);
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", SP_ENV.clientSecret);
  vi.stubEnv("SPOTIFY_REDIRECT_URI", SP_ENV.redirectUri);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isSpotifyConfigured", () => {
  it("true when all three env vars are set", () => {
    expect(isSpotifyConfigured()).toBe(true);
  });

  it("false when client id is missing", () => {
    vi.stubEnv("SPOTIFY_CLIENT_ID", "");
    expect(isSpotifyConfigured()).toBe(false);
  });

  it("false when client secret is missing", () => {
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "");
    expect(isSpotifyConfigured()).toBe(false);
  });

  it("false when redirect uri is missing", () => {
    vi.stubEnv("SPOTIFY_REDIRECT_URI", "");
    expect(isSpotifyConfigured()).toBe(false);
  });
});

describe("PKCE helpers", () => {
  it("generateCodeVerifier yields a 96-char base64url string", () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(96);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("deriveCodeChallenge is deterministic + 43 chars", async () => {
    const v = "x".repeat(80);
    const a = await deriveCodeChallenge(v);
    expect(a).toHaveLength(43);
    expect(await deriveCodeChallenge(v)).toBe(a);
  });
});

describe("buildSpotifyAuthUrl", () => {
  it("hits Spotify Accounts with client_id + PKCE + playlist-read-private scope", () => {
    const url = buildSpotifyAuthUrl({
      state: "s-state",
      codeChallenge: "ch".repeat(22).slice(0, 43),
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://accounts.spotify.com/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe(SP_ENV.clientId);
    expect(parsed.searchParams.get("redirect_uri")).toBe(SP_ENV.redirectUri);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe(SPOTIFY_SCOPE);
    expect(parsed.searchParams.get("state")).toBe("s-state");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("throws when env unset", () => {
    vi.stubEnv("SPOTIFY_CLIENT_ID", "");
    expect(() =>
      buildSpotifyAuthUrl({ state: "x", codeChallenge: "y" }),
    ).toThrow(/without env/);
  });
});

describe("exchangeSpotifyCode", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("POSTs Basic auth + PKCE body to Spotify's token endpoint", async () => {
    fetchMock.queueResponse({
      access_token: "sp-access",
      refresh_token: "sp-refresh",
      expires_in: 3600,
      scope: SPOTIFY_SCOPE,
      token_type: "Bearer",
    });

    const { token, scope } = await exchangeSpotifyCode("code-x", "verifier-y");

    expect(fetchMock.calls).toHaveLength(1);
    const call = fetchMock.calls[0]!;
    expect(call.url).toBe("https://accounts.spotify.com/api/token");
    expect(call.init.method).toBe("POST");
    // Basic auth header = base64(clientId:clientSecret).
    const expectedBasic = Buffer.from(
      `${SP_ENV.clientId}:${SP_ENV.clientSecret}`,
    ).toString("base64");
    expect(call.init.headers).toMatchObject({
      authorization: `Basic ${expectedBasic}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(call.init.body!);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-x");
    expect(body.get("code_verifier")).toBe("verifier-y");
    expect(body.get("redirect_uri")).toBe(SP_ENV.redirectUri);

    expect(token.access).toBe("sp-access");
    expect(token.refresh).toBe("sp-refresh");
    expect(token.expiresAt).toBeTruthy();
    expect(scope).toBe(SPOTIFY_SCOPE);
  });

  it("tolerates a response without refresh_token (Spotify issues it once)", async () => {
    fetchMock.queueResponse({
      access_token: "a",
      expires_in: 3600,
      scope: SPOTIFY_SCOPE,
    });
    const { token } = await exchangeSpotifyCode("c", "v");
    expect(token.refresh).toBeUndefined();
  });

  it("throws on a non-2xx", async () => {
    fetchMock.queueResponse({ error: "invalid_grant" }, { status: 400 });
    await expect(exchangeSpotifyCode("c", "v")).rejects.toThrow(
      /token exchange failed \(400\)/,
    );
  });

  it("throws when access_token missing", async () => {
    fetchMock.queueResponse({ refresh_token: "r" });
    await expect(exchangeSpotifyCode("c", "v")).rejects.toThrow(
      /missing access_token/,
    );
  });
});

describe("listSpotifyPlaylists", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("sends the bearer + limit=50 to /v1/me/playlists", async () => {
    fetchMock.queueResponse({ items: [] });
    await listSpotifyPlaylists("tok");
    expect(fetchMock.calls).toHaveLength(1);
    const url = new URL(fetchMock.calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://api.spotify.com/v1/me/playlists",
    );
    expect(url.searchParams.get("limit")).toBe("50");
    expect(fetchMock.calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer tok",
    });
  });

  it("pages via the `next` URL Spotify returns", async () => {
    fetchMock.queueResponse({
      items: [
        {
          id: "pl1",
          name: "Favourites",
          images: [{ url: "https://img/0.png" }],
          tracks: { total: 37 },
          owner: { display_name: "Me" },
        },
      ],
      next: "https://api.spotify.com/v1/me/playlists?offset=50&limit=50",
    });
    fetchMock.queueResponse({ items: [{ id: "pl2", name: "More" }] });
    const out = await listSpotifyPlaylists("t");
    expect(out).toEqual([
      {
        id: "pl1",
        name: "Favourites",
        tracksTotal: 37,
        thumbnail: "https://img/0.png",
        owner: "Me",
      },
      {
        id: "pl2",
        name: "More",
        tracksTotal: undefined,
        thumbnail: undefined,
        owner: undefined,
      },
    ]);
    // Second request followed Spotify's `next` URL verbatim.
    expect(fetchMock.calls[1]!.url).toBe(
      "https://api.spotify.com/v1/me/playlists?offset=50&limit=50",
    );
  });

  it("throws on a non-2xx", async () => {
    fetchMock.queueResponse({ error: { message: "bad" } }, { status: 401 });
    await expect(listSpotifyPlaylists("bad")).rejects.toThrow(
      /playlists fetch failed \(401\)/,
    );
  });
});

describe("getSpotifyPlaylistTracks", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("lifts title + artists join + ISRC + sourceId from each track", async () => {
    fetchMock.queueResponse({
      items: [
        {
          track: {
            id: "tr1",
            name: "Get Lucky",
            external_ids: { isrc: "USUM71703991" },
            artists: [{ name: "Daft Punk" }, { name: "Pharrell Williams" }],
            type: "track",
          },
        },
        {
          track: {
            id: "tr2",
            name: "Solo",
            external_ids: { isrc: "FR1234" },
            artists: [{ name: "Clean Bandit" }],
            type: "track",
          },
        },
      ],
    });
    const out = await getSpotifyPlaylistTracks("t", "PLxyz");
    expect(out).toEqual([
      {
        title: "Get Lucky",
        artist: "Daft Punk, Pharrell Williams",
        isrc: "USUM71703991",
        sourceId: "tr1",
      },
      {
        title: "Solo",
        artist: "Clean Bandit",
        isrc: "FR1234",
        sourceId: "tr2",
      },
    ]);
    const url = new URL(fetchMock.calls[0]!.url);
    expect(url.pathname).toBe("/v1/playlists/PLxyz/tracks");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("skips null tracks (Spotify returns null for removed tracks) + episodes (podcasts)", async () => {
    fetchMock.queueResponse({
      items: [
        null,
        {
          track: {
            id: "ep",
            name: "Podcast ep",
            type: "episode",
            artists: [],
            external_ids: {},
          },
        },
        { track: { id: "tr", name: "Real", type: "track", artists: [] } },
      ],
    });
    const out = await getSpotifyPlaylistTracks("t", "PL");
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Real");
    // ISRC undefined for the surviving track (no external_ids).
    expect(out[0]!.isrc).toBeUndefined();
  });

  it("URL-encodes the playlistId safely", async () => {
    fetchMock.queueResponse({ items: [] });
    await getSpotifyPlaylistTracks("t", "PL with spaces");
    const url = new URL(fetchMock.calls[0]!.url);
    expect(url.pathname).toBe("/v1/playlists/PL%20with%20spaces/tracks");
  });

  it("throws on a non-2xx", async () => {
    fetchMock.queueResponse({}, { status: 429 });
    await expect(getSpotifyPlaylistTracks("t", "PL")).rejects.toThrow(
      /playlist tracks fetch failed \(429\)/,
    );
  });
});
