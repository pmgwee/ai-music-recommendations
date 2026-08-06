/**
 * Provider token store — encrypted OAuth token persistence for the playlist
 * import flows (SP-3 Task 3). SERVER ONLY.
 *
 * Same shape as the BYOK key store (`lib/byok/store.ts`): every read/write goes
 * through the cookie-bound Supabase client the caller passes in, so RLS scopes
 * each row to the signed-in user (`auth.uid() = user_id`). The plaintext token
 * envelope ({access, refresh?, expiresAt?}) is JSON-serialised and encrypted
 * via `lib/byok/crypto.ts` (AES-256-GCM, per-row random IV) before any DB
 * write; `getProviderToken` decrypts only at the call site. The DB columns are
 * `bytea`, which the typed client surfaces as a base64 `string`.
 *
 * Reuses the SAME root key as BYOK (`LLM_KEY_ENCRYPTION_KEY`) — one secret is
 * easier to rotate than two, and the failure modes are identical (a leaked key
 * leaks both BYOK keys and provider tokens; they fail together).
 *
 * Failure modes:
 *  - `isEncryptionConfigured() === false` (no `LLM_KEY_ENCRYPTION_KEY` in env)
 *    → `getProviderToken` returns null (route surfaces "not connected") and
 *    `setProviderToken` still runs but encrypts with the dev fallback key. In
 *    production `crypto.ts` throws fail-closed before any DB write, so no real
 *    token can be persisted without the root key configured.
 *  - DB error → throws (the route handler logs + returns a structured 5xx).
 *  - GCM auth-tag mismatch on decrypt (ciphertext/IV tampered, or root key
 *    differs from the one used to encrypt) → `decryptKey` throws.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/types";
import { encryptKey, decryptKey, isEncryptionConfigured } from "../byok/crypto";

type ServerClient = SupabaseClient<Database>;

/**
 * Providers with an OAuth import flow. Mirrors the CHECK constraint on
 * `provider_tokens.provider` (migration 0004) so a typo is caught at the
 * boundary with a clear error.
 */
export const INGEST_PROVIDERS = ["youtube", "spotify"] as const;
export type IngestProvider = (typeof INGEST_PROVIDERS)[number];

export function isIngestProvider(name: string): name is IngestProvider {
  return (INGEST_PROVIDERS as readonly string[]).includes(name);
}

/**
 * The plaintext token envelope persisted (encrypted) per (user, provider).
 * `access` is the bearer used to call the provider's playlist/track APIs;
 * `refresh` lets the server silently re-mint `access` after it expires (the
 * refresh path is a future task — for now we store it so a re-authorisation
 * isn't needed the moment `access` expires, and the user can clear it).
 */
export interface ProviderTokenEnvelope {
  access: string;
  refresh?: string;
  /** ISO 8601 instant the access token expires (server clock), if known. */
  expiresAt?: string;
}

/**
 * Read + decrypt the user's OAuth token for a provider.
 *
 * @returns the plaintext envelope, or `null` if no row exists OR the encryption
 *          root key is not configured (route surfaces "not connected" cleanly).
 *          Throws on DB error or GCM auth-tag mismatch (tampering / wrong key).
 */
export async function getProviderToken(
  supabase: ServerClient,
  userId: string,
  provider: string,
): Promise<ProviderTokenEnvelope | null> {
  // Gate early: when the root key is not configured, no row can be decrypted,
  // and signaling "not connected" lets the caller degrade cleanly without
  // leaking a crypto error. (Production never reaches here — `setProviderToken`
  // would have thrown fail-closed before any row existed.)
  if (!isEncryptionConfigured()) return null;

  const { data, error } = await supabase
    .from("provider_tokens")
    .select("encrypted_token, iv")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) throw new Error(`[ingest/tokens] getProviderToken failed: ${error.message}`);
  if (!data) return null;

  const plaintext = await decryptKey(data.encrypted_token, data.iv);
  return parseEnvelope(plaintext);
}

/**
 * Encrypt + upsert the user's OAuth token for a provider. Creates the row if
 * none exists; replaces the ciphertext + IV (fresh per write) + bumps
 * `updated_at` if it does. The plaintext is encrypted in-memory before any DB
 * call.
 *
 * `scope` + `expiresAt` are stored UNENCRYPTED (they're non-secret metadata
 * used for audit + reauth hints). Only the token envelope is ciphertext.
 */
export async function setProviderToken(
  supabase: ServerClient,
  userId: string,
  provider: string,
  token: ProviderTokenEnvelope,
  scope: string,
): Promise<void> {
  if (!isIngestProvider(provider)) {
    throw new Error(
      `[ingest/tokens] unsupported provider "${provider}"; expected one of ` +
        INGEST_PROVIDERS.join(", "),
    );
  }
  if (!token.access) {
    throw new Error("[ingest/tokens] setProviderToken received an empty access token");
  }

  const plaintext = serializeEnvelope(token);
  const { ciphertext, iv } = await encryptKey(plaintext);

  const { error } = await supabase.from("provider_tokens").upsert(
    {
      user_id: userId,
      provider,
      encrypted_token: ciphertext,
      iv,
      scope,
      expires_at: token.expiresAt ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
  if (error) throw new Error(`[ingest/tokens] setProviderToken failed: ${error.message}`);
}

/**
 * Delete the user's token row for a provider. Used by a "disconnect" route and
 * by the OAuth callback when the provider returns a malformed token (so a
 * half-state can't strand the user). No-op if no row exists.
 */
export async function clearProviderToken(
  supabase: ServerClient,
  userId: string,
  provider: string,
): Promise<void> {
  const { error } = await supabase
    .from("provider_tokens")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);

  if (error) throw new Error(`[ingest/tokens] clearProviderToken failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Envelope (de)serialisation. JSON is the wire format: it preserves the
// optional fields cleanly and survives a future field addition without a
// migration. Unknown keys are ignored on read (forward-compat).
// ---------------------------------------------------------------------------

function serializeEnvelope(token: ProviderTokenEnvelope): string {
  return JSON.stringify(token);
}

function parseEnvelope(plaintext: string): ProviderTokenEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("[ingest/tokens] stored token envelope is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("[ingest/tokens] stored token envelope is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.access !== "string" || !obj.access) {
    throw new Error("[ingest/tokens] stored token envelope missing `access`");
  }
  const env: ProviderTokenEnvelope = { access: obj.access };
  if (typeof obj.refresh === "string" && obj.refresh) env.refresh = obj.refresh;
  if (typeof obj.expiresAt === "string" && obj.expiresAt) env.expiresAt = obj.expiresAt;
  return env;
}
