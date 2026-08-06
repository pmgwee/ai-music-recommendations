/**
 * Pure auth-redirect decision core, factored out of `middleware.ts` so it can be
 * unit-tested without spinning up Next's NextRequest/NextResponse or a live
 * Supabase client. The middleware owns the side effects (cookie refresh, the
 * `getUser()` call, building NextResponse objects); this module owns the
 * routing decision given (a) whether a session exists and (b) the request URL.
 *
 * @see middleware.ts — the only caller; it translates `AuthDecision` into a
 *   cookie-carrying NextResponse.redirect or NextResponse.next.
 */

import { safeRedirectPath } from "./redirect";

export type AuthDecision =
  | { action: "pass" }
  | { action: "redirect"; target: { pathname: string; searchParams: Record<string, string> } };

export interface DecideArgs {
  /** True when `supabase.auth.getUser()` resolved to a user record. */
  hasUser: boolean;
  /** `request.nextUrl.pathname` — the path being requested. */
  pathname: string;
  /** `request.nextUrl.searchParams` — the query string. */
  searchParams: URLSearchParams;
  /** URL prefixes that require a session. Future (app)-group routes go here. */
  protectedPrefixes?: string[];
  /** Where the PKCE callback lives. */
  callbackPath?: string;
  /** Where to send unauthenticated users who hit a protected route. */
  loginPath?: string;
}

const DEFAULT_PROTECTED_PREFIXES = ["/dashboard", "/settings"];
const CALLBACK_PATH = "/auth/callback";
const LOGIN_PATH = "/login";

export function decideAuthResponse({
  hasUser,
  pathname,
  searchParams,
  protectedPrefixes = DEFAULT_PROTECTED_PREFIXES,
  callbackPath = CALLBACK_PATH,
  loginPath = LOGIN_PATH,
}: DecideArgs): AuthDecision {
  // 1. Rescue a stranded OAuth handoff. The provider redirects back with
  //    ?code= (success) or ?error= (cancel/failure); if Supabase fell back to
  //    the site URL because the configured redirectTo wasn't allowlisted, the
  //    code lands on a non-callback route and would never be exchanged — the
  //    user appears logged out. Forward it. Gated on `!user` so a future
  //    authed feature that puts ?code= on a URL isn't hijacked.
  if (!hasUser && pathname !== callbackPath) {
    const code = searchParams.get("code");
    const error =
      searchParams.get("error") ?? searchParams.get("error_description");
    if (code || error) {
      return {
        action: "redirect",
        target: code
          ? { pathname: callbackPath, searchParams: { code, next: safeRedirectPath(pathname) } }
          : { pathname: callbackPath, searchParams: { error: "stranded", next: safeRedirectPath(pathname) } },
      };
    }
  }

  // 2. Unauthenticated visit to a protected route → /login, preserving the
  //    intended destination in `next` so sign-in returns the user to it.
  const isProtected = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!hasUser && isProtected) {
    return {
      action: "redirect",
      target: { pathname: loginPath, searchParams: { next: safeRedirectPath(pathname) } },
    };
  }

  // 3. Otherwise pass through; middleware returns NextResponse.next with the
  //    refreshed cookies attached.
  return { action: "pass" };
}
