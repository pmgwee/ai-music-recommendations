-- ============================================================================
-- SP-2 Task 1: user_llm_keys — encrypted BYOK LLM API key storage.
--
-- Each user stores one ciphertext per provider (openai / anthropic / gemini /
-- glm). The plaintext key never reaches the client and is not stored anywhere:
-- the route layer AES-256-GCM-encrypts (lib/byok/crypto.ts) before insert, and
-- the typed client surfaces `bytea` as a base64 `string`. The server's
-- `LLM_KEY_ENCRYPTION_KEY` (32-byte hex, server-only env) is the root — without
-- it the ciphertext rows are useless, so RLS-owner-read of the ciphertext is
-- safe (the client only needs to know *which* providers are configured, not the
-- key material itself).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- user_llm_keys — one encrypted key per (user, provider).
-- ----------------------------------------------------------------------------
create table if not exists public.user_llm_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai','anthropic','gemini','glm')),
  encrypted_key bytea not null,
  iv bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create index if not exists user_llm_keys_user_idx
  on public.user_llm_keys(user_id);

alter table public.user_llm_keys enable row level security;

-- Owner can read (status: which providers they have) + write their own rows.
-- The encrypted_key is ciphertext; without the server root key it's useless.
-- The client never needs the plaintext.
drop policy if exists "user_llm_keys_owner_all" on public.user_llm_keys;
create policy "user_llm_keys_owner_all" on public.user_llm_keys
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
