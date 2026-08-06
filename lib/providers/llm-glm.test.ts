/**
 * Task 13 — GLM LlmProvider.
 *
 * Mocks the `openai` module so `new OpenAI(...)` returns a fake whose
 * `chat.completions.create` resolves to a canned completion — no network.
 *
 * Verifies:
 *   1. `isConfigured()` reflects `process.env.ZAI_API_KEY`.
 *   2. `chat()` returns the assistant content from the mocked response.
 *   3. The OpenAI client is built with the Z.ai default base URL + glm-5.2
 *      model, and that `ZAI_BASE_URL` / `GLM_MODEL` overrides flow through.
 *   4. `max_tokens` / `response_format` / `thinking` are set only when their
 *      respective opts are present (parity with the ported `zai.ts` body).
 *   5. Empty `choices` degrades to "" (the engine's vibe/tags callers already
 *      wrap `chat` in try/catch and degrade on throw too).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LlmProvider } from "@music-ai/engine";

// vi.hoisted so the refs exist before vi.mock's factory runs.
const ctor = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  // `import OpenAI from "openai"` resolves to this default export; each
  // `new OpenAI(...)` returns an instance whose create chain is stubbed.
  // Regular function (not arrow) so it can be invoked with `new`.
  default: ctor.mockImplementation(function () {
    return { chat: { completions: { create } } };
  }),
}));

import { createGlmLlm } from "./llm-glm";

describe("createGlmLlm", () => {
  const orig = {
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ZAI_BASE_URL: process.env.ZAI_BASE_URL,
    GLM_MODEL: process.env.GLM_MODEL,
  };

  beforeEach(() => {
    ctor.mockClear();
    create.mockReset();
    create.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    delete process.env.ZAI_API_KEY;
    delete process.env.ZAI_BASE_URL;
    delete process.env.GLM_MODEL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k as keyof typeof orig];
      else (process.env[k as keyof typeof orig] as string) = v;
    }
  });

  it("isConfigured() is false when ZAI_API_KEY is unset", () => {
    const llm = createGlmLlm();
    expect(llm.isConfigured()).toBe(false);
  });

  it("isConfigured() is true when ZAI_API_KEY is set", () => {
    process.env.ZAI_API_KEY = "test-key";
    const llm = createGlmLlm();
    expect(llm.isConfigured()).toBe(true);
  });

  it("satisfies the LlmProvider seam contract", () => {
    process.env.ZAI_API_KEY = "test-key";
    const llm: LlmProvider = createGlmLlm();
    expect(typeof llm.isConfigured).toBe("function");
    expect(typeof llm.chat).toBe("function");
  });

  it("chat() returns the mocked assistant content", async () => {
    process.env.ZAI_API_KEY = "test-key";
    const llm = createGlmLlm();
    const out = await llm.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out).toBe("ok");
  });

  it("builds the client with the Z.ai default base URL + glm-5.2 model", async () => {
    process.env.ZAI_API_KEY = "test-key";
    const llm = createGlmLlm();
    await llm.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.z.ai/api/coding/paas/v4",
        apiKey: "test-key",
      }),
    );
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("glm-5.2");
    expect(params.stream).toBe(false);
    expect(params.temperature).toBe(0); // default when undefined
  });

  it("honors ZAI_BASE_URL + GLM_MODEL overrides", async () => {
    process.env.ZAI_API_KEY = "test-key";
    process.env.ZAI_BASE_URL = "https://custom.example/v4";
    process.env.GLM_MODEL = "glm-custom";
    const llm = createGlmLlm();
    await llm.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://custom.example/v4",
        apiKey: "test-key",
      }),
    );
    expect(create.mock.calls[0][0].model).toBe("glm-custom");
  });

  it("sets max_tokens, response_format, and thinking when their opts are present", async () => {
    process.env.ZAI_API_KEY = "test-key";
    const llm = createGlmLlm();
    await llm.chat({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      maxTokens: 500,
      json: true,
      thinkingDisabled: true,
    });
    const params = create.mock.calls[0][0];
    expect(params.max_tokens).toBe(500);
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(params.temperature).toBe(0);
  });

  it("omits max_tokens/response_format/thinking by default", async () => {
    process.env.ZAI_API_KEY = "test-key";
    const llm = createGlmLlm();
    await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    const params = create.mock.calls[0][0];
    expect(params.max_tokens).toBeUndefined();
    expect(params.response_format).toBeUndefined();
    expect(params.thinking).toBeUndefined();
  });

  it("returns empty string when choices is empty", async () => {
    process.env.ZAI_API_KEY = "test-key";
    create.mockResolvedValueOnce({ choices: [] });
    const llm = createGlmLlm();
    const out = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("");
  });
});
