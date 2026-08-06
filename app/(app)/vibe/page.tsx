"use client";

/**
 * SP-5 Task 3 — Vibe surface (one-prompt playlists).
 *
 * A prompt input + Generate button → POST /api/vibe { prompt } → a rendered
 * playlist. The route does the heavy lifting (BYOK LLM intent capture →
 * anonymous YouTube seed grounding → ranked radio); this page is the thin
 * client that shapes the response for a human:
 *   - the parsed intent as chips ("understood: chill · indie · rainy-day") so
 *     the user can see what the model made of their ask before they listen;
 *   - a one-line "seeded from" / "synthesized" attribution (the `via` + the
 *     resolved seed name) so the grounding is never invisible;
 *   - a friendly message for each of the three clean-degrade error codes
 *     (`vibe_needs_llm` → Settings link, `could_not_parse`, `could_not_ground`)
 *     rather than a raw error string;
 *   - example prompt chips so a first-time visitor has a zero-typing path in.
 *
 * Playback goes through the same `usePlayer()` the dashboard uses — the
 * `(app)` layout mounts the single shared `<YoutubePlayerProvider>`, so a track
 * loaded here keeps playing across nav. The task's contract is `load(track)`
 * (replace queue with this one track and play it); the player's
 * `onExtendQueue`/autoplay is intentionally not wired here, matching the
 * dashboard's per-row play idiom.
 *
 * Auth: the `(app)` layout's defense-in-depth `getUser()` redirect (same gate
 * the `/taste` surface relies on) keeps this behind a session; the `/api/vibe`
 * route is separately session-gated (`requireUser`) so a stale render can never
 * reach the engine.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { MusicTrack, VibeConstraints } from "@music-ai/engine";
import { usePlayer } from "@/lib/providers/player-youtube";

// ---------------------------------------------------------------------------
// Types — the response shape from POST /api/vibe (see app/api/vibe/route.ts).
// The three degrade codes are 200s with `tracks: []`; non-200s carry their own
// codes (rate_limited / invalid_json / empty_prompt / vibe_build_failed) which
// we collapse onto a generic "other" friendly message.
// ---------------------------------------------------------------------------

type VibeVia = "named" | "synthesized";

type VibeErrorCode =
  | "vibe_needs_llm"
  | "could_not_parse"
  | "could_not_ground"
  | "rate_limited"
  | "other";

interface VibeSuccess {
  tracks: MusicTrack[];
  constraints: VibeConstraints;
  via: VibeVia;
}

type VibeState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; code: VibeErrorCode }
  | ({ state: "ready" } & VibeSuccess);

// Friendly copy for each degrade path. The three the spec names are verbatim;
// rate_limited + other are the catch-alls for non-200 bodies (the route's own
// 429/500 contracts and any network blip).
const ERROR_COPY: Record<VibeErrorCode, string> = {
  vibe_needs_llm: "Add an LLM API key in Settings to use Vibe.",
  could_not_parse: "Couldn't parse that — try rephrasing.",
  could_not_ground:
    "Couldn't find a seed for that — try naming an artist or a genre.",
  rate_limited: "Too many requests — wait a minute and try again.",
  other: "Something went wrong generating that. Try again.",
};

const EXAMPLES = [
  "chill Sunday morning",
  "hype workout",
  "songs like Radiohead but warmer",
  "dreamy late-night indie",
  "feel-good 80s pop",
];

/** Map the route's error code string onto the UI's VibeErrorCode union. */
function classifyError(code: unknown): VibeErrorCode {
  if (code === "vibe_needs_llm") return "vibe_needs_llm";
  if (code === "could_not_parse") return "could_not_parse";
  if (code === "could_not_ground") return "could_not_ground";
  if (code === "rate_limited") return "rate_limited";
  return "other";
}

