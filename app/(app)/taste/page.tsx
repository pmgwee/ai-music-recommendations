"use client";

/**
 * SP-4 — "Your taste" surface.
 *
 * Fetches `/api/taste` (the engine's TrackStore aggregated into a profile) and
 * renders: top artists as horizontal bars (weighted by play+complete−skip), top
 * tags as chips, and listening stats (total plays, unique tracks, skip%,
 * complete%, likes). The page is a client component because it mounts a fetch
 * on load and mirrors loading/error state into the UI — the (app) layout
 * already guarantees a session, so the fetch is always authenticated.
 *
 * Empty state: when the listener has no history, we say so plainly — the same
 * "no data yet" message the dashboard shelf uses — rather than rendering empty
 * sections that look broken.
 */
import { useCallback, useEffect, useState } from "react";
import type { TasteProfile } from "@/lib/taste/profile";

type ProfileResult =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "empty" }
  | { state: "ready"; profile: TasteProfile };

export default function TastePage() {
  const [result, setResult] = useState<ProfileResult>({ state: "loading" });

  const load = useCallback(async () => {
    setResult({ state: "loading" });
    try {
      const res = await fetch("/api/taste");
      const data = (await res.json()) as Partial<TasteProfile> & {
        error?: string;
      };
      if (!res.ok) {
        setResult({
          state: "error",
          message: data.error ?? `taste ${res.status}`,
        });
        return;
      }
      const profile = data as TasteProfile;
      // Empty state: no history AND no likes — there's nothing to show.
      if (
        profile.stats.totalPlays === 0 &&
        profile.stats.likedCount === 0 &&
        profile.topArtists.length === 0
      ) {
        setResult({ state: "empty" });
        return;
      }
      setResult({ state: "ready", profile });
    } catch (e) {
      setResult({
        state: "error",
        message: e instanceof Error ? e.message : "network error",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Your taste</h1>
          <p className="text-sm opacity-70">
            What the engine has learned from your listening.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
        >
          Refresh
        </button>
      </header>

      {result.state === "loading" && (
        <p className="text-sm opacity-60">Loading…</p>
      )}

      {result.state === "error" && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {result.message}
        </p>
      )}

      {result.state === "empty" && (
        <section className="rounded-lg border border-black/10 p-6 text-center dark:border-white/15">
          <p className="text-sm opacity-70">
            Listen to a few tracks to build your taste profile.
          </p>
          <p className="mt-1 text-xs opacity-50">
            Top artists, tags, and listening stats appear here once you have
            some play history.
          </p>
        </section>
      )}

      {result.state === "ready" && <TasteSections profile={result.profile} />}
    </div>
  );
}

function TasteSections({ profile }: { profile: TasteProfile }) {
  const maxWeight = profile.topArtists[0]?.weight ?? 0;
  return (
    <>
      {/* Stats */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-70">
          Stats
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Total plays" value={String(profile.stats.totalPlays)} />
          <Stat
            label="Unique tracks"
            value={String(profile.stats.uniqueTracks)}
          />
          <Stat
            label="Liked"
            value={String(profile.stats.likedCount)}
          />
          <Stat
            label="Skip rate"
            value={`${Math.round(profile.stats.skipRate * 100)}%`}
          />
          <Stat
            label="Complete rate"
            value={`${Math.round(profile.stats.completeRate * 100)}%`}
          />
        </dl>
      </section>

      {/* Top artists */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-70">
          Top artists
        </h2>
        {profile.topArtists.length === 0 ? (
          <p className="text-sm opacity-60">
            No artists yet — your plays will populate this list.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {profile.topArtists.map((a) => {
              const pct =
                maxWeight > 0 ? Math.max(4, (a.weight / maxWeight) * 100) : 0;
              return (
                <li key={a.artist} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate font-medium">{a.artist}</span>
                    <span className="font-mono text-xs opacity-50">
                      {a.weight}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="h-full rounded-full bg-foreground/60"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Top tags */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-70">
          Top tags
        </h2>
        {profile.topTags.length === 0 ? (
          <p className="text-sm opacity-60">
            No tags yet — the LLM tags your tracks as you listen.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {profile.topTags.map((t) => (
              <li
                key={t.tag}
                className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-foreground/5 px-3 py-1 text-xs dark:border-white/15"
              >
                <span className="font-medium">{t.tag}</span>
                <span className="font-mono opacity-50">{t.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide opacity-60">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
