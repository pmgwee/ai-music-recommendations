/**
 * In-memory fixed-window rate limiter.
 *
 * Protects scrape-costly InnerTube candidate generation (`/api/music/shelf`) and
 * DB-writing play/signal routes from tight client loops. Per-key counters are
 * kept in process memory.
 *
 * Single-region note: this is correct only for a single-region / single-instance
 * deploy. On serverless multi-instance setups each instance keeps its own map,
 * so the effective limit is `limit × instance_count` — fine for abuse-stopping
 * coarse limits; a Redis/Upstash-backed limiter is the upgrade path when a tight
 * distributed guarantee is needed (out of scope for SP-1).
 */

interface BucketEntry {
  count: number;
  resetAt: number; // epoch ms — when the current window closes
}

/** Hard cap on the number of distinct keys tracked, so a long-lived instance
 *  can't grow the Map without bound under a cardinality attack. */
export const RATE_LIMIT_MAX_ENTRIES = 10_000;

const buckets = new Map<string, BucketEntry>();

export interface RateLimitInput {
  key: string;
  /** Max calls permitted within a single window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Ms until the caller may retry (0 when ok). */
  retryAfterMs: number;
}

/**
 * Fixed-window counter: the first call in a window opens it (count=1,
 * resetAt=now+windowMs); subsequent calls increment until `limit` is reached;
 * the first call after `resetAt` reopens the window. Returns `ok:false` with a
 * retry hint when over the limit — never throws, so a route can call it inline.
 */
export function rateLimit({ key, limit, windowMs }: RateLimitInput): RateLimitResult {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > RATE_LIMIT_MAX_ENTRIES) evict(now);
    return { ok: true, retryAfterMs: 0 };
  }

  if (entry.count < limit) {
    entry.count += 1;
    return { ok: true, retryAfterMs: 0 };
  }

  return { ok: false, retryAfterMs: Math.max(0, entry.resetAt - now) };
}

/**
 * Resolve a client IP from `x-forwarded-for` (set by Vercel and most reverse
 * proxies). Falls back to a constant when absent — every fallback shares one
 * bucket, which is acceptable because Vercel always sets the header in prod and
 * dev-only traffic is single-user.
 */
export function getClientIP(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first && first.trim()) return first.trim();
  }
  return "unknown";
}

/** Evict expired entries; if still over the cap, drop oldest-by-resetAt. */
function evict(now: number): void {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size > RATE_LIMIT_MAX_ENTRIES) {
    const overflow = buckets.size - RATE_LIMIT_MAX_ENTRIES;
    const sorted = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < overflow; i++) buckets.delete(sorted[i]![0]);
  }
}

// --- test-only helpers -------------------------------------------------------

/** Wipe all buckets so unit tests start from a clean slate. */
export function __resetRateLimiterForTests(): void {
  buckets.clear();
}

/** Inspect live Map size — used by the cap-eviction test. */
export function __getBucketSizeForTests(): number {
  return buckets.size;
}
