"use client";

/**
 * Shared client sign-out button. Calls `supabase.auth.signOut()` then routes to
 * `/login` — the auth cookies are cleared by the client SDK, so the next
 * request to a protected route is bounced by the middleware as intended. Even
 * if `signOut` throws (network), we still route to `/login`; the middleware
 * re-validates and keeps the user out of protected routes.
 *
 * Extracted from `components/layout/app-shell.tsx` so the settings page reuses
 * the exact same logic instead of duplicating it.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // Even if signOut throws (network), route to /login — the middleware
      // will re-validate and keep the user out of protected routes.
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void signOut()}
      className={
        className ??
        "rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10"
      }
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
