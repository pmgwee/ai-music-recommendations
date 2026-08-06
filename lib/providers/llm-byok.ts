/**
 * BYOK LlmProvider — multi-provider adapters + the factory the routes call.
 *
 * The engine consumes the `LlmProvider` seam (spec §3/§8 — `vibe.ts` /
 * `tags.ts` inject it). This module is the app-side impl that wires a USER's
 * own API key (OpenAI / Anthropic / Gemini / GLM, stored encrypted in
 * `user_llm_keys`) into that seam. It replaces `createGlmLlm()` as the default
 * LLM source: routes call `await createByokLlm(supabase, user.id)` and either
 * get a provider configured with the user's key, or `null` (engine degrades —
 * `parseVibe`/`tagBatch` skip the LLM step and fall back to co-occurrence).
 *
 * Adapter discipline:
 *   - Each adapter is a thin `fetch` wrapper around the provider's chat
 *     endpoint. NO new SDK dependency (the engine must stay pure, and BYOK
 *     keeps the surface uniform + auditable). The server-GLM `openai` SDK
 *     path (SP-0, `llm-glm.ts`) stays for the dev integration script only.
 *   - Each adapter THROWS on non-2xx (the engine's callers catch + degrade).
 *   - The four default models (D1) match SP-2's spec; env overrides exist for
 *     every provider so deploy-time model swaps don't require code changes.
 *
 * Provider quirks worth pinning down (this is where adapters diverge):
 *   - OpenAI + GLM share `/chat/completions` and accept `system` inline in
 *     `messages`. GLM's `thinking: {type:"disabled"}` toggle is non-standard
 *     and BYOK-skip — it's a determinism optimization, not a correctness need.
 *   - Anthropic's Messages API takes `system` as a top-level field (NOT in
 *     `messages`, which is user/assistant only), requires `max_tokens`, and
 *     auths via `x-api-key` + `anthropic-version`. There's no JSON mode —
 *     we append "Respond as JSON." to the system prompt when `json: true`.
 *     `thinkingDisabled` is the default (Anthropic doesn't do reasoning tokens
 *     unless extended thinking is on), so the flag is ignored.
 *   - Gemini keys go in the query string (`?key=...`), not a header. Roles
 *     are `user` and `model` (NOT `assistant`); system content moves to
 *     `systemInstruction`. JSON mode is `responseMimeType: "application/json"`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmProvider } from "@music-ai/engine";
import type { Database } from "../supabase/types";
import {
  getLlmKey,
  listProviders,
  isSupportedProvider,
  type SupportedProvider,
} from "../byok/store";

type ServerClient = SupabaseClient<Database>;
type ChatOpts = Parameters<LlmProvider["chat"]>[0];
type ChatMessage = ChatOpts["messages"][number];

// ---------------------------------------------------------------------------
// NullLlm — a no-op LlmProvider used as the degrade path when the user has no
// BYOK key. `isConfigured()` returns false so the engine's `tagBatch` and
// `parseVibe` guards skip the LLM step entirely (co-occurrence / null intent),
// and `chat()` is never reached in practice — but returns a defensive "[]"
// (valid JSON, empty parse) in case a caller forgets the guard. This keeps the
// engine's call sites unchanged: they always receive a real `LlmProvider`.
// ---------------------------------------------------------------------------
export const NullLlm: LlmProvider = {
  isConfigured() {
    return false;
  },
  async chat() {
    return "[]";
  },
};

// ---------------------------------------------------------------------------
// Default endpoints + models (D1). Env overrides per provider let ops swap a
// model without a redeploy.
// ---------------------------------------------------------------------------
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GLM_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const GEMINI_DEFAULT_MODEL = "gemini-2.0-flash";
const GLM_DEFAULT_MODEL = "glm-4-flash";

/** Sensible default when the engine calls `chat` without `maxTokens`. Anthropic
 *  REQUIRES `max_tokens` (it's the only provider that does), so every adapter
 *  accepts the same default to keep the call shape uniform. */
const DEFAULT_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// fetch helper — uniform error handling across adapters. Throws on non-2xx so
// the engine's try/catch around `chat` degrades. Returns the parsed JSON body
// (each adapter extracts its own shape).
// ---------------------------------------------------------------------------
async function postJSON(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore — body already consumed / not json */
    }
    throw new Error(
      `[byok] ${url} → HTTP ${res.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
    );
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter — covers OpenAI AND GLM/ZAI (same /chat/completions
// contract). The only difference is the baseURL + default model.
// ---------------------------------------------------------------------------
export interface OpenAICompatibleOptions {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function createOpenAICompatibleLlm(
  opts: OpenAICompatibleOptions,
): LlmProvider {
  const { apiKey, baseURL, model } = opts;
  return {
    isConfigured() {
      return Boolean(apiKey);
    },
    async chat(chatOpts: ChatOpts): Promise<string> {
      const body: Record<string, unknown> = {
        model,
        messages: chatOpts.messages,
        temperature: chatOpts.temperature ?? 0,
      };
      if (chatOpts.maxTokens) body.max_tokens = chatOpts.maxTokens;
      else body.max_tokens = DEFAULT_MAX_TOKENS;
      if (chatOpts.json) body.response_format = { type: "json_object" };

      const json = (await postJSON(
        `${baseURL}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        body,
      )) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API adapter.
// ---------------------------------------------------------------------------
export interface AnthropicOptions {
  apiKey: string;
  /** Base URL incl. `/v1` (default `https://api.anthropic.com/v1`). */
  baseURL?: string;
  model: string;
}

