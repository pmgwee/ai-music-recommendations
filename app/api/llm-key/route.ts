/**
 * /api/llm-key — BYOK key management (SP-2 Task 4).
 *
 * Three handlers, all session-gated via `requireUser` (401 JSON without) and
 * rate-limited per user (10/min — generous for a settings page, stops a tight
 * client loop). Every read/write goes through the cookie-bound Supabase client
 * so RLS scopes rows to the signed-in user.
 *
 *   GET    → { providers: string[] } — which providers the user has a key for
 *            (most-recently-set first). NEVER returns key material.
 *   POST   { provider, key } → { ok: true, provider } — set/replace the key.
 *            Validates provider ∈ {openai,anthropic,gemini,glm} + non-empty
 *            key under a sane length cap. The plaintext is encrypted in-memory
 *            by `setLlmKey` before any DB write, and is NEVER echoed back.
 *   DELETE { provider } → { ok: true } — remove the user's key for a provider.
 *
 * The DB column is `bytea` ciphertext; even an RLS-owner read of the raw row
 * is useless without the server root key. This route only ever exposes the
 * provider *names* to the client — write-only BYOK contract (spec §D4/§D5).
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";
import { rateLimit } from "@/lib/rate-limit";
import {
  setLlmKey,
  deleteLlmKey,
  listProviders,
  isSupportedProvider,
} from "@/lib/byok/store";

/** Per-user rate limit: 10 llm-key ops/min. Generous for the settings page
 *  (Save + Remove + initial GET = 3 in a session), coarse enough to stop a
 *  script that hammers POST/DELETE. Shares the shelf route's fixed-window
 *  shape so the abuse pattern is consistent across music routes. */
const RATE_LIMIT_OPS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Hard ceiling on key length. Real keys (sk-*, sk-ant-*, AIza*, glm.*) are
 *  tens to ~200 chars; 4096 is well above any legitimate provider key yet
 *  small enough to refuse a payload-of-junk attack. */
const MAX_KEY_LENGTH = 4096;

/** Build the rate-limit + auth gate shared by all three methods. Returns
 *  either `{ ok, supabase, userId }` or a NextResponse the handler returns
 *  as-is. Centralised so the gate logic (401, 429) is identical across
 *  GET/POST/DELETE — a drift here would mean one method is ungated. */
async function gate(): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>; userId: string }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createSupabaseServerClient();
  const auth = await requireUser(supabase);
  if (!auth.ok) return { ok: false, response: auth.response };

  const rl = rateLimit({
    key: `llm-key:${auth.userId}`,
    limit: RATE_LIMIT_OPS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rl.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
        },
      ),
    };
  }
  return { ok: true, supabase, userId: auth.userId };
}

/** Safely parse a JSON body. Returns `null` on malformed/missing JSON so the
 *  handler can return a clean 400 rather than Next's HTML error page (the
 *  same discipline as the bridge ingest in subscription-agent). */
async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function GET() {
  const g = await gate();
  if (!g.ok) return g.response;
  const { supabase, userId } = g;

  try {
    const providers = await listProviders(supabase, userId);
    return NextResponse.json({ providers });
  } catch (err) {
    console.error("[api/llm-key] GET failed:", err);
    return NextResponse.json(
      { error: "list_failed", providers: [] },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const { supabase, userId } = g;

  const body = await parseJsonBody(req);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { provider, key } = body as Record<string, unknown>;

  if (typeof provider !== "string" || !isSupportedProvider(provider)) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH
  ) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }

  try {
    await setLlmKey(supabase, userId, provider, key);
    // Never echo the plaintext key — confirm only the provider that was set.
    return NextResponse.json({ ok: true, provider });
  } catch (err) {
    console.error("[api/llm-key] POST failed:", err);
    return NextResponse.json({ error: "set_failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const { supabase, userId } = g;

  const body = await parseJsonBody(req);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { provider } = body as Record<string, unknown>;

  if (typeof provider !== "string" || !isSupportedProvider(provider)) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  try {
    await deleteLlmKey(supabase, userId, provider);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/llm-key] DELETE failed:", err);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}
