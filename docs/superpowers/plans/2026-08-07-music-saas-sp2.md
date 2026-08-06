# SP-2 — BYOK LLM Layer (design + plan)

**Goal:** members enter their own LLM API key (OpenAI / Anthropic / Gemini / GLM) in Settings; the engine's `LlmProvider` calls use it (encrypted at rest); the server GLM key is no longer the default. Degrade gracefully when no key / over-quota / invalid.

**Spec basis:** SP-0 design §3 (the `LlmProvider` seam), §2 D4 (LLM role). Predecessor: SP-1 (settings shell with the BYOK placeholder).

## Decisions (defaults)
| # | Decision | Default |
|---|---|---|
| D1 | Providers | OpenAI (`gpt-4o-mini` default), Anthropic (`claude-haiku-4-5-20251001`), Gemini (`gemini-2.0-flash`), GLM (`glm-4-flash`/user's ZAI). Each via its OpenAI-compatible or native endpoint. |
| D2 | Encryption | AES-256-GCM with a root key from `LLM_KEY_ENCRYPTION_KEY` (32-byte hex). Per-user key encrypted server-side before storage; client never reads it back (write-only). Fail-closed if the root key is unset in production; dev-only insecure fallback + loud warning. |
| D3 | Storage | New `user_llm_keys` table: `(user_id uuid, provider text, encrypted_key bytea, iv bytea, created_at, updated_at, pk(user_id, provider))`. RLS: owner read (status only — the row, not the plaintext) + write. One key per provider per user. |
| D4 | Routing | The shelf/vibe paths build the `LlmProvider` from the **signed-in user's** stored key (BYOK). If none, `isConfigured()=false` → engine degrades (tag prior skipped → co-occurrence; vibe returns empty). The server GLM key is **not** a fallback (BYOK is the point) — only the dev integration script uses the server key. |
| D5 | UI | Settings: provider `<select>` + key `<input type="password">` + Save; show "✓ key set for <provider>" status; never echo the key. Allow switching provider (sets a new row) + delete. |

## Architecture
- `lib/byok/crypto.ts` — `encrypt(plaintext, rootKey)` / `decrypt(ciphertext, iv, rootKey)` (AES-256-GCM via WebCrypto, server-side).
- `lib/byok/store.ts` — `getLlmKey(supabase, userId, provider)`, `setLlmKey(...)`, `listProviders(userId)`, `deleteLlmKey(...)` (RLS server client; the value is the encrypted blob).
- `lib/providers/llm-byok.ts` — `createByokLlm(supabase, userId): Promise<LlmProvider | null>` — loads the user's configured provider+key, returns the matching `LlmProvider` (openai-compatible or native), or `null` if none. The provider impls (OpenAI/Anthropic/Gemini) each adapt the `LlmProvider.chat` shape.
- `app/api/llm-key/route.ts` — GET (status: which providers have a key), POST (set/update), DELETE.
- The music routes' `createGlmLlm()` (SP-0) → replaced by `await createByokLlm(supabase, user.id)`; if `null`, pass a `NullLlm` (`isConfigured()=>false`) so the engine degrades cleanly.
- Settings UI wired to `/api/llm-key`.

## Tasks
1. **Schema** — migration `0002_user_llm_keys.sql` (table + RLS) + update `lib/supabase/types.ts` + `.env.example` adds `LLM_KEY_ENCRYPTION_KEY=`.
2. **Crypto** — `lib/byok/crypto.ts` (AES-GCM) + unit tests (round-trip; different IVs; tamper fails).
3. **Store + BYOK provider** — `lib/byok/store.ts` + `lib/providers/llm-byok.ts` (+ openai/anthropic/gemini adapters) + tests (mocked supabase + mocked fetch).
4. **Routes** — `/api/llm-key` (GET/POST/DELETE, session-gated, rate-limited) + rewire `/api/music/shelf` to `createByokLlm`. The vibe route (SP-5) will use it too.
5. **Settings UI** — provider select + key input + save/status/delete; replace the SP-1 placeholder.
6. **Gate + push** — typecheck + build + tests; push.

## Success criteria
- SC1. A user can set an OpenAI (or Anthropic/Gemini/GLM) key in Settings; it's stored encrypted (verify: DB row is ciphertext, not plaintext).
- SC2. The shelf build uses the user's key (the tag prior / vibe run against THEIR provider); verify via the engine's LLM path engaging.
- SC3. No key → engine degrades cleanly (shelf still returns co-occurrence results; no 500).
- SC4. The key is never sent to the client after setting (write-only). typecheck + build + tests clean; pushed.

## Open items for user review
- `LLM_KEY_ENCRYPTION_KEY` must be set (32-byte hex) in `.env` + Vercel — user generates (`openssl rand -hex 32`). Without it, BYOK is disabled (fail-closed).
- Provider model defaults (D1) are sensible picks; user can refine.
- This stores the user's LLM key server-side (encrypted). For a stricter model, the key could live client-side only (sent per-request) — but that breaks server-side LLM calls (the engine runs server-side). Server-encrypted-at-rest is the standard BYOK pattern; documented.
