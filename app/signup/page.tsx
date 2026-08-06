"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Email + password sign-up. With Supabase's default (email confirmation ON),
 * `signUp` returns a user but no session — we show a "check your email" state.
 * If the project has confirmation OFF, a session comes back immediately and we
 * navigate straight to /dashboard. Either way, errors (e.g. "User already
 * registered") surface verbatim. Google OAuth mirrors the login page.
 */
export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [next, setNext] = useState("/dashboard");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const n = params.get("next");
    if (n) setNext(n);
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    // Confirmation disabled → session minted immediately.
    if (data.session) {
      router.replace(next);
      router.refresh();
      return;
    }
    // Confirmation required → show the "verify your email" state.
    setSubmittedEmail(email);
  };

  const signInWithGoogle = async () => {
    setGoogleLoading(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) setError(error.message);
    setGoogleLoading(false);
  };

  if (submittedEmail) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-12">
        <div className="rounded-lg border border-black/10 p-6 text-center dark:border-white/15">
          <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
          <p className="mt-2 text-sm opacity-70">
            If an account can be created for{" "}
            <span className="font-medium">{submittedEmail}</span>, a verification
            link is on its way. Open it in this same browser to finish signing up.
          </p>
          <button
            type="button"
            onClick={() => setSubmittedEmail(null)}
            className="mt-5 text-sm font-medium underline-offset-2 hover:underline"
          >
            Use a different email
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-lg border border-black/10 p-6 dark:border-white/15">
        <div className="flex flex-col items-center text-center">
          <h1 className="text-xl font-semibold tracking-tight">Create account</h1>
          <p className="mt-1 text-sm opacity-70">
            Sign up to get personalized AI music recommendations.
          </p>
        </div>

        {error && (
          <div className="mt-5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-10 w-full rounded-md border border-black/15 bg-background px-3 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="h-10 w-full rounded-md border border-black/15 bg-background px-3 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="mt-1 h-10 w-full rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:opacity-50"
          >
            {submitting ? "Creating account…" : "Sign up"}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-xs opacity-60">
          <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
          or
          <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
        </div>

        <button
          type="button"
          disabled={googleLoading}
          onClick={signInWithGoogle}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {googleLoading ? (
            <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <GoogleMark className="size-4" />
          )}
          Continue with Google
        </button>

        <p className="mt-5 text-center text-sm opacity-70">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium underline-offset-2 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>

      <p className="mt-4 text-center text-xs opacity-60">
        <Link href="/" className="hover:underline">
          ← Back to home
        </Link>
      </p>
    </main>
  );
}

/** The four-color Google "G" mark (no brand-icon dependency). */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}
