import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/app-shell";
import { Providers } from "./providers";

/**
 * Authed shell for the `(app)` route group. The middleware already bounces
 * unauthenticated visits to `/login`; this is defense-in-depth — never render
 * the shell (or mount the player) without a server-validated user. Mirrors the
 * subscription-agent `app/(app)/layout.tsx` shape.
 *
 * The player provider wraps the shell so the YouTube IFrame (and its audio)
 * outlives navigation between `(app)` routes. `<Providers>` is a thin client
 * wrapper so the player's `fetch`-based callbacks stay client-side while this
 * layout remains a server component.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <Providers>
      <AppShell user={{ email: user.email ?? null }}>{children}</AppShell>
    </Providers>
  );
}
