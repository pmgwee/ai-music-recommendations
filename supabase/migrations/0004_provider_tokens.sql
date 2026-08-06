-- ============================================================================
-- SP-3 Task 3: Encrypted OAuth token storage for the playlist-import flows.
--
-- One row per (user, provider) holding the user's encrypted OAuth access +
-- refresh token pair returned by YouTube (Google) / Spotify after they connect
-- their account. The plaintext token is encrypted at rest by
-- `lib/byok/crypto.ts` (AES-256-GCM, per-row random IV) using the SAME root
-- key as the BYOK LLM keys — `LLM_KEY_ENCRYPTION_KEY`. Storing OAuth tokens
-- encrypted (rather than plaintext like Supabase Auth's own `identities`)
-- means a read-only DB leak yields no usable provider credentials; the cookie
-- client reads the row under RLS and the server decrypts on use.
--
-- `bytea` for both ciphertext + IV mirrors `user_llm_keys`; the typed client
-- surfaces bytea as a base64 string. RLS owner-only: each user reads/writes
-- only their own token row.
--
-- Live pending: user applies this migration at SP-3 review (Dashboard SQL
-- editor or `supabase db push`). Not applied by this commit.
-- ============================================================================


create table if not exists public.provider_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 'youtube' (Google OAuth, youtube.readonly) or 'spotify' (playlist-read-private).
  provider text not null check (provider in ('youtube','spotify')),
  -- AES-256-GCM ciphertext of the JSON-serialised token envelope
  -- ({access, refresh?, expiresAt?, scope?}). base64 over the wire.
  encrypted_token bytea not null,
  -- 12-byte AES-GCM nonce, base64. Fresh per write (re-connect re-encrypts).
  iv bytea not null,
  -- OAuth scopes granted — captured for audit (the flow requests a fixed
  -- scope per provider; this records what the provider actually returned).
  scope text not null default '',
  -- Access-token expiry (server clock). Null when the provider did not
  -- return `expires_in`. Used by the connect path to surface reauth hints.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);


alter table public.provider_tokens enable row level security;

-- Single owner-all policy: SELECT/INSERT/UPDATE/DELETE all gated on
-- auth.uid() = user_id. The cookie-scoped server client owns all four
-- operations (the route handlers in app/api/ingest/*). The service-role
-- client is NOT used here — unlike catalog-global music_track_sources,
-- provider tokens are per-user private credentials.
drop policy if exists "provider_tokens_owner_all" on public.provider_tokens;
create policy "provider_tokens_owner_all" on public.provider_tokens
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
