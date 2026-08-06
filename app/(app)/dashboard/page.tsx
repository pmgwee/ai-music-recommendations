"use client";

/**
 * SP-1 dashboard — the authed home of the music app.
 *
 * Graduated from the SP-0 proof page (`app/page.tsx` at commit 342d341): the
 * wiring is unchanged (fetch `/api/music/shelf`, render the discovery shelf +
 * now-playing + transport + Skip/Complete probes), but it now lives behind the
 * `(app)` shell so:
 *   - the middleware guarantees a session before the page ever mounts (no 401
 *     on the shelf fetch for signed-in users);
 *   - the `<YoutubePlayerProvider>` mounted at `app/(app)/layout.tsx` is the
 *     one and only player instance — `usePlayer()` here resolves to it;
 *   - the public root (`/`) is a redirect, so this surface is reached only
 *     through the authed shell.
 *
 * The shelf auto-loads on mount; Refresh re-fetches after a play so UAT can
 * watch the slate change as history grows. Skip/Complete here are manual UAT
 * probes — the player ALSO auto-emits skip on abandon-within-30s and complete
 * on natural ENDED (wired in `app/(app)/providers.tsx`), so both paths are
 * covered.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { MusicTrack } from "@music-ai/engine";
import type { TasteProfile } from "@/lib/taste/profile";
import { usePlayer } from "@/lib/providers/player-youtube";

export default function DashboardPage() {
  const player = usePlayer();
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const refreshShelf = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/music/shelf");
      const data = (await res.json()) as {
        tracks?: MusicTrack[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `shelf ${res.status}`);
        setTracks([]);
        return;
      }
      setTracks(data.tracks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
      setTracks([]);
    }
  }, []);

  useEffect(() => {
    void refreshShelf();
  }, [refreshShelf]);

  const playTrack = useCallback(
    (track: MusicTrack) => {
      void player.load(track);
    },
    [player],
  );

  // The player handle exposes the current track via its `state$` Observable;
  // subscribe and mirror it into local state so the Now-Playing section and
  // the Skip/Complete buttons have a stable reference.
  const [current, setCurrent] = useState<MusicTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  useEffect(() => {
    const unsub = player.state$.subscribe((s) => {
      setCurrent(s.current);
      setIsPlaying(s.isPlaying);
    });
    return unsub;
  }, [player]);

  const sendSignal = useCallback(
    async (signal: "skip" | "complete") => {
      if (!current) return;
      setPosting(true);
      try {
        await fetch("/api/music/signals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackId: current.trackId, signal }),
        });
      } catch {
        /* best-effort */
      } finally {
        setPosting(false);
      }
    },
    [current],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm opacity-70">
            Discovery shelf, now playing, transport + skip/complete signals.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshShelf()}
          className="rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
        >
          Refresh shelf
        </button>
      </header>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
          Now playing
        </h2>
        {current ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="font-medium">{current.title}</div>
              <div className="text-sm opacity-70">{current.artist}</div>
              <div className="mt-1 font-mono text-xs opacity-50">
                {current.trackId}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => player.toggle()}
                className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
              >
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                onClick={() => void player.next()}
                className="rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
              >
                Next
              </button>
              <button
                type="button"
                disabled={posting}
                onClick={() => void sendSignal("skip")}
                className="rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10"
              >
                Skip (signal)
              </button>
              <button
                type="button"
                disabled={posting}
                onClick={() => void sendSignal("complete")}
                className="rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10"
              >
                Complete (signal)
              </button>
            </div>
            <p className="text-xs opacity-60">
              Skip/Complete POST to /api/music/signals. The player also
              auto-fires skip on abandon-within-30s and complete on natural
              ENDED.
            </p>
          </div>
        ) : (
          <p className="text-sm opacity-60">Nothing loaded — pick a track below.</p>
        )}
      </section>

      <TasteSummaryCard />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
          Discovery shelf
        </h2>
        {error ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {error}
          </p>
        ) : tracks === null ? (
          <p className="text-sm opacity-60">Loading…</p>
        ) : tracks.length === 0 ? (
          <p className="text-sm opacity-60">
            Empty shelf. With no history yet, buildShelf returns []. Play a
            track (or seed one in the DB) then hit Refresh shelf.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-black/5 dark:divide-white/10">
            {tracks.map((track) => (
              <li key={track.trackId}>
                <button
                  type="button"
                  onClick={() => playTrack(track)}
                  className="flex w-full items-center gap-3 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/5"
                >
                  {track.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={track.thumbnail}
                      alt=""
                      width={48}
                      height={48}
                      className="h-12 w-12 flex-none rounded"
                    />
                  ) : (
                    <div className="h-12 w-12 flex-none rounded bg-black/10 dark:bg-white/10" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {track.title}
                    </span>
                    <span className="block truncate text-sm opacity-70">
                      {track.artist}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Compact taste summary — top-3 artists + top-3 tags, links to /taste for the
 * full surface. Best-effort: on any error or empty profile it renders nothing
 * (the dashboard's job is the shelf, not taste). Kept inline since it shares
 * the page's fetch/error idiom; a separate file would just re-import the same
 * TasteProfile type.
 */
function TasteSummaryCard() {
  const [profile, setProfile] = useState<TasteProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/taste");
        if (!res.ok) return;
        const data = (await res.json()) as TasteProfile;
        if (!cancelled) setProfile(data);
      } catch {
        /* best-effort — silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to show yet (loading, error, or no history) — don't take the space.
  if (
    !profile ||
    (profile.topArtists.length === 0 && profile.topTags.length === 0)
  ) {
    return null;
  }

  return (
    <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
          Your taste
        </h2>
        <Link
          href="/taste"
          className="text-xs opacity-60 hover:opacity-100"
        >
          See more →
        </Link>
      </div>
      <div className="flex flex-col gap-3 text-sm">
        {profile.topArtists.length > 0 && (
          <div>
            <div className="mb-1 text-xs opacity-60">Top artists</div>
            <div className="flex flex-wrap gap-1.5">
              {profile.topArtists.slice(0, 3).map((a) => (
                <span
                  key={a.artist}
                  className="rounded-full border border-black/10 bg-foreground/5 px-2.5 py-0.5 text-xs dark:border-white/15"
                >
                  {a.artist}
                </span>
              ))}
            </div>
          </div>
        )}
        {profile.topTags.length > 0 && (
          <div>
            <div className="mb-1 text-xs opacity-60">Top tags</div>
            <div className="flex flex-wrap gap-1.5">
              {profile.topTags.slice(0, 3).map((t) => (
                <span
                  key={t.tag}
                  className="rounded-full border border-black/10 bg-foreground/5 px-2.5 py-0.5 text-xs dark:border-white/15"
                >
                  {t.tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
