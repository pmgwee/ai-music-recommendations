import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/redirect";

/**
 * PKCE callback for email verification and Google OAuth. The provider redirects
 * here with a one-time `code`; we exchange it for a session server-side (the
 * code never touches the browser), set the auth cookies, and forward to the
 * sanitized `next` path. Errors (cancel/missing code/exchange failure) go back
 * to /login with an `error=callback` flag — no stack details leaked.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next");
  const next = safeRedirectPath(nextParam);

  const errorCode =
    searchParams.get("error") ?? searchParams.get("error_description");
  if (errorCode || !code) {
    return NextResponse.redirect(
      `${origin}/login?error=callback&next=${encodeURIComponent(next)}`,
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=callback&next=${encodeURIComponent(next)}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
