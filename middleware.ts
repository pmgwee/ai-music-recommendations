import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";
import { decideAuthResponse } from "@/lib/auth/middleware-decision";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
// Newer "publishable" key with a fallback to the legacy anon key name.
const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string;

/**
 * Routes that require an authenticated session. Today these are the `(app)`
 * surfaces — dashboard + settings. As the `(app)` group grows, list every URL
 * prefix here. (Route-group folders like `(app)` don't appear in the URL, so
 * this list is by real path.)
 */
const PROTECTED_PREFIXES = ["/dashboard", "/settings"];

const isProduction = process.env.NODE_ENV === "production";

/**
 * Build a redirect response that also carries any refreshed auth cookies the
 * Supabase client wrote onto `source`. Redirect branches MUST do this — without
 * it, a rotated refresh token is dropped, and when the browser re-presents the
 * now-invalid old token, reuse detection revokes the session and silently logs
 * the user out.
 */
function redirectWithCookies(url: URL, source: NextResponse): NextResponse {
  const response = NextResponse.redirect(url);
  for (const cookie of source.cookies.getAll()) {
    response.cookies.set(cookie.name, cookie.value, cookie);
  }
  return response;
}

/**
 * Refreshes the auth session on every matched request and enforces route
 * protection. `getUser()` validates the JWT against Supabase (server-side) and,
 * when the access token has expired, rotates it — writing the refreshed cookies
 * onto the forwarded response. We never gate on `getSession()` (client-cached,
 * spoofable). The routing decision itself is delegated to the pure
 * `decideAuthResponse` so it can be unit-tested without Next/Supabase mocks.
 */
async function updateSession(request: NextRequest): Promise<NextResponse> {
  const supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl, supabaseKey, {
    cookieOptions: { secure: isProduction },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          // Keep the request's cookie jar in sync so downstream server
          // components read the refreshed values, and mirror onto the response.
          request.cookies.set(name, value);
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  // Do not run any logic between `getUser` and the decision: its side-effect
  // (cookie refresh) must not be short-circuited.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const decision = decideAuthResponse({
    hasUser: Boolean(user),
    pathname: request.nextUrl.pathname,
    searchParams: request.nextUrl.searchParams,
    protectedPrefixes: PROTECTED_PREFIXES,
  });

  if (decision.action === "redirect") {
    const url = request.nextUrl.clone();
    url.pathname = decision.target.pathname;
    url.search = "";
    for (const [key, value] of Object.entries(decision.target.searchParams)) {
      url.searchParams.set(key, value);
    }
    return redirectWithCookies(url, supabaseResponse);
  }

  return supabaseResponse;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  return updateSession(request);
}

export const config = {
  // Run on everything EXCEPT: the auth surfaces (/login, /signup,
  // /auth/callback — they manage their own flow), API routes (they use the
  // server/admin client directly and don't need per-request session refresh),
  // Next internals, and static assets.
  matcher: [
    "/((?!login|signup|auth/callback|api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map|html|txt)$).*)",
  ],
};