export default function VibePage() {
  const player = usePlayer();
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<VibeState>({ state: "idle" });

  // Mirror the player's current track into local state so the row that's
  // playing shows a Playing label + the transport reflects what's live. Same
  // subscription idiom as the dashboard.
  const [current, setCurrent] = useState<MusicTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  useEffect(() => {
    const unsub = player.state$.subscribe((s) => {
      setCurrent(s.current);
      setIsPlaying(s.isPlaying);
    });
    return unsub;
  }, [player]);

  const generate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setResult({ state: "loading" });
    try {
      const res = await fetch("/api/vibe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmed }),
      });
      const data = (await res.json()) as Partial<VibeSuccess> & {
        error?: string;
      };
      // Every branch the route emits carries either a non-empty `tracks` +
      // `constraints` + `via` (success) or an `error` code (degrade). An empty
      // `tracks` with no error is treated as "other" defensively.
      if (data.error) {
        setResult({ state: "error", code: classifyError(data.error) });
        return;
      }
      if (
        Array.isArray(data.tracks) &&
        data.constraints &&
        (data.via === "named" || data.via === "synthesized")
      ) {
        setResult({
          state: "ready",
          tracks: data.tracks,
          constraints: data.constraints,
          via: data.via,
        });
        return;
      }
      setResult({ state: "error", code: "other" });
    } catch {
      // Network blip / abort — never a throw at the surface.
      setResult({ state: "error", code: "other" });
    }
  }, [prompt]);

  const playTrack = useCallback(
    (track: MusicTrack) => {
      void player.load(track);
    },
    [player],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Vibe</h1>
        <p className="text-sm opacity-70">
          Describe a feeling, a moment, or a sound. We turn it into a playlist.
        </p>
      </header>

      <PromptField
        prompt={prompt}
        onChange={setPrompt}
        onSubmit={generate}
        loading={result.state === "loading"}
      />

      {result.state === "idle" && (
        <Examples
          onPick={(p) => {
            setPrompt(p);
          }}
        />
      )}

      {result.state === "loading" && (
        <p className="text-sm opacity-60">Generating your playlist…</p>
      )}

      {result.state === "error" && (
        <ErrorNotice code={result.code} />
      )}

      {result.state === "ready" && (
        <Playlist
          tracks={result.tracks}
          constraints={result.constraints}
          via={result.via}
          currentId={current?.trackId ?? null}
          isPlaying={isPlaying}
          onPlay={playTrack}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt input
// ---------------------------------------------------------------------------

function PromptField({
  prompt,
  onChange,
  onSubmit,
  loading,
}: {
  prompt: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  // Cmd/Ctrl+Enter submits (plain Enter is a newline in a textarea). The button
  // is the primary affordance; this is the keyboard power-user path.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!loading) onSubmit();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!loading) onSubmit();
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor="vibe-prompt" className="sr-only">
        Describe a vibe
      </label>
      <textarea
        id="vibe-prompt"
        value={prompt}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder="chill Sunday morning, songs like Radiohead but warmer, hype workout…"
        className="w-full resize-none rounded-lg border border-black/10 bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 dark:border-white/15"
        disabled={loading}
      />
      <button
        type="submit"
        disabled={loading || prompt.trim().length === 0}
        className="self-start rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Generating…" : "Generate"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Example prompt chips (idle state)
// ---------------------------------------------------------------------------

function Examples({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
        Try a vibe
      </h2>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onPick(ex)}
            className="rounded-full border border-black/10 bg-foreground/[0.03] px-3 py-1.5 text-sm transition-colors hover:bg-foreground/[0.07] dark:border-white/15 dark:hover:bg-white/10"
          >
            {ex}
          </button>
        ))}
      </div>
      <p className="text-xs opacity-50">
        Tap a chip to fill the prompt, then Generate. (Cmd/Ctrl+Enter also
        generates.)
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Error notice
// ---------------------------------------------------------------------------

function ErrorNotice({ code }: { code: VibeErrorCode }) {
  return (
    <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p>{ERROR_COPY[code]}</p>
      {code === "vibe_needs_llm" && (
        <p className="mt-1">
          <Link
            href="/settings"
            className="font-medium underline underline-offset-2 hover:opacity-80"
          >
            Go to Settings →
          </Link>
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Playlist result
// ---------------------------------------------------------------------------

function Playlist({
  tracks,
  constraints,
  via,
  currentId,
  isPlaying,
  onPlay,
}: {
  tracks: MusicTrack[];
  constraints: VibeConstraints;
  via: VibeVia;
  currentId: string | null;
  isPlaying: boolean;
  onPlay: (track: MusicTrack) => void;
}) {
  // Flatten the fixed-vocabulary tags for the "understood" chips. Order:
  // genres, moods, eras (the engine's own ordering inside VibeConstraints).
  const understood = [
    ...constraints.genres,
    ...constraints.moods,
    ...constraints.eras,
  ];

  // One-line grounding attribution. `named` → the LLM named a seed and the
  // resolver grounded it verbatim; `synthesized` → only tags were given (or the
  // named seed didn't ground) so the resolver built a query from the tags.
  const viaLine =
    via === "named"
      ? `Seeded from: ${constraints.seedNames[0] ?? "a named track"}`
      : "Synthesized from your tags";

  return (
    <section className="flex flex-col gap-3">
      {understood.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs uppercase tracking-wide opacity-60">
            understood:
          </span>
          {understood.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-black/10 bg-foreground/5 px-2.5 py-0.5 text-xs dark:border-white/15"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <p className="text-xs opacity-60">{viaLine}</p>

      {tracks.length === 0 ? (
        <p className="rounded-md border border-black/10 p-3 text-sm opacity-70 dark:border-white/15">
          No tracks matched this time — try rephrasing or naming a specific
          artist.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-black/5 dark:divide-white/10">
          {tracks.map((track) => {
            const isCurrent = track.trackId === currentId;
            const showPlaying = isCurrent && isPlaying;
            return (
              <li
                key={track.trackId}
                className="flex items-center gap-3 py-2"
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
                <button
                  type="button"
                  onClick={() => onPlay(track)}
                  aria-label={`Play ${track.title} by ${track.artist}`}
                  className="flex-none rounded-md border border-black/10 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                >
                  {showPlaying ? "Playing" : "Play"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
