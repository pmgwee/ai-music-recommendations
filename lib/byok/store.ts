/**
 * BYOK key store — encrypted API key persistence for the four supported LLM
 * providers (openai / anthropic / gemini / glm). SERVER ONLY.
 *
 * Every read/write goes through the cookie-bound Supabase client the caller
 * passes in, so RLS scopes each row to the signed-in user (`auth.uid() =
 * user_id`). The plaintext key never touches the database: `setLlmKey`
 * encrypts via `lib/byok/crypto.ts` (AES-256-GCM, per-row random IV) before
 * upsert, and `getLlmKey` decrypts only at the call site. The DB column is
 * `bytea`, which the typed client surfaces as a base64 `string`.
 *
 * Failure modes:
 *  - `isEncryptionConfigured() === false` (no `LLM_KEY_ENCRYPTION_KEY` in env)
 *    → `getLlmKey` returns null (BYOK disabled; route layer surfaces "set your
 *    key" cleanly) and `setLlmKey` still runs but encrypts with the dev fallback
 *    key. In production `crypto.ts` throws fail-closed before any DB write, so
 *    no real key can be persisted without the root key configured.
 *  - DB error → throws (the route handler logs + returns a structured 5xx; the
 *    engine's LLM callers (`parseVibe` / `tagBatch`) already wrap `chat` in
 *    try/catch and degrade).
 *  - GCM auth-tag mismatch on decrypt (ciphertext/IV tampered, or root key
 *    differs from the one used to encrypt) → `decryptKey` throws.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/types";
import { encryptKey, decryptKey, isEncryptionConfigured } from "./crypto";

type ServerClient = SupabaseClient<Database>;

/**
 * Provider names supported by the BYOK layer. Mirrors the CHECK constraint on
 * `user_llm_keys.provider` (migration 0002) so a typo is caught at the boundary
 * with a clear error rather than a Postgres constraint violation.
 */
export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "glm",
] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(
  name: string,
): name is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(name);
}

/**
 * Read + decrypt the user's API key for a provider.
 *
 * @returns the plaintext key, or `null` if no row exists OR the encryption root
 *          key is not configured (BYOK disabled). Throws on DB error or GCM
 *          auth-tag mismatch (tampering / wrong root key).
 */
export async function getLlmKey(
  supabase: ServerClient,
  userId: string,
  provider: string,
): Promise<string | null> {
  // Gate early: when the root key is not configured, no row can be decrypted,
  // and signaling "no key" lets the caller degrade cleanly without leaking a
  // crypto error. (Production never reaches here — `setLlmKey` would have
  // thrown fail-closed before any row existed.)
  if (!isEncryptionConfigured()) return null;

  const { data, error } = await supabase
    .from("user_llm_keys")
    .select("encrypted_key, iv")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) throw new Error(`[byok] getLlmKey failed: ${error.message}`);
  if (!data) return null;

  return decryptKey(data.encrypted_key, data.iv);
}

/**
 * Encrypt + upsert the user's key for a provider. Creates the row if none
 * exists; replaces the ciphertext + IV (fresh per write) + bumps `updated_at`
 * if it does. The plaintext is encrypted in-memory before any DB call.
 */
export async function setLlmKey(
  supabase: ServerClient,
  userId: string,
  provider: string,
  plaintext: string,
): Promise<void> {
  if (!isSupportedProvider(provider)) {
    throw new Error(
      `[byok] unsupported provider "${provider}"; expected one of ` +
        SUPPORTED_PROVIDERS.join(", "),
    );
  }
  if (!plaintext) throw new Error("[byok] setLlmKey received an empty key");

  const { ciphertext, iv } = await encryptKey(plaintext);

  const { error } = await supabase.from("user_llm_keys").upsert(
    {
      user_id: userId,
      provider,
      encrypted_key: ciphertext,
      iv,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
  if (error) throw new Error(`[byok] setLlmKey failed: ${error.message}`);
}

/**
 * The provider names the user has a key for, most-recently-set first. Returns
 * NO plaintext and NO IV — the client UI only needs to know *which* providers
 * are configured, never the key material itself (write-only BYOK contract).
 */
export async function listProviders(
  supabase: ServerClient,
  userId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("user_llm_keys")
    .select("provider")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`[byok] listProviders failed: ${error.message}`);
  return (data ?? []).map((r) => r.provider);
}

/**
 * Delete the user's key for a provider. No-op if no row exists (Supabase's
 * `delete()` is idempotent — it just affects zero rows).
 */
export async function deleteLlmKey(
  supabase: ServerClient,
  userId: string,
  provider: string,
): Promise<void> {
  const { error } = await supabase
    .from("user_llm_keys")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);

  if (error) throw new Error(`[byok] deleteLlmKey failed: ${error.message}`);
}