export function createAnthropicLlm(opts: AnthropicOptions): LlmProvider {
  const { apiKey, baseURL = ANTHROPIC_BASE_URL, model } = opts;
  return {
    isConfigured() {
      return Boolean(apiKey);
    },
    async chat(chatOpts: ChatOpts): Promise<string> {
      // Anthropic takes `system` OUT of messages. Concatenate every system
      // message (in order) into the top-level `system` field; everything else
      // (user/assistant) is forwarded as-is.
      const systemParts: string[] = [];
      const convo: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const m of chatOpts.messages) {
        if (m.role === "system") {
          systemParts.push(m.content);
        } else {
          convo.push({ role: m.role, content: m.content });
        }
      }
      if (chatOpts.json) {
        // Anthropic has no native JSON mode; the instruction is the contract.
        systemParts.push("Respond as JSON only.");
      }

      const body: Record<string, unknown> = {
        model,
        max_tokens: chatOpts.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: chatOpts.temperature ?? 0,
        messages: convo,
      };
      if (systemParts.length > 0) body.system = systemParts.join("\n\n");

      const json = (await postJSON(
        `${baseURL}/messages`,
        {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      )) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      // Anthropic returns content blocks; find the first text block (tool_use
      // blocks etc. are skipped — vibe/tags only emit text).
      const block = json.content?.find((b) => b.type === "text" || typeof b.text === "string");
      return block?.text ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini generateContent adapter.
// ---------------------------------------------------------------------------
export interface GeminiOptions {
  apiKey: string;
  /** Base URL (default `https://generativelanguage.googleapis.com/v1beta`). */
  baseURL?: string;
  model: string;
}

export function createGeminiLlm(opts: GeminiOptions): LlmProvider {
  const {
    apiKey,
    baseURL = GEMINI_BASE_URL,
    model,
  } = opts;
  return {
    isConfigured() {
      return Boolean(apiKey);
    },
    async chat(chatOpts: ChatOpts): Promise<string> {
      // Gemini roles are `user` and `model` (NOT `assistant`); system content
      // moves to `systemInstruction`.
      const contents: Array<{
        role: "user" | "model";
        parts: Array<{ text: string }>;
      }> = [];
      const systemParts: string[] = [];
      for (const m of chatOpts.messages) {
        if (m.role === "system") {
          systemParts.push(m.content);
        } else {
          contents.push({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          });
        }
      }
      if (chatOpts.json) {
        systemParts.push("Respond as JSON only.");
      }

      const generationConfig: Record<string, unknown> = {
        temperature: chatOpts.temperature ?? 0,
      };
      if (chatOpts.maxTokens) generationConfig.maxOutputTokens = chatOpts.maxTokens;
      if (chatOpts.json) generationConfig.responseMimeType = "application/json";

      const body: Record<string, unknown> = { contents, generationConfig };
      if (systemParts.length > 0) {
        // systemInstruction follows the same `parts: [{text}]` shape (a string
        // also works, but the parts form is what the SDK + docs canonically use).
        body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
      }

      const url = `${baseURL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const json = (await postJSON(url, {}, body)) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// createByokLlm — load the user's most-recently-set key + return the matching
// adapter. Null when the user has no key (engine degrades) or the active key
// can't be decrypted (encryption root key misconfigured / row corrupted).
// ---------------------------------------------------------------------------

/**
 * Build the LlmProvider for a single provider name + plaintext key. Exported
 * for tests + for routes that already know which provider to use (e.g. an
 * explicit provider-switch API later).
 */
export function buildByokAdapter(
  provider: SupportedProvider,
  apiKey: string,
): LlmProvider {
  switch (provider) {
    case "openai":
      return createOpenAICompatibleLlm({
        apiKey,
        baseURL: OPENAI_BASE_URL,
        model: process.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
      });
    case "glm":
      return createOpenAICompatibleLlm({
        apiKey,
        // Same ZAI_BASE_URL override convention as llm-glm.ts (SP-0).
        baseURL: process.env.ZAI_BASE_URL || GLM_DEFAULT_BASE_URL,
        model: process.env.GLM_MODEL || GLM_DEFAULT_MODEL,
      });
    case "anthropic":
      return createAnthropicLlm({
        apiKey,
        model: process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
      });
    case "gemini":
      return createGeminiLlm({
        apiKey,
        model: process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL,
      });
    default: {
      // Exhaustiveness guard — TypeScript narrows `provider` to never here.
      // If a new SUPPORTED_PROVIDERS entry forgets to add a case, this throws
      // at the call site rather than silently returning an unconfigured LLM.
      const exhaustive: never = provider;
      throw new Error(`[byok] unsupported provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * Resolve the signed-in user's BYOK LlmProvider.
 *
 * @returns the adapter for their most-recently-set provider key, or `null` if
 *          they have no key / the key can't be decrypted. Never throws (the
 *          engine's callers expect null-or-configured; an unexpected throw
 *          would surface as a 500 in the shelf build).
 */
export async function createByokLlm(
  supabase: ServerClient,
  userId: string,
): Promise<LlmProvider | null> {
  // listProviders is most-recently-set first; the user "switches" provider by
  // re-saving that provider's key (its updated_at bumps and it sorts first).
  const providers = await listProviders(supabase, userId);
  if (providers.length === 0) return null;

  const providerName = providers[0];
  if (!isSupportedProvider(providerName)) return null;

  const apiKey = await getLlmKey(supabase, userId, providerName);
  if (!apiKey) return null;

  return buildByokAdapter(providerName, apiKey);
}
