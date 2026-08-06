import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/auth/sign-out-button";

/**
 * SP-1 settings shell — read-only. The `(app)` layout already redirects
 * unsigned visitors to `/login`, and the middleware gates `/settings` too, so
 * `getUser()` here is defense-in-depth and gives us the email for the profile
 * section. Sign-out is the shared `SignOutButton` (same component the shell
 * header uses), so the logic is reused, not duplicated.
 *
 * The "LLM API keys" section is a disabled placeholder — BYOK key management
 * (OpenAI / Anthropic / Gemini / GLM) lands in SP-2. Read-only for now: no
 * inputs, no mutation.
 */
export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm opacity-70">
          Profile and account. More options land as the product grows.
        </p>
      </header>

      {/* Profile */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-70">
          Profile
        </h2>
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="opacity-60">Email</dt>
            <dd className="truncate font-medium" title={user?.email ?? undefined}>
              {user?.email ?? "Unknown"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="opacity-60">User ID</dt>
            <dd className="truncate font-mono text-xs opacity-70" title={user?.id}>
              {user?.id ?? "—"}
            </dd>
          </div>
        </dl>
        <div className="mt-4 border-t border-black/10 pt-4 dark:border-white/10">
          <SignOutButton className="rounded-md border border-black/10 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10" />
        </div>
      </section>

      {/* LLM API keys — disabled placeholder (SP-2) */}
      <section className="rounded-lg border border-black/10 p-4 opacity-70 dark:border-white/15">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            LLM API keys
          </h2>
          <span className="rounded-full border border-black/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide dark:border-white/15">
            Coming in SP-2
          </span>
        </div>
        <p className="text-sm">
          Bring your own OpenAI, Anthropic, Gemini, or GLM key (BYOK). Your key
          powers the cold-start tag prior and the vibe intent surface, and stays
          under your control. Key entry and per-user storage land in SP-2.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["OpenAI", "Anthropic", "Gemini", "GLM"].map((provider) => (
            <span
              key={provider}
              className="rounded-md border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
              aria-label={`${provider} key — disabled`}
            >
              {provider} key · disabled
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
