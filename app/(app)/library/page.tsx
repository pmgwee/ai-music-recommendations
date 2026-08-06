"use client";

/**
 * SP-3 Task 4 — Library / playlist-import surface.
 *
 * The final build piece of the ingestion feature. For each provider (YouTube,
 * Spotify) this page drives the three-state contract the SP-3 T1–T3 routes
 * expose:
 *   - `not_configured` (503 from /playlists) → the operator hasn't registered
 *     an OAuth client; surface "Not available yet" and disable connect.
 *   - `not_connected`  (401 from /playlists) → no token row for this user;
 *     surface the Connect button (a top-level `<a>` to /connect — it 302s out
 *     of the app to the provider's consent screen, so it must be a full nav,
 *     not a client fetch).
 *   - `connected`      (200 from /playlists) → render the playlist list with a
 *     per-row Import button (POST /api/ingest/import).
 *
 * The OAuth callback lands back here with `?connected=<provider>` (success) or
 * `?error=<slug>` (any failure path the callback handles — state_mismatch,
 * provider_denied, exchange_failed, stale_or_tampered). We surface both as a
 * one-line banner and auto-fetch the freshly-connected provider's playlists.
 *
 * Auth: the `(app)` layout's `getUser()` redirect gates the page (same defense
 * as /taste, /vibe); the `/api/ingest/*` routes are separately session-gated.
 *
 * `useSearchParams()` is wrapped in a Suspense boundary because Next.js
 * prerenders client components and bails the render on a missing boundary —
 * the outer default export is the Suspense wrapper.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

// ---------------------------------------------------------------------------
// Types — the response shapes from the SP-3 routes. Kept local (not imported
// from the route handlers) because route handler return types aren't part of
// the public API and we don't want a build-time coupling to them.
// ---------------------------------------------------------------------------

type ProviderName = "youtube" | "spotify";

/** A playlist row from GET /api/ingest/<provider>/playlists. */
interface ProviderPlaylist {
  id: string;
  name: string;
  itemCount?: number;
  thumbnail?: string;
}

/** Result of POST /api/ingest/import — see lib/ingest/import.ts `ImportResult`. */
interface ImportResult {
  ok: boolean;
  provider: ProviderName;
  resolved: number;
  skipped: number;
  sampled: boolean;
}

/** Per-provider UI state machine. */
type ProviderState =
  | { state: "loading" }
  | { state: "not_configured" }
  | { state: "not_connected" }
  | { state: "error"; message: string }
  | { state: "ready"; playlists: ProviderPlaylist[] };

/** Per-playlist import status (keyed by `${provider}:${playlistId}`). */
type ImportStatus =
  | { kind: "idle" }
  | { kind: "importing" }
  | { kind: "done"; summary: string }
  | { kind: "error"; message: string };

const PROVIDERS: ProviderName[] = ["youtube", "spotify"];

const PROVIDER_LABEL: Record<ProviderName, string> = {
  youtube: "YouTube",
  spotify: "Spotify",
};

// ---------------------------------------------------------------------------
// Suspense wrapper — see module doc. The fallback matches the page's loading
// copy so the prerender shell and the post-hydration shell don't fight.
// ---------------------------------------------------------------------------

export default function LibraryPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <Header />
          <p className="text-sm opacity-60">Loading…</p>
        </div>
      }
    >
      <LibraryPageInner />
    </Suspense>
  );
}

