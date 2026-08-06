/**
 * PKCE verifier + state cookie helper for the import OAuth flows.
 *
 * The PKCE `code_verifier` is the secret that proves the token-exchange
 * request came from the same browser that started the auth-URL redirect.
 * Storing it anywhere JS-readable defeats the purpose (a malicious script
 * could read it and complete the exchange itself). So we store it in an
 * **httponly** cookie, **HMAC-signed** so a tampered value is rejected at the
 * callback, **samesite=lax** so it survives the OAuth provider's top-level
 * redirect back to us, and **short-lived** (10 min — plenty for the OAuth
 * handshake, short enough to bound replay).
 *
 * One cookie per provider (so connecting YouTube then Spotify doesn't clobber
 * each other's in-flight verifier). The cookie value is
 * `base64url(JSON({state, codeVerifier})).base64url(HMAC)`; verification
 * recomputes the HMAC over the payload and rejects mismatches in constant
 * time.
 *
 * The HMAC key: derived from `LLM_KEY_ENCRYPTION_KEY` (the same server root
 * key BYOK + provider_tokens use) so no new env var is needed. A separate
 * `INGEST_COOKIE_KEY` could be wired in future if rotation requirements
 * diverge — for now one root key is easier to manage and the failure modes
 * (compromised root key compromises everything anyway) coincide.
 */
import { webcrypto } from "node:crypto";
import { cookies } from "next/headers";

const SUBTLE = webcrypto.subtle;

/** Cookie lifespan — long enough for the OAuth handshake, short for safety. */
export const PKCE_COOKIE_MAX_AGE_SEC = 10 * 60;

/**
 * Sign a payload with an HMAC-SHA256 derived from the root key. Returns the
 * base64url tag. Throws fail-closed in production when no key is set (the dev
 * fallback the crypto module uses for encryption is NOT appropriate for
 * signing because a dev box signing a cookie that production rejects is
 * preferable to a dev-fallback forging validity).
 */
async function hmacSign(payload: string): Promise<string> {
  const keyHex = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (!keyHex && process.env.NODE_ENV === "production") {
    throw new Error(
      "[ingest/pkce-cookie] LLM_KEY_ENCRYPTION_KEY not set — production " +
        "refuses to sign PKCE cookies without a root key.",
    );
  }
  // Dev/test fallback — matches crypto.ts's stance (warns once). Same fixed
  // key so the round-trip is deterministic in tests.
  const key = keyHex ?? "0".repeat(64);
  const keyBytes = hexToBytes(key);
  const cryptoKey = await SUBTLE.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tag = await SUBTLE.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(tag));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/** Constant-time string equality (avoids timing-side-channel forging). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The cookie name for a given provider. */
export function pkceCookieName(provider: string): string {
  return `pkce_${provider}`;
}

export interface PkceCookiePayload {
  state: string;
  codeVerifier: string;
  /** Optional landing path after the OAuth callback. The connect route sets
   *  it; the callback reads it (defensively) to redirect back. Signed with the
   *  same HMAC so it can't be tampered with post-issuance. */
  next?: string;
}

/**
 * Set the signed PKCE cookie for a provider. Called by the connect route after
 * generating `codeVerifier` + `state`. `cookies()` from `next/headers` is only
 * callable in a Server Action or Route Handler — both connect + callback are
 * route handlers, so this is safe.
 */
export async function setPkceCookie(
  provider: string,
  payload: PkceCookiePayload,
): Promise<void> {
  const cookieStore = await cookies();
  const body = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const tag = await hmacSign(body);
  cookieStore.set(pkceCookieName(provider), `${body}.${tag}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: PKCE_COOKIE_MAX_AGE_SEC,
    path: "/",
  });
}

/**
 * Read + verify the PKCE cookie for a provider. Returns null if absent or the
 * HMAC doesn't verify (tampered / signed by a different root key). Used by the
 * callback route to recover the verifier it stashed 10 minutes ago.
 */
export async function getPkceCookie(
  provider: string,
): Promise<PkceCookiePayload | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(pkceCookieName(provider))?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const tag = raw.slice(dot + 1);

  const expectedTag = await hmacSign(body);
  if (!timingSafeEqual(tag, expectedTag)) return null;

  try {
    const json = new TextDecoder().decode(base64UrlToBytes(body));
    const parsed = JSON.parse(json) as Partial<PkceCookiePayload>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.codeVerifier !== "string"
    ) {
      return null;
    }
    return { state: parsed.state, codeVerifier: parsed.codeVerifier };
  } catch {
    return null;
  }
}

/** Clear the PKCE cookie for a provider. Called by the callback after the
 *  verifier has been consumed (single-use — never accepted twice). */
export async function clearPkceCookie(provider: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(pkceCookieName(provider));
}
