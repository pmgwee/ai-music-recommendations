"use client";

/**
 * Authed app shell: desktop sidebar + sticky header (app name, user email,
 * sign-out) + mobile bottom nav. Mirrors the subscription-agent
 * `components/layout/app-shell.tsx` shape, stripped to the SP-1 surface
 * (Dashboard, Settings) with no external icon dependency (inline SVGs keep the
 * public bundle small and avoid a `lucide-react` dep this project doesn't
 * have). Sign-out is the shared `components/auth/sign-out-button.tsx` so the
 * settings page reuses the exact same logic.
 *
 * The shell is a client component because the nav links read `usePathname()`
 * for the active state and the sign-out button is a client-side action. The
 * user email is forwarded from the server-side `(app)/layout.tsx`.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";

export interface AppUser {
  email: string | null;
}

type NavItem = { href: string; label: string };

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/taste", label: "Taste" },
  { href: "/vibe", label: "Vibe" },
  { href: "/library", label: "Library" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: AppUser;
}) {
  const pathname = usePathname();

  return (
    <div className="min-h-dvh">
      {/* Sidebar — desktop */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[240px] flex-col border-r border-black/10 px-4 py-6 dark:border-white/15 lg:flex">
        <div className="flex items-center gap-2.5 px-2">
          <div className="grid size-9 place-items-center rounded-xl bg-foreground/10 ring-1 ring-foreground/20">
            <MusicMark className="size-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">
              AI Music
            </div>
            <div className="text-xs opacity-60">Recommendations</div>
          </div>
        </div>

        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors " +
                  (active
                    ? "bg-foreground/5 font-medium text-foreground"
                    : "text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground")
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className="lg:pl-[240px]">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-black/10 bg-background/80 px-4 backdrop-blur dark:border-white/15 sm:px-6">
          <span className="text-sm font-semibold tracking-tight lg:hidden">
            {NAV.find((n) => isActive(pathname, n.href))?.label ?? "AI Music"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {user.email ? (
              <span
                className="hidden max-w-[40vw] truncate text-sm opacity-70 sm:block"
                title={user.email}
              >
                {user.email}
              </span>
            ) : null}
            <SignOutButton />
          </div>
        </header>

        <main className="px-4 pb-28 pt-6 sm:px-6 lg:pb-10">{children}</main>
      </div>

      {/* Bottom nav — mobile */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-black/10 bg-background/90 px-2 py-2 backdrop-blur dark:border-white/15 lg:hidden">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                "flex flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-[11px] transition-colors " +
                (active ? "font-medium text-foreground" : "text-foreground/60")
              }
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** A path is active when it matches the nav href or a route beneath it. */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function MusicMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M9 17.5a3.5 3.5 0 1 1-2-3.16V6.7l10-2v8.96a3.5 3.5 0 1 1-2-3.16V7.3l-6 1.2v9z" />
    </svg>
  );
}
