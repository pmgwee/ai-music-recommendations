import { describe, expect, it } from "vitest";
import { decideAuthResponse } from "./middleware-decision";

const sp = (s: string) => new URLSearchParams(s);

describe("decideAuthResponse", () => {
  it("(a) redirects an unauthenticated /dashboard visit to /login with next=/dashboard", () => {
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/dashboard",
      searchParams: sp(""),
    });
    expect(d.action).toBe("redirect");
    if (d.action === "redirect") {
      expect(d.target.pathname).toBe("/login");
      expect(d.target.searchParams).toEqual({ next: "/dashboard" });
    }
  });

  it("(b) passes /dashboard through when a session exists", () => {
    const d = decideAuthResponse({
      hasUser: true,
      pathname: "/dashboard",
      searchParams: sp(""),
    });
    expect(d.action).toBe("pass");
  });

  it("(c) forwards a stranded ?code= on a non-callback route to /auth/callback", () => {
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/",
      searchParams: sp("code=abc123"),
    });
    expect(d.action).toBe("redirect");
    if (d.action === "redirect") {
      expect(d.target.pathname).toBe("/auth/callback");
      expect(d.target.searchParams.code).toBe("abc123");
      // The original path is carried as `next` so the callback returns there.
      expect(d.target.searchParams.next).toBe("/");
    }
  });

  it("protects nested protected paths (/dashboard/settings)", () => {
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/dashboard/settings",
      searchParams: sp(""),
    });
    expect(d.action).toBe("redirect");
    if (d.action === "redirect") {
      expect(d.target.pathname).toBe("/login");
      expect(d.target.searchParams.next).toBe("/dashboard/settings");
    }
  });

  it("redirects an unauthenticated /settings visit to /login with next=/settings", () => {
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/settings",
      searchParams: sp(""),
    });
    expect(d.action).toBe("redirect");
    if (d.action === "redirect") {
      expect(d.target.pathname).toBe("/login");
      expect(d.target.searchParams).toEqual({ next: "/settings" });
    }
  });

  it("passes /settings through when a session exists", () => {
    const d = decideAuthResponse({
      hasUser: true,
      pathname: "/settings",
      searchParams: sp(""),
    });
    expect(d.action).toBe("pass");
  });

  it("does not hijack ?code= when the user is already authenticated", () => {
    const d = decideAuthResponse({
      hasUser: true,
      pathname: "/",
      searchParams: sp("code=abc123"),
    });
    expect(d.action).toBe("pass");
  });

  it("leaves the real /auth/callback route alone (no rescue loop)", () => {
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/auth/callback",
      searchParams: sp("code=abc123"),
    });
    expect(d.action).toBe("pass");
  });

  it("forwards a stranded ?error= to the callback as error=stranded", () => {
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/",
      searchParams: sp("error=access_denied"),
    });
    expect(d.action).toBe("redirect");
    if (d.action === "redirect") {
      expect(d.target.pathname).toBe("/auth/callback");
      expect(d.target.searchParams.error).toBe("stranded");
    }
  });

  it("leaves the public root / accessible when unauthenticated", () => {
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/",
      searchParams: sp(""),
    });
    expect(d.action).toBe("pass");
  });

  it("clamps an open-redirect attempt in a rescued path's next to /dashboard", () => {
    // safeRedirectPath rejects protocol-relative / absolute URLs. Here the
    // stranded rescue is on a path that itself is benign ("/"), but the
    // login-redirect `next` must also be sanitized when it comes from a
    // protected prefix — verified via the dashboard case below.
    const d = decideAuthResponse({
      hasUser: false,
      pathname: "/dashboard",
      searchParams: sp("next=//evil.com"),
    });
    expect(d.action).toBe("redirect");
    if (d.action === "redirect") {
      // The protected-route branch uses the *pathname*, not the query `next`,
      // so this is /dashboard — safe.
      expect(d.target.searchParams.next).toBe("/dashboard");
    }
  });
});
