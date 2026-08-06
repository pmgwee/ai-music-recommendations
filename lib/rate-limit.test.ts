/**
 * rateLimit — the in-memory fixed-window limiter that protects the InnerTube
 * candidate source (the operator's scrape-costly shared resource) and the
 * DB-writing play/signal routes. Covers: in-window allowance, deny-on-overflow
 * with retryAfterMs, window reset (fake timers), and Map-cap eviction so a
 * long-lived instance can't grow the bucket Map without bound.
 *
 * Style mirrors `require-user.test.ts`: hand-driven, no external harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  rateLimit,
  getClientIP,
  RATE_LIMIT_MAX_ENTRIES,
  __resetRateLimiterForTests,
  __getBucketSizeForTests,
} from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimiterForTests());

  it("allows up to `limit` calls in a window, then denies the next with retryAfterMs", () => {
    const limit = 3;
    for (let i = 0; i < limit; i++) {
      const r = rateLimit({ key: "k", limit, windowMs: 60_000 });
      expect(r.ok).toBe(true);
      expect(r.retryAfterMs).toBe(0);
    }
    const denied = rateLimit({ key: "k", limit, windowMs: 60_000 });
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // denied mid-window ⇒ must wait until the window resets
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("isolates keys — a hot key does not affect an unused one", () => {
    for (let i = 0; i < 5; i++) rateLimit({ key: "hot", limit: 5, windowMs: 60_000 });
    const denied = rateLimit({ key: "hot", limit: 5, windowMs: 60_000 });
    expect(denied.ok).toBe(false);

    const other = rateLimit({ key: "cold", limit: 5, windowMs: 60_000 });
    expect(other.ok).toBe(true);
  });

  it("reopens the window after windowMs elapses (fake timers)", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) rateLimit({ key: "k2", limit: 3, windowMs: 60_000 });
      const denied = rateLimit({ key: "k2", limit: 3, windowMs: 60_000 });
      expect(denied.ok).toBe(false);

      // just past the window — the next call reopens it
      vi.advanceTimersByTime(60_001);
      const after = rateLimit({ key: "k2", limit: 3, windowMs: 60_000 });
      expect(after.ok).toBe(true);
      expect(after.retryAfterMs).toBe(0);

      // and limits again until the next window opens (not a free-for-all)
      for (let i = 0; i < 2; i++) {
        const r = rateLimit({ key: "k2", limit: 3, windowMs: 60_000 });
        expect(r.ok).toBe(true);
      }
      const denied2 = rateLimit({ key: "k2", limit: 3, windowMs: 60_000 });
      expect(denied2.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts entries to cap Map size (never grows past RATE_LIMIT_MAX_ENTRIES)", () => {
    // Each unique key opens a fresh bucket; with a 60s window none expire
    // mid-loop, so the only thing keeping size bounded is the cap logic.
    const many = RATE_LIMIT_MAX_ENTRIES + 500;
    for (let i = 0; i < many; i++) {
      rateLimit({ key: `cap-${i}`, limit: 1, windowMs: 60_000 });
    }
    expect(__getBucketSizeForTests()).toBeLessThanOrEqual(RATE_LIMIT_MAX_ENTRIES);
  });
});

describe("getClientIP", () => {
  it("reads the first IP from x-forwarded-for", () => {
    const req = new Request("https://x/", {
      headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" },
    });
    expect(getClientIP(req)).toBe("203.0.113.1");
  });

  it("trims whitespace around the first entry", () => {
    const req = new Request("https://x/", {
      headers: { "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" },
    });
    expect(getClientIP(req)).toBe("203.0.113.7");
  });

  it("falls back to a constant when the header is absent", () => {
    const req = new Request("https://x/");
    const ip = getClientIP(req);
    expect(typeof ip).toBe("string");
    expect(ip.length).toBeGreaterThan(0);
    // two fallbacks resolve to the same constant (shared bucket)
    expect(getClientIP(new Request("https://y/"))).toBe(ip);
  });
});
