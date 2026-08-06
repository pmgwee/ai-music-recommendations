/**
 * GLM (Z.ai) implementation of the engine's `LlmProvider` seam.
 *
 * The engine's `vibe.ts` / `tags.ts` consume `LlmProvider` via dependency
 * injection (spec §3/§8) — this is the app-side impl that wires the OpenAI-
 * compatible Z.ai client into that seam. It replaces the engine's old direct
 * `lib/ai/zai.ts` import.
 *
 * Ported from `subscription-agent/lib/ai/zai.ts`:
 *   - base URL defaults to the coding endpoint; `ZAI_BASE_URL` overrides.
 *   - model defaults to `glm-5.2` (the 1M-context variant); `GLM_MODEL` overrides.
 *   - Z.ai's non-standard `thinking: { type: "disabled" }` toggle disables
 *     reasoning tokens (fast/deterministic — used for classification/extraction).
 *   - `response_format: { type: "json_object" }` for `json: true`.
 *
 * Keys are SERVER-ONLY — never prefixed with NEXT_PUBLIC_. `openai` is an
 * app-level dependency (the engine stays pure; spec SC1).
 */
import OpenAI from "openai";
import type { LlmProvider } from "@music-ai/engine";

const DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_MODEL = "glm-5.2";

/**
 * One non-streaming chat completion per call. Throws on API error so the
 * engine's callers (`parseVibe` / `tagBatch`) can catch + degrade — they wrap
 * every `chat` call in try/catch and fall back to a deterministic path.
 */
export function createGlmLlm(): LlmProvider {
  return {
    isConfigured(): boolean {
      return Boolean(process.env.ZAI_API_KEY);
    },

    async chat(opts) {
      const apiKey = process.env.ZAI_API_KEY;
      if (!apiKey) throw new Error("ZAI_API_KEY is not set");

      const client = new OpenAI({
        baseURL: process.env.ZAI_BASE_URL || DEFAULT_BASE_URL,
        apiKey,
      });

      // Non-streaming so the return narrows to ChatCompletion (→ .choices).
      // The `thinking` field is Z.ai-specific (non-standard for the OpenAI
      // SDK), added via an intersection so it's typed locally + serialized
      // into the request body.
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
        thinking?: { type: string };
      } = {
        model: process.env.GLM_MODEL || DEFAULT_MODEL,
        messages: opts.messages,
        temperature: opts.temperature ?? 0,
        stream: false,
      };
      if (opts.maxTokens) params.max_tokens = opts.maxTokens;
      if (opts.json) params.response_format = { type: "json_object" };
      if (opts.thinkingDisabled) params.thinking = { type: "disabled" };

      const res = await client.chat.completions.create(params);
      return res.choices[0]?.message?.content ?? "";
    },
  };
}
