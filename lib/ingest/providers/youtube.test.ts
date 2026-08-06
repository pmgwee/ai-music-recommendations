/**
 * YouTube (Google) provider adapter tests.
 *
 * Mocks global `fetch` to assert:
 *   - `buildYoutubeAuthUrl` produces the correct Google OAuth URL shape.
 *   - `exchangeYoutubeCode` POSTs to the right endpoint with the right body +
 *     parses the token response.
 *   - `listYoutubePlaylists` GETs with the bearer + pages.
 *   - `getYoutubePlaylistTracks` pages + splits title/artist.
 *   - The "not_configured" gating when env unset (`isYoutubeConfigured`).
 *
 * Same fetch-mock pattern as `lib/providers/llm-byok.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildYoutubeAuthUrl,
  deriveCodeChallenge,
  exchangeYoutubeCode,
  generateCodeVerifier,
  getYoutubePlaylistTracks,
  isYoutubeConfigured,
  listYoutubePlaylists,
  YOUTUBE_SCOPE,
} from "./youtube";

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------
type FetchCall = {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
};

function makeResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  const status = init?.status ?? 200;
  // Derive ok from status when not explicitly passed: a 4xx/5xx is not ok.
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

// YouTube env for the configured-case tests. Stubbed per-test via
// vi.stubEnv so the gating tests can flip them off cleanly.
const YT_ENV = {
  clientId: "yt-client-id-123.apps.googleusercontent.com",
  clientSecret: "yt-secret-abc",
  redirectUri: "http://localhost:3000/api/ingest/youtube/callback",
};

beforeEach(() => {
  vi.stubEnv("YOUTUBE_CLIENT_ID", YT_ENV.clientId);
  vi.stubEnv("YOUTUBE_CLIENT_SECRET", YT_ENV.clientSecret);
  vi.stubEnv("YOUTUBE_REDIRECT_URI", YT_ENV.redirectUri);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isYoutubeConfigured", () => {
  it("true when all three env vars are set", () => {
    expect(isYoutubeConfigured()).toBe(true);
  });

  it("false when client id is missing", () => {
    vi.stubEnv("YOUTUBE_CLIENT_ID", "");
    expect(isYoutubeConfigured()).toBe(false);
  });

  it("false when client secret is missing", () => {
    vi.stubEnv("YOUTUBE_CLIENT_SECRET", "");
    expect(isYoutubeConfigured()).toBe(false);
  });

  it("false when redirect uri is missing", () => {
    vi.stubEnv("YOUTUBE_REDIRECT_URI", "");
    expect(isYoutubeConfigured()).toBe(false);
  });
});

describe("PKCE helpers", () => {
  it("generateCodeVerifier yields a 96-char base64url string (no padding)", () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(96);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v).not.toContain("=");
  });

  it("generateCodeVerifier is non-deterministic (fresh per call)", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it("deriveCodeChallenge is deterministic for a fixed verifier", async () => {
    const v = "fixed-verifier-for-test-1234567890123456789012345678901234567890123456";
    const c1 = await deriveCodeChallenge(v);
    const c2 = await deriveCodeChallenge(v);
    expect(c1).toBe(c2);
    // S256 challenge for a 78-char verifier has a known SHA-256; just assert
    // it's 43 chars (base64url of 32 bytes, no padding).
    expect(c1).toHaveLength(43);
  });

  it("deriveCodeChallenge differs across verifiers", async () => {
    const a = await deriveCodeChallenge("a".repeat(80));
    const b = await deriveCodeChallenge("b".repeat(80));
    expect(a).not.toBe(b);
  });
});

describe("buildYoutubeAuthUrl", () => {
  it("contains all required Google OAuth params + PKCE + the youtube.readonly scope", () => {
    const url = buildYoutubeAuthUrl({
      state: "state-abc",
      codeVerifier: "v".repeat(80),
      codeChallenge: "c".repeat(43),
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = parsed.searchParams;
    expect(params.get("client_id")).toBe(YT_ENV.clientId);
    expect(params.get("redirect_uri")).toBe(YT_ENV.redirectUri);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe(YOUTUBE_SCOPE);
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("state")).toBe("state-abc");
    expect(params.get("code_challenge")).toBe("c".repeat(43));
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  it("throws when env unset (caller must gate)", () => {
    vi.stubEnv("YOUTUBE_CLIENT_ID", "");
    expect(() =>
      buildYoutubeAuthUrl({
        state: "x",
        codeVerifier: "y",
        codeChallenge: "z",
      }),
    ).toThrow(/without env/);
  });
});

describe("exchangeYoutubeCode", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("POSTs the PKCE exchange body to Google's token endpoint + parses the envelope", async () => {
    fetchMock.queueResponse({
      access_token: "ya29.token",
      refresh_token: "1//refresh",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
      token_type: "Bearer",
    });

    const { token, scope } = await exchangeYoutubeCode("the-code", "the-verifier");

    // Assert the request shape.
    expect(fetchMock.calls).toHaveLength(1);
    const call = fetchMock.calls[0]!;
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    // Body must contain the PKCE verifier, code, redirect_uri, client creds.
    const body = new URLSearchParams(call.init.body!);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("redirect_uri")).toBe(YT_ENV.redirectUri);
    expect(body.get("client_id")).toBe(YT_ENV.clientId);
    expect(body.get("client_secret")).toBe(YT_ENV.clientSecret);

    // Assert the parsed envelope.
    expect(token.access).toBe("ya29.token");
    expect(token.refresh).toBe("1//refresh");
    expect(token.expiresAt).toBeTruthy();
    // expiresAt is ISO + ~1h from now.
    const ttl = Date.parse(token.expiresAt!) - Date.now();
    expect(ttl).toBeGreaterThan(3_500_000);
    expect(ttl).toBeLessThan(3_700_000);
    expect(scope).toBe(YOUTUBE_SCOPE);
  });

  it("omits refresh + expiresAt when the response has neither", async () => {
    fetchMock.queueResponse({ access_token: "just-access", scope: YOUTUBE_SCOPE });
    const { token } = await exchangeYoutubeCode("c", "v");
    expect(token.refresh).toBeUndefined();
    expect(token.expiresAt).toBeUndefined();
  });

  it("throws when the response is non-2xx (with status + body)", async () => {
    fetchMock.queueResponse({ error: "invalid_grant" }, { status: 400 });
    await expect(exchangeYoutubeCode("c", "v")).rejects.toThrow(
      /token exchange failed \(400\)/,
    );
  });

  it("throws when the response is missing access_token", async () => {
    fetchMock.queueResponse({ refresh_token: "x" });
    await expect(exchangeYoutubeCode("c", "v")).rejects.toThrow(
      /missing access_token/,
    );
  });
});

describe("listYoutubePlaylists", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("sends the bearer + part + mine=true + maxResults=50", async () => {
    fetchMock.queueResponse({ items: [] });
    await listYoutubePlaylists("ya29.tok");
    expect(fetchMock.calls).toHaveLength(1);
    const call = fetchMock.calls[0]!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/youtube/v3/playlists",
    );
    expect(call.init.headers).toMatchObject({ authorization: "Bearer ya29.tok" });
    expect(url.searchParams.get("part")).toBe("snippet,contentDetails");
    expect(url.searchParams.get("mine")).toBe("true");
    expect(url.searchParams.get("maxResults")).toBe("50");
  });

  it("pages through nextPageToken until none", async () => {
    fetchMock.queueResponse({
      items: [
        { id: "p1", snippet: { title: "One" }, contentDetails: { itemCount: 5 } },
      ],
      nextPageToken: "PAGE2",
    });
    fetchMock.queueResponse({
      items: [{ id: "p2", snippet: { title: "Two" } }],
    });
    const out = await listYoutubePlaylists("t");
    expect(out).toEqual([
      { id: "p1", title: "One", itemCount: 5, thumbnail: undefined },
      { id: "p2", title: "Two", itemCount: undefined, thumbnail: undefined },
    ]);
    // Second call used the pageToken.
    const second = new URL(fetchMock.calls[1]!.url);
    expect(second.searchParams.get("pageToken")).toBe("PAGE2");
  });

  it("throws on a non-2xx", async () => {
    fetchMock.queueResponse({ error: "unauthorized" }, { status: 401 });
    await expect(listYoutubePlaylists("bad")).rejects.toThrow(
      /playlists fetch failed \(401\)/,
    );
  });
});

describe("getYoutubePlaylistTracks", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it("pages + splits 'Artist - Title' + uses videoId as sourceId", async () => {
    fetchMock.queueResponse({
      items: [
        {
          snippet: {
            title: "Daft Punk - Get Lucky",
            videoOwnerChannelTitle: "Daft Punk",
            resourceId: { videoId: "video-1" },
          },
          contentDetails: { videoId: "video-1" },
        },
        {
          snippet: { title: "Standalone Title" },
          contentDetails: { videoId: "video-2" },
        },
      ],
    });
    const out = await getYoutubePlaylistTracks("t", "PL123");
    expect(out).toEqual([
      { title: "Get Lucky", artist: "Daft Punk", sourceId: "video-1" },
      { title: "Standalone Title", artist: "", sourceId: "video-2" },
    ]);
    // URL hit playlistItems with the playlistId.
    const url = new URL(fetchMock.calls[0]!.url);
    expect(url.pathname).toBe("/youtube/v3/playlistItems");
    expect(url.searchParams.get("playlistId")).toBe("PL123");
    expect(url.searchParams.get("maxResults")).toBe("50");
  });

  it("skips items with no resolvable videoId", async () => {
    fetchMock.queueResponse({
      items: [
        { snippet: { title: "x" } }, // no videoId anywhere
        { snippet: { title: "ok" }, contentDetails: { videoId: "v" } },
      ],
    });
    const out = await getYoutubePlaylistTracks("t", "PL");
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceId).toBe("v");
  });

  it("throws on a non-2xx", async () => {
    fetchMock.queueResponse({}, { status: 403 });
    await expect(getYoutubePlaylistTracks("t", "PL")).rejects.toThrow(
      /playlistItems fetch failed \(403\)/,
    );
  });
});
