"use client";

/**
 * Task 14 — SP-0 SC3 architecture proof surface.
 *
 * Minimal on purpose: this is NOT a product UI, it's the thinnest page that
 * exercises all four seams end-to-end — play a track (PlayerProvider), log the
 * play (TrackStore via /api/music/plays), log skip/complete (TrackStore via
 * /api/music/signals), and build the discovery shelf (engine.buildShelf through
 * TrackStore + CandidateSource + LlmProvider + the narrow TagStore adapter, via
 * /api/music/shelf).
 *
 * Flow:
 *   1. on mount, GET /api/music/shelf → render the slate (empty until a seed
 *      play exists, so the very first load shows an empty-state + a hint).
 *   2. clicking a row calls usePlayer().load(track) — the YouTube IFrame
 *      provider resolves track.sources.youtube and starts playback.
 *   3. the player's onTrackStart (wired in app/providers.tsx) POSTs the play.
 *   4. Play/Pause/Next drive the shared player; Skip/Complete POST a signal
 *      directly (manual UAT probes — the player ALSO auto-emits these on
 *      abandon-within-30s / natural ENDED, so both paths are covered).
 *   5. "Refresh shelf" re-fetches after a play so the UAT can watch the slate
 *      change as history grows.
 */
import { useCallback, useEffect, useState } from "react";
import type { MusicTrack } from "@music-ai/engine";
import { usePlayer } from "@/lib/providers/player-youtube";

export default function Home() {
  const player = usePlayer();
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const refreshShelf = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/music/shelf");
      const data = (await res.json()) as { tracks?: MusicTrack[]; error?: string };
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
  // for this minimal proof we subscribe and mirror it into local state so the
  // Now-Playing section and the Skip/Complete buttons have a stable reference.
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
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            SP-0 SC3 Proof
          </h1>
          <p className="text-sm opacity-70">
            Four seams: TrackStore · CandidateSource · LlmProvider · PlayerProvider
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
              Skip/Complete POST to /api/music/signals. The player also auto-fires
              skip on abandon-within-30s and complete on natural ENDED.
            </p>
          </div>
        ) : (
          <p className="text-sm opacity-60">Nothing loaded — pick a track below.</p>
        )}
      </section>

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
            Empty shelf. With no history yet, buildShelf returns []. Play a track
            (or seed one in the DB) then hit Refresh shelf.
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
                    <span className="block truncate font-medium">{track.title}</span>
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
    </main>
  );
}
