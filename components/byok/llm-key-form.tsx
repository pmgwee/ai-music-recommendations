"use client";

/**
 * BYOK key management form (SP-2 Task 5).
 *
 * Wires the four supported providers (openai/anthropic/gemini/glm) to
 * /api/llm-key. The plaintext key is held only in component state long enough
 * to POST it; it is never persisted to localStorage, never displayed after
 * Save, and the input is `type="password"` so screen-recorders / over-shoulder
 * reads don't get it. On Save success the input is cleared and the provider
 * joins the "configured" list (fetched fresh from GET).
 *
 * Status states:
 *   - loading     → first GET in flight (or any in-flight op)
 *   - saved       → ephemeral "✓ <Provider> key set" confirmation
 *   - error       → server error message (Save / Remove failure)
 *   - rate-limited → 429 surfaced verbatim with the server's retry hint
 *
 * Provider switch is just "save a different provider's key" — listProviders
 * returns most-recently-set first, so saving a new provider bumps it to the
 * active slot automatically (no separate "switch" control needed).
 */
import { useEffect, useState } from "react";

/** Display labels for the four supported providers (matches the store's
 *  SUPPORTED_PROVIDERS set). id is what we send over the wire. */
const PROVIDERS: Array<{ id: string; label: string; hint: string }> = [
  { id: "openai", label: "OpenAI", hint: "gpt-4o-mini · api.openai.com" },
  {
    id: "anthropic",
    label: "Anthropic",
    hint: "claude-haiku-4-5 · api.anthropic.com",
  },
  {
    id: "gemini",
    label: "Gemini",
    hint: "gemini-2.0-flash · googleapis.com",
  },
  { id: "glm", label: "GLM (Z.ai)", hint: "glm-4-flash · api.z.ai" },
];

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saved"; provider: string }
  | { kind: "error"; message: string };

export function LlmKeyForm() {
  const [configured, setConfigured] = useState<string[]>([]);
  const [provider, setProvider] = useState<string>("openai");
  const [key, setKey] = useState<string>("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  // First load — fetch the list of configured providers. Re-runs after each
  // successful Save/Remove so the configured list reflects the new state.
  async function refreshConfigured(): Promise<void> {
    try {
      const res = await fetch("/api/llm-key", { method: "GET" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({
          kind: "error",
          message: body?.error ?? "Failed to load keys",
        });
        return;
      }
      setConfigured(Array.isArray(body.providers) ? body.providers : []);
      setStatus({ kind: "idle" });
    } catch {
      setStatus({ kind: "error", message: "Network error — try again" });
    }
  }

  useEffect(() => {
    // Fetch the configured-providers list on mount. setState-in-effect is the
    // canonical "sync React state with an external system on mount" pattern
    // (https://react.dev/learn/you-might-not-need-an-effect#fetching-data),
    // and the setState calls inside `refreshConfigured` only run after the
    // fetch resolves (async), not during the effect's synchronous body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshConfigured();
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setStatus({ kind: "error", message: "Enter an API key" });
      return;
    }
    setStatus({ kind: "loading" });
    setBusyProvider(provider);
    try {
      const res = await fetch("/api/llm-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429) {
          const retry = body?.error === "rate_limited";
          setStatus({
            kind: "error",
            message: retry
              ? "Too many requests — wait a minute and try again"
              : (body?.error ?? "Save failed"),
          });
        } else {
          setStatus({
            kind: "error",
            message: humanizeError(body?.error) ?? "Save failed",
          });
        }
        return;
      }
      // Success: clear the plaintext from state immediately, reflect the new
      // configured list, and flash a per-provider confirmation.
      setKey("");
      setStatus({ kind: "saved", provider });
      await refreshConfigured();
    } catch {
      setStatus({ kind: "error", message: "Network error — try again" });
    } finally {
      setBusyProvider(null);
    }
  }

  async function onRemove(p: string) {
    if (!confirm(`Remove your ${labelFor(p)} key?`)) return;
    setStatus({ kind: "loading" });
    setBusyProvider(p);
    try {
      const res = await fetch("/api/llm-key", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: p }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({
          kind: "error",
          message: humanizeError(body?.error) ?? "Remove failed",
        });
        return;
      }
      await refreshConfigured();
      setStatus({ kind: "idle" });
    } catch {
      setStatus({ kind: "error", message: "Network error — try again" });
    } finally {
      setBusyProvider(null);
    }
  }

  const saved =
    status.kind === "saved" && status.provider === provider
      ? `✓ ${labelFor(provider)} key set`
      : null;
  const errorMessage = status.kind === "error" ? status.message : null;
  const loading = status.kind === "loading";

  return (
    <div className="flex flex-col gap-4">
      {/* Status / error line */}
      {saved && (
        <div
          role="status"
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300"
        >
          {saved}
        </div>
      )}
      {errorMessage && (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300"
        >
          {errorMessage}
        </div>
      )}

      {/* Add / replace a key */}
      <form onSubmit={onSave} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Provider</span>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              // Switching provider clears any stale per-provider confirmation.
              if (status.kind === "saved") setStatus({ kind: "idle" });
            }}
            disabled={loading}
            className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id} className="bg-white dark:bg-neutral-900">
                {p.label} — {p.hint}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">API key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (status.kind === "error") setStatus({ kind: "idle" });
            }}
            disabled={loading}
            placeholder={`Paste your ${labelFor(provider)} key`}
            className="rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/20"
          />
        </label>

        <button
          type="submit"
          disabled={loading || !key.trim()}
          className="self-start rounded-md bg-foreground px-4 py-2 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50"
        >
          {loading && busyProvider === provider ? "Saving…" : "Save key"}
        </button>
      </form>

      {/* Configured providers list */}
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">
          Configured keys
        </h3>
        {configured.length === 0 ? (
          <p className="text-xs opacity-60">
            No keys set yet. The engine falls back to co-occurrence
            recommendations until you add one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {configured.map((p) => (
              <li
                key={p}
                className="flex items-center justify-between gap-3 rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/15"
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden className="text-emerald-600 dark:text-emerald-400">
                    ✓
                  </span>
                  <span className="font-medium">{labelFor(p)}</span>
                  {configured[0] === p && (
                    <span className="rounded-full border border-black/10 px-2 py-0.5 text-[11px] uppercase tracking-wide opacity-70 dark:border-white/15">
                      Active
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void onRemove(p)}
                  disabled={loading}
                  className="rounded-md border border-black/10 px-2.5 py-1 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10"
                >
                  {loading && busyProvider === p ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[11px] leading-relaxed opacity-60">
          Keys are encrypted (AES-256-GCM) before storage and never sent back
          to the browser after Save. The topmost provider is the one the
          recommender actually uses.
        </p>
      </div>
    </div>
  );
}

function labelFor(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/** Map the route's machine-readable error codes to human copy. */
function humanizeError(code: unknown): string | null {
  if (typeof code !== "string") return null;
  switch (code) {
    case "invalid_provider":
      return "Unknown provider";
    case "invalid_key":
      return "That key looks empty or too long";
    case "invalid_json":
      return "Malformed request";
    case "set_failed":
      return "Couldn't save (server error)";
    case "delete_failed":
      return "Couldn't remove (server error)";
    case "list_failed":
      return "Couldn't load keys";
    case "rate_limited":
      return "Too many requests — wait a minute and try again";
    default:
      return null;
  }
}
