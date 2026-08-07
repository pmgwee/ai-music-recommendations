import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Public landing page — the honest positioning for AI True Music.
 *
 * OUTSIDE the `(app)` route group, so the player provider, the app shell, and
 * the auth gate are NOT mounted here (no audio iframe, no shelf fetch that
 * would 401 on an unsigned visitor). The middleware passes `/` through for
 * unauthenticated users (it only gates the protected prefixes), so this page
 * renders to everyone.
 *
 * The pitch is deliberately truthful — we do NOT claim "world's first AI music
 * player" (unsubstantiable). What we actually are: a transparent, learning
 * recommender where you own your taste data AND your LLM key; multi-source
 * (YouTube today, Spotify coming); bring-your-own-key for the LLM cold-start.
 *
 * Server component. The only dynamic bit is the signed-in check: if you're
 * already authed and land on `/`, the hero shows a "Go to dashboard" link
 * instead of the sign-up / sign-in pair (a one-call `getUser()` on the
 * cookie-bound server client — cheap, and the middleware already refreshed
 * the session).
 */
export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-10 sm:px-6">
      {/* Brand row */}
      <div className="flex items-center gap-2.5">
        <div className="grid size-8 place-items-center rounded-lg bg-foreground/10 ring-1 ring-foreground/20">
          <MusicMark className="size-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">
          AI True Music
        </span>
      </div>

      {/* Hero */}
      <section className="mt-16 flex flex-col gap-6 sm:mt-24">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          A transparent music recommender where{" "}
          <span className="underline decoration-foreground/30 decoration-2 underline-offset-4">
            you own your taste data
          </span>{" "}
          — and your LLM key.
        </h1>

        <p className="max-w-2xl text-base leading-relaxed opacity-75 sm:text-lg">
          A learning discovery engine, not a black box. Bring your YouTube and
          Spotify playlists, watch the ranking improve as you listen, and keep
          control of both your listening history and the model key that drives
          the cold-start. Multi-source, bring-your-own-key, and the logic is
          auditable end to end.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          {user ? (
            <Link
              href="/dashboard"
              className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90"
            >
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/signup"
                className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90"
              >
                Sign up free
              </Link>
              <Link
                href="/login"
                className="rounded-md border border-black/15 px-5 py-2.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
              >
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>

      {/* How it works */}
      <section className="mt-20 grid gap-6 sm:mt-28 sm:grid-cols-3">
        <HowItWorks
          step="1"
          title="Connect your playlists"
          body="Bring your YouTube Liked Music (today) and Spotify library (coming). Your history seeds the taste graph — nothing is sent anywhere without you playing it."
        />
        <HowItWorks
          step="2"
          title="It learns your taste"
          body="A two-stage ranking engine: co-occurrence similarity between tracks you play, plus behavioural signals (skip, complete, like). Transparent scoring, not a mystery algorithm."
        />
        <HowItWorks
          step="3"
          title="Fresh discoveries"
          body="Multi-source candidate generation keeps the slate from looping. The more you listen, the sharper the sequencing gets — and your data stays yours to export or delete."
        />
      </section>

      {/* Footer / BYOK note */}
      <footer className="mt-auto pt-20 sm:pt-28">
        <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
          <p className="text-sm opacity-75">
            <span className="font-medium">BYOK — bring your own LLM key.</span>{" "}
            OpenAI, Anthropic, Gemini, or GLM. Your key powers the cold-start
            tag prior and the vibe intent surface; it stays under your control.
            Key management lands in SP-2.
          </p>
        </div>
        <p className="mt-6 text-center text-xs opacity-50">
          AI True Music · a transparent, learning recommender
        </p>
      </footer>
    </main>
  );
}

function HowItWorks({
  step,
  title,
  body,
}: {
  step: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-foreground/10 text-xs font-semibold">
          {step}
        </span>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      <p className="text-sm leading-relaxed opacity-70">{body}</p>
    </div>
  );
}

function MusicMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M9 17.5a3.5 3.5 0 1 1-2-3.16V6.7l10-2v8.96a3.5 3.5 0 1 1-2-3.16V7.3l-6 1.2v9z" />
    </svg>
  );
}
