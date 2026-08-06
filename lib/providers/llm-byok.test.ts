/**
 * BYOK LlmProvider adapters + factory.
 *
 * Two layers of mocking:
 *   - Global `fetch` is stubbed (`vi.stubGlobal`) so each adapter's request
 *     shape (URL / headers / body) is asserted + the response extraction is
 *     exercised — no network, no SDK.
 *   - `../byok/store` is mocked so `createByokLlm` can be steered through the
 *     null / single-provider / multi-provider branches without a DB.
 *
 * The store module has its own dedicated test for SQL-shape correctness; here
 * we only verify the adapter factory + adapter request/response behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LlmProvider } from "@music-ai/engine";

// ---------------------------------------------------------------------------
// Mock the store — `createByokLlm` calls listProviders + getLlmKey; both are
// controlled per-test via the holder below.
// ---------------------------------------------------------------------------
import type { Mock } from "vitest";
const storeMock = vi.hoisted(() => ({
  listProviders: vi.fn() as Mock,
  getLlmKey: vi.fn() as Mock,
}));

vi.mock("../byok/store", () => ({
  listProviders: (...args: never[]) => storeMock.listProviders(...args),
  getLlmKey: (...args: never[]) => storeMock.getLlmKey(...args),
  isSupportedProvider: (name: string) =>
    ["openai", "anthropic", "gemini", "glm"].includes(name),
  SUPPORTED_PROVIDERS: ["openai", "anthropic", "gemini", "glm"],
}));

import {
  createOpenAICompatibleLlm,
  createAnthropicLlm,
  createGeminiLlm,
  createByokLlm,
  buildByokAdapter,
} from "./llm-byok";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------
type FetchCall = {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
};

function makeResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => payload,
  };
}

/** Capture each fetch call + queue canned responses (FIFO). */
function installFetchMock() {
  const calls: FetchCall[] = [];
  const queue: ReturnType<typeof makeResponse>[] = [];
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => {
    calls.push({
      url: _url,
      init: {
        method: _init?.method,
        headers: (_init?.headers as Record<string, string>) ?? {},
        body: _init?.body as string | undefined,
      },
    });
    const next = queue.shift();
    if (!next) throw new Error("test forgot to queue a fetch response");
    return next;
  });
  vi.stubGlobal("fetch", fetchFn);
  return {
    calls,
    queueResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
      queue.push(makeResponse(body, init));
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
      fetchFn.mockClear();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("OpenAI-compatible adapter (covers OpenAI + GLM)", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("isConfigured() reflects whether an apiKey was provided", () => {
    expect(createOpenAICompatibleLlm({ apiKey: "", baseURL: "x", model: "y" }).isConfigured()).toBe(false);
    expect(createOpenAICompatibleLlm({ apiKey: "k", baseURL: "x", model: "y" }).isConfigured()).toBe(true);
  });

  it("satisfies the LlmProvider seam contract", () => {
    const llm: LlmProvider = createOpenAICompatibleLlm({
      apiKey: "k",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
    expect(typeof llm.isConfigured).toBe("function");
    expect(typeof llm.chat).toBe("function");
  });

  it("POSTs {model, messages, temperature, max_tokens} with Bearer auth + extracts choices[0].message.content", async () => {
    fetchMock.queueResponse({
      choices: [{ message: { content: "openai-ok" } }],
    });
    const llm = createOpenAICompatibleLlm({
      apiKey: "sk-test",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    const out = await llm.chat({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.1,
      maxTokens: 250,
    });

    expect(out).toBe("openai-ok");
    const call = fetchMock.calls[0];
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.authorization).toBe("Bearer sk-test");
    expect(call.init.headers?.["content-type"]).toBe("application/json");
    const body = JSON.parse(call.init.body ?? "{}");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(250);
    expect(body.response_format).toBeUndefined();
  });

  it("defaults temperature to 0 + max_tokens to 1024 when omitted, and sets response_format when json:true", async () => {
    fetchMock.queueResponse({ choices: [{ message: { content: "x" } }] });
    const llm = createOpenAICompatibleLlm({
      apiKey: "k",
      baseURL: "https://api.openai.com/v1",
      model: "m",
    });
    await llm.chat({ messages: [{ role: "user", content: "x" }], json: true });

    const body = JSON.parse(fetchMock.calls[0].init.body ?? "{}");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(1024);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("targets the GLM base URL + model when so configured (OpenAI-compatible shape)", async () => {
    fetchMock.queueResponse({ choices: [{ message: { content: "glm-ok" } }] });
    const llm = createOpenAICompatibleLlm({
      apiKey: "glm-key",
      baseURL: "https://api.z.ai/api/paas/v4",
      model: "glm-4-flash",
    });
    const out = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("glm-ok");
    expect(fetchMock.calls[0].url).toBe(
      "https://api.z.ai/api/paas/v4/chat/completions",
    );
    expect(fetchMock.calls[0].init.headers?.authorization).toBe(
      "Bearer glm-key",
    );
    expect(JSON.parse(fetchMock.calls[0].init.body ?? "{}").model).toBe(
      "glm-4-flash",
    );
  });

  it("returns empty string when choices is empty", async () => {
    fetchMock.queueResponse({ choices: [] });
    const llm = createOpenAICompatibleLlm({
      apiKey: "k",
      baseURL: "https://api.openai.com/v1",
      model: "m",
    });
    expect(await llm.chat({ messages: [{ role: "user", content: "x" }] })).toBe("");
  });

  it("throws on non-2xx (engine callers catch + degrade)", async () => {
    fetchMock.queueResponse({ error: "bad" }, { ok: false, status: 401 });
    const llm = createOpenAICompatibleLlm({
      apiKey: "k",
      baseURL: "https://api.openai.com/v1",
      model: "m",
    });
    await expect(
      llm.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

// ---------------------------------------------------------------------------
describe("Anthropic adapter", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs to /messages with x-api-key + anthropic-version headers; system moves top-level", async () => {
    fetchMock.queueResponse({
      content: [{ type: "text", text: "anthropic-ok" }],
    });
    const llm = createAnthropicLlm({ apiKey: "sk-ant", model: "claude-haiku-4-5-20251001" });

    const out = await llm.chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "ping" },
      ],
      temperature: 0.2,
      maxTokens: 300,
    });

    expect(out).toBe("anthropic-ok");
    const call = fetchMock.calls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["x-api-key"]).toBe("sk-ant");
    expect(call.init.headers?.["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(call.init.body ?? "{}");
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(300);
  });

  it("requires max_tokens (defaults to 1024 when omitted)", async () => {
    fetchMock.queueResponse({
      content: [{ type: "text", text: "ok" }],
    });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m" });
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    expect(JSON.parse(fetchMock.calls[0].init.body ?? "{}").max_tokens).toBe(1024);
  });

  it("concatenates multiple system messages in order", async () => {
    fetchMock.queueResponse({ content: [{ type: "text", text: "ok" }] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m" });
    await llm.chat({
      messages: [
        { role: "system", content: "rule A" },
        { role: "system", content: "rule B" },
        { role: "user", content: "go" },
      ],
    });
    const body = JSON.parse(fetchMock.calls[0].init.body ?? "{}");
    expect(body.system).toBe("rule A\n\nrule B");
    expect(body.messages).toEqual([{ role: "user", content: "go" }]);
  });

  it("appends 'Respond as JSON only.' to system when json:true (Anthropic has no native JSON mode)", async () => {
    fetchMock.queueResponse({ content: [{ type: "text", text: "ok" }] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m" });
    await llm.chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "x" },
      ],
      json: true,
    });
    const body = JSON.parse(fetchMock.calls[0].init.body ?? "{}");
    expect(body.system).toBe("be brief\n\nRespond as JSON only.");
  });

  it("omits system entirely when no system message is present", async () => {
    fetchMock.queueResponse({ content: [{ type: "text", text: "ok" }] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m" });
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    const body = JSON.parse(fetchMock.calls[0].init.body ?? "{}");
    expect(body.system).toBeUndefined();
  });

  it("extracts the first text block (skips tool_use)", async () => {
    fetchMock.queueResponse({
      content: [
        { type: "tool_use" },
        { type: "text", text: "hello" },
      ],
    });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m" });
    expect(await llm.chat({ messages: [{ role: "user", content: "x" }] })).toBe(
      "hello",
    );
  });

  it("returns empty string when content is empty", async () => {
    fetchMock.queueResponse({ content: [] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m" });
    expect(await llm.chat({ messages: [{ role: "user", content: "x" }] })).toBe("");
  });

  it("honors a custom baseURL (proxy / enterprise gateway)", async () => {
    fetchMock.queueResponse({ content: [{ type: "text", text: "ok" }] });
    const llm = createAnthropicLlm({
      apiKey: "k",
      model: "m",
      baseURL: "https://proxy.example/v1",
    });
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    expect(fetchMock.calls[0].url).toBe("https://proxy.example/v1/messages");
  });

  it("throws on non-2xx", async () => {
    fetchMock.queueResponse({ error: "auth" }, { ok: false, status: 401 });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m" });
    await expect(
      llm.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

// ---------------------------------------------------------------------------
describe("Gemini adapter", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("PUTs the key in the query string (?key=...), never in a header", async () => {
    fetchMock.queueResponse({
      candidates: [{ content: { parts: [{ text: "gemini-ok" }] } }],
    });
    const llm = createGeminiLlm({ apiKey: "gem-key", model: "gemini-2.0-flash" });
    const out = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("gemini-ok");

    const call = fetchMock.calls[0];
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gem-key",
    );
    expect(call.init.method).toBe("POST");
    // No authorization header — the key is in the URL.
    expect(call.init.headers?.authorization).toBeUndefined();
    expect(call.init.headers?.["x-api-key"]).toBeUndefined();
  });

  it("maps assistant → model, system → systemInstruction, and forwards generationConfig", async () => {
    fetchMock.queueResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    const llm = createGeminiLlm({ apiKey: "k", model: "m" });
    await llm.chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "follow up" },
      ],
      temperature: 0.3,
      maxTokens: 400,
    });

    const body = JSON.parse(fetchMock.calls[0].init.body ?? "{}");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ text: "a" }] },
      { role: "user", parts: [{ text: "follow up" }] },
    ]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(body.generationConfig.temperature).toBe(0.3);
    expect(body.generationConfig.maxOutputTokens).toBe(400);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it("sets responseMimeType=application/json when json:true + appends the JSON instruction to systemInstruction", async () => {
    fetchMock.queueResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    const llm = createGeminiLlm({ apiKey: "k", model: "m" });
    await llm.chat({
      messages: [
        { role: "system", content: "rule" },
        { role: "user", content: "x" },
      ],
      json: true,
    });
    const body = JSON.parse(fetchMock.calls[0].init.body ?? "{}");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "rule\n\nRespond as JSON only." }],
    });
  });

  it("omits systemInstruction when no system message is present", async () => {
    fetchMock.queueResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    const llm = createGeminiLlm({ apiKey: "k", model: "m" });
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    const body = JSON.parse(fetchMock.calls[0].init.body ?? "{}");
    expect(body.systemInstruction).toBeUndefined();
  });

  it("URL-encodes the model name", async () => {
    fetchMock.queueResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    const llm = createGeminiLlm({
      apiKey: "k",
      model: "gemini-2.0-flash-lite-preview-08-27",
    });
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    expect(fetchMock.calls[0].url).toContain(
      "models/gemini-2.0-flash-lite-preview-08-27:generateContent",
    );
  });

  it("returns empty string when candidates is empty", async () => {
    fetchMock.queueResponse({ candidates: [] });
    const llm = createGeminiLlm({ apiKey: "k", model: "m" });
    expect(await llm.chat({ messages: [{ role: "user", content: "x" }] })).toBe("");
  });

  it("throws on non-2xx", async () => {
    fetchMock.queueResponse({ error: "x" }, { ok: false, status: 400 });
    const llm = createGeminiLlm({ apiKey: "k", model: "m" });
    await expect(
      llm.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/HTTP 400/);
  });
});

// ---------------------------------------------------------------------------
describe("buildByokAdapter (factory per provider name)", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  // Snapshot env so each test can mutate OPENAI_MODEL / GLM_MODEL etc without
  // leaking into siblings. Using vi.stubEnv would also work but the snapshot
  // is easier to reason about across many keys.
  const envKeys = [
    "OPENAI_MODEL",
    "GLM_MODEL",
    "ANTHROPIC_MODEL",
    "GEMINI_MODEL",
    "ZAI_BASE_URL",
  ];
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) origEnv[k] = process.env[k];
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("openai → OpenAI-compatible adapter hitting api.openai.com with default model gpt-4o-mini", async () => {
    fetchMock.queueResponse({ choices: [{ message: { content: "ok" } }] });
    const llm = buildByokAdapter("openai", "sk-o");
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    expect(fetchMock.calls[0].url).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(JSON.parse(fetchMock.calls[0].init.body ?? "{}").model).toBe(
      "gpt-4o-mini",
    );
  });

  it("glm → OpenAI-compatible adapter hitting z.ai with default model glm-4-flash", async () => {
    fetchMock.queueResponse({ choices: [{ message: { content: "ok" } }] });
    const llm = buildByokAdapter("glm", "glm-k");
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    expect(fetchMock.calls[0].url).toBe(
      "https://api.z.ai/api/paas/v4/chat/completions",
    );
    expect(JSON.parse(fetchMock.calls[0].init.body ?? "{}").model).toBe(
      "glm-4-flash",
    );
  });

  it("anthropic → Anthropic adapter with default model claude-haiku-4-5-20251001", async () => {
    fetchMock.queueResponse({ content: [{ type: "text", text: "ok" }] });
    const llm = buildByokAdapter("anthropic", "sk-ant");
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    expect(JSON.parse(fetchMock.calls[0].init.body ?? "{}").model).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("gemini → Gemini adapter with default model gemini-2.0-flash", async () => {
    fetchMock.queueResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    const llm = buildByokAdapter("gemini", "g-k");
    await llm.chat({ messages: [{ role: "user", content: "x" }] });
    expect(fetchMock.calls[0].url).toContain(
      "/models/gemini-2.0-flash:generateContent",
    );
  });

  it("OPENAI_MODEL / GLM_MODEL / ANTHROPIC_MODEL / GEMINI_MODEL env vars override defaults", async () => {
    process.env.OPENAI_MODEL = "gpt-4o";
    process.env.GLM_MODEL = "glm-4-plus";
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4";
    process.env.GEMINI_MODEL = "gemini-1.5-pro";

    // openai
    fetchMock.queueResponse({ choices: [{ message: { content: "ok" } }] });
    await buildByokAdapter("openai", "k").chat({
      messages: [{ role: "user", content: "x" }],
    });
    expect(JSON.parse(fetchMock.calls[0].init.body ?? "{}").model).toBe(
      "gpt-4o",
    );

    // glm
    fetchMock.queueResponse({ choices: [{ message: { content: "ok" } }] });
    await buildByokAdapter("glm", "k").chat({
      messages: [{ role: "user", content: "x" }],
    });
    expect(JSON.parse(fetchMock.calls[1].init.body ?? "{}").model).toBe(
      "glm-4-plus",
    );

    // anthropic
    fetchMock.queueResponse({ content: [{ type: "text", text: "ok" }] });
    await buildByokAdapter("anthropic", "k").chat({
      messages: [{ role: "user", content: "x" }],
    });
    expect(JSON.parse(fetchMock.calls[2].init.body ?? "{}").model).toBe(
      "claude-sonnet-4",
    );

    // gemini
    fetchMock.queueResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    await buildByokAdapter("gemini", "k").chat({
      messages: [{ role: "user", content: "x" }],
    });
    expect(fetchMock.calls[3].url).toContain(
      "/models/gemini-1.5-pro:generateContent",
    );
  });

  it("ZAI_BASE_URL overrides the GLM base URL", async () => {
    process.env.ZAI_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
    fetchMock.queueResponse({ choices: [{ message: { content: "ok" } }] });
    await buildByokAdapter("glm", "k").chat({
      messages: [{ role: "user", content: "x" }],
    });
    expect(fetchMock.calls[0].url).toBe(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
  });
});

// ---------------------------------------------------------------------------
describe("createByokLlm (factory: routes use this)", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    storeMock.listProviders.mockReset();
    storeMock.getLlmKey.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null when the user has no configured provider", async () => {
    storeMock.listProviders.mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createByokLlm({} as any, "user-1");
    expect(out).toBeNull();
    expect(storeMock.listProviders).toHaveBeenCalled();
    // No key fetch when there's no provider to look up.
    expect(storeMock.getLlmKey).not.toHaveBeenCalled();
  });

  it("returns null when getLlmKey returns null (encryption not configured / corrupted row)", async () => {
    storeMock.listProviders.mockResolvedValue(["openai"]);
    storeMock.getLlmKey.mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createByokLlm({} as any, "user-1");
    expect(out).toBeNull();
    expect(storeMock.getLlmKey).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "openai",
    );
  });

  it("picks the MOST-RECENTLY-SET provider (listProviders[0]) — not the first by name", async () => {
    storeMock.listProviders.mockResolvedValue(["anthropic", "openai"]); // anthropic newest
    storeMock.getLlmKey.mockResolvedValue("sk-ant");
    fetchMock.queueResponse({ content: [{ type: "text", text: "ok" }] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llm = await createByokLlm({} as any, "user-1");
    expect(llm).not.toBeNull();
    await llm!.chat({ messages: [{ role: "user", content: "x" }] });

    // Only anthropic should have been queried (openai never read).
    expect(storeMock.getLlmKey).toHaveBeenCalledTimes(1);
    expect(storeMock.getLlmKey).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "anthropic",
    );
    // And the request actually went to Anthropic's endpoint.
    expect(fetchMock.calls[0].url).toContain("api.anthropic.com/v1/messages");
  });

  it("returns a configured LlmProvider that routes through the right adapter for the active provider", async () => {
    storeMock.listProviders.mockResolvedValue(["openai"]);
    storeMock.getLlmKey.mockResolvedValue("sk-real");
    fetchMock.queueResponse({ choices: [{ message: { content: "hello" } }] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llm = await createByokLlm({} as any, "user-1");
    expect(llm).not.toBeNull();
    expect(llm!.isConfigured()).toBe(true);
    const out = await llm!.chat({ messages: [{ role: "user", content: "x" }] });
    expect(out).toBe("hello");

    // The user's key is the one on the wire.
    expect(fetchMock.calls[0].init.headers?.authorization).toBe(
      "Bearer sk-real",
    );
  });

  it("returns null when listProviders returns an unsupported name (defensive — schema CHECK should prevent this)", async () => {
    storeMock.listProviders.mockResolvedValue(["grok"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createByokLlm({} as any, "user-1");
    expect(out).toBeNull();
    expect(storeMock.getLlmKey).not.toHaveBeenCalled();
  });

  it("propagates the userId to both store calls (RLS identity comes from the cookie, but the userId is the engine's view of the same identity)", async () => {
    storeMock.listProviders.mockResolvedValue(["openai"]);
    storeMock.getLlmKey.mockResolvedValue("sk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createByokLlm({} as any, "user-99");
    expect(storeMock.listProviders).toHaveBeenCalledWith(expect.anything(), "user-99");
    expect(storeMock.getLlmKey).toHaveBeenCalledWith(
      expect.anything(),
      "user-99",
      "openai",
    );
  });
});