function LibraryPageInner() {
  const params = useSearchParams();
  const connectedParam = params.get("connected") as ProviderName | null;
  const errorParam = params.get("error");
  const errorProviderParam = params.get("provider") as ProviderName | null;

  const connectedProvider =
    connectedParam && (PROVIDERS as readonly string[]).includes(connectedParam)
      ? connectedParam
      : null;

  // ---------------------------------------------------------------------------
  // Banner: success after OAuth callback (`?connected=<provider>`) or failure
  // (`?error=<slug>`). Cleared by hand (the user may import several playlists;
  // a banner that auto-hides mid-flow is confusing).
  // ---------------------------------------------------------------------------
  const banner = connectedProvider
    ? {
        kind: "success" as const,
        message: `Connected ${PROVIDER_LABEL[connectedProvider]} — loading your playlists.`,
      }
    : errorParam
      ? { kind: "error" as const, message: errorMessage(errorParam) }
      : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Header />

      {banner && (
        <p
          className={
            "rounded-md border p-3 text-sm " +
            (banner.kind === "success"
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-amber-500/40 bg-amber-500/10")
          }
        >
          {banner.message}
        </p>
      )}

      <div className="flex flex-col gap-4">
        {PROVIDERS.map((provider) => (
          <ProviderCard
            key={provider}
            provider={provider}
            // Fresh-connect nudge: when the callback sets ?connected=, refetch
            // that provider so the playlists appear without a manual Refresh.
            freshConnect={connectedProvider === provider}
            // Surface a callback error scoped to this provider inline too, so
            // the failure attribution is unambiguous when both are connected.
            inlineError={
              errorParam && errorProviderParam === provider
                ? errorMessage(errorParam)
                : null
            }
          />
        ))}
      </div>

      <HowItWorks />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header + explanatory note
// ---------------------------------------------------------------------------

function Header() {
  return (
    <header>
      <h1 className="text-xl font-semibold tracking-tight">Library</h1>
      <p className="text-sm opacity-70">
        Import a playlist to seed your recommendations.
      </p>
    </header>
  );
}

function HowItWorks() {
  return (
    <section className="rounded-lg border border-black/10 p-4 text-sm opacity-80 dark:border-white/15">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
        How this works
      </h2>
      <p>
        Importing a playlist adds its tracks as taste (cold-start) — the
        recommender uses them to seed your discoveries, then fades them as it
        learns from what you actually play. Spotify tracks are matched to
        YouTube for playback by ISRC.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

function ProviderCard({
  provider,
  freshConnect,
  inlineError,
}: {
  provider: ProviderName;
  freshConnect: boolean;
  inlineError: string | null;
}) {
  const [status, setStatus] = useState<ProviderState>({ state: "loading" });
  // Track the latest fetch so a stale response (e.g. a Refresh right after
  // connect) doesn't overwrite the fresh one.
  const fetchSeq = useRef(0);

  const loadPlaylists = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setStatus({ state: "loading" });
    try {
      const res = await fetch(`/api/ingest/${provider}/playlists`);
      const data = (await res.json()) as Partial<{
        playlists: ProviderPlaylist[];
        error: string;
      }>;
      if (seq !== fetchSeq.current) return; // a newer fetch superseded us
      // 503 — operator hasn't configured the OAuth client. Rendered inert.
      if (res.status === 503 || data.error === "not_configured") {
        setStatus({ state: "not_configured" });
        return;
      }
      // 401 — no token row. Show the Connect button.
      if (res.status === 401 || data.error === "not_connected") {
        setStatus({ state: "not_connected" });
        return;
      }
      if (!res.ok) {
        setStatus({
          state: "error",
          message: friendlyProviderError(res.status, data.error),
        });
        return;
      }
      const playlists = Array.isArray(data.playlists) ? data.playlists : [];
      setStatus({ state: "ready", playlists });
    } catch {
      if (seq !== fetchSeq.current) return;
      setStatus({
        state: "error",
        message: "Couldn't reach the server. Try again.",
      });
    }
  }, [provider]);

  // Initial load + re-fetch when the callback signals a fresh connect for
  // this provider.
  useEffect(() => {
    void loadPlaylists();
  }, [loadPlaylists, freshConnect]);

  const label = PROVIDER_LABEL[provider];

  return (
    <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{label}</h2>
        {/* Connect is a top-level navigation: the route 302s out of the app to
            the provider's consent screen. It must NOT be a client fetch — the
            provider's domain can't render inside our shell. A plain anchor is
            the honest expression of "this leaves the SPA". */}
        {status.state !== "not_configured" && (
          <a
            href={`/api/ingest/${provider}/connect?next=/library`}
            className="rounded-md border border-black/10 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
          >
            {status.state === "not_connected" ? `Connect ${label}` : "Reconnect"}
          </a>
        )}
      </div>

      {inlineError && (
        <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          {inlineError}
        </p>
      )}

      {status.state === "loading" && (
        <p className="text-sm opacity-60">Loading…</p>
      )}

      {status.state === "not_configured" && (
        <p className="text-sm opacity-60">Not available yet.</p>
      )}

      {status.state === "not_connected" && (
        <p className="text-sm opacity-60">
          Connect {label} to import your playlists.
        </p>
      )}

      {status.state === "error" && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
          {status.message}
        </p>
      )}

      {status.state === "ready" && (
        <PlaylistsList
          provider={provider}
          playlists={status.playlists}
          onRefresh={() => void loadPlaylists()}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Playlists list + per-row import
// ---------------------------------------------------------------------------

function PlaylistsList({
  provider,
  playlists,
  onRefresh,
}: {
  provider: ProviderName;
  playlists: ProviderPlaylist[];
  onRefresh: () => void;
}) {
  const [imports, setImports] = useState<Record<string, ImportStatus>>({});

  const setImport = (key: string, next: ImportStatus) => {
    setImports((prev) => ({ ...prev, [key]: next }));
  };

  const doImport = async (playlist: ProviderPlaylist) => {
    const key = `${provider}:${playlist.id}`;
    setImport(key, { kind: "importing" });
    try {
      const res = await fetch("/api/ingest/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          playlistId: playlist.id,
          playlistName: playlist.name,
        }),
      });
      const data = (await res.json()) as Partial<ImportResult> & {
        error?: string;
      };
      if (!res.ok || typeof data.resolved !== "number") {
        setImport(key, {
          kind: "error",
          message: friendlyImportError(res.status, data.error),
        });
        return;
      }
      setImport(key, { kind: "done", summary: summarize(data as ImportResult) });
    } catch {
      setImport(key, {
        kind: "error",
        message: "Couldn't reach the server. Try again.",
      });
    }
  };

  if (playlists.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm opacity-60">
          No playlists found. Create one in {PROVIDER_LABEL[provider]} first.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="self-start rounded-md border border-black/10 px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-black/5 dark:divide-white/10">
        {playlists.map((pl) => {
          const key = `${provider}:${pl.id}`;
          const status = imports[key] ?? { kind: "idle" };
          return (
            <li key={pl.id} className="flex flex-col gap-2 py-2.5">
              <div className="flex items-center gap-3">
                {pl.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={pl.thumbnail}
                    alt=""
                    width={40}
                    height={40}
                    className="h-10 w-10 flex-none rounded bg-black/5 dark:bg-white/10"
                  />
                ) : (
                  <div className="h-10 w-10 flex-none rounded bg-black/5 dark:bg-white/10" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {pl.name}
                  </span>
                  <span className="block text-xs opacity-60">
                    {typeof pl.itemCount === "number"
                      ? `${pl.itemCount} track${pl.itemCount === 1 ? "" : "s"}`
                      : "—"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void doImport(pl)}
                  disabled={status.kind === "importing"}
                  aria-label={`Import ${pl.name}`}
                  className="flex-none rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {status.kind === "importing" ? "Importing…" : "Import"}
                </button>
              </div>
              {status.kind === "done" && (
                <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs">
                  {status.summary}
                </p>
              )}
              {status.kind === "error" && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                  {status.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onRefresh}
        className="self-start rounded-md border border-black/10 px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
      >
        Refresh
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/** Build the import success summary line. Mirrors the spec's wording:
 *  "Imported N tracks (M unmatched, sampled from larger list)". The trailing
 *  sampled clause only appears when the input exceeded the budget. */
function summarize(result: ImportResult): string {
  const tracks = `${result.resolved} track${result.resolved === 1 ? "" : "s"}`;
  const unmatched =
    result.skipped > 0 ? ` (${result.skipped} unmatched)` : "";
  const sampled = result.sampled ? ", sampled from a larger list" : "";
  return `Imported ${tracks}${unmatched}${sampled}.`;
}

/** Map the OAuth-callback error slug onto a friendly message. The slugs come
 *  from /api/ingest/[provider]/callback (state_mismatch, provider_denied,
 *  exchange_failed, stale_or_tampered). Unknown slugs degrade generically. */
function errorMessage(slug: string): string {
  switch (slug) {
    case "provider_denied":
      return "Connection was cancelled or denied.";
    case "state_mismatch":
      return "Security check failed — try connecting again.";
    case "stale_or_tampered":
      return "The connect session expired — try again.";
    case "exchange_failed":
      return "Couldn't complete the sign-in — try again.";
    default:
      return "Something went wrong connecting. Try again.";
  }
}

/** Friendly copy for a non-ok /playlists response. 429 is the rate-limit the
 *  route enforces; 502 is an upstream provider fetch failure. */
function friendlyProviderError(status: number, error?: string): string {
  if (status === 429) return "Too many requests — wait a minute and try again.";
  if (status === 502 || error === "provider_fetch_failed") {
    return "Couldn't reach the provider right now. Try again.";
  }
  return "Couldn't load playlists. Try again.";
}

/** Friendly copy for a non-ok /import response. */
function friendlyImportError(status: number, error?: string): string {
  if (status === 429) return "Too many imports — wait a minute and try again.";
  if (status === 502 || error === "provider_fetch_failed") {
    return "Couldn't read that playlist. Try again.";
  }
  if (status === 500 || error === "import_failed") {
    return "Import failed. Try again.";
  }
  return "Couldn't import that playlist. Try again.";
}
