# SP-1 Implementation Plan — Hosted SaaS Shell

> **For agentic workers:** implement task-by-task via superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** turn the SP-0 architecture proof into a real multi-tenant product — public auth, landing, accounts, RLS-proper, app shell, music dashboard behind auth. Deletes the SP-0 admin-dev concession (resolves the write-path limitation).

**Architecture:** Supabase Auth (email + Google) + Next.js middleware guarding an `(app)` route group; cookie-bound server client everywhere in the app (no admin-dev); the SP-0 proof page graduates into the real `/dashboard`; in-memory per-user rate limit on the shelf route.

**Spec:** `docs/superpowers/specs/2026-08-07-music-saas-sp1-design.md`

## Global Constraints
- All commits end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Engine purity (SC1) must remain intact — auth/shell code is app-level, never in `packages/music-engine`.
- Do NOT modify `subscription-agent`. Do NOT touch `.env`.
- Push at SP-1 completion (not per-task).
- Reference patterns (read-only): `subscription-agent/middleware.ts`, `subscription-agent/app/(app)/layout.tsx`, `subscription-agent/app/login/`, `subscription-agent/components/layout/app-shell.tsx`.

## Tasks

### Task 1 — Auth core (login/signup/callback/middleware)
- **Files:** `app/login/page.tsx`, `app/signup/page.tsx`, `app/auth/callback/route.ts`, `middleware.ts`.
- **Do:** email/password signup+signin via `supabase.auth`; `/auth/callback` exchanges `?code=` → session (PKCE) → redirect `/dashboard`; middleware refreshes session + guards `(app)` (unsigned → `/login`) + rescues a stray `?code=` dropped on a non-callback route (forward to `/auth/callback`). Mirror subscription-agent's middleware. Configure `next.config` if needed for the matcher.
- **Acceptance:** typecheck + build clean; a unit test for the middleware's redirect decision (mock `supabase.auth.getUser`).

### Task 2 — Delete SP-0 admin-dev concession + rebind music routes
- **Files:** delete `lib/music/sp0-dev.ts`; modify `app/api/music/shelf/route.ts`, `.../plays/route.ts`, `.../signals/route.ts`; remove `MUSIC_DEV_USER_ID` from `.env.example` + the integration script.
- **Do:** routes resolve the user from `(await createServerClient()).auth.getUser()`; bind `createSupabaseTrackStore(cookieClient)` (the `_userId` param is gone per SP-0 fix); 401 JSON if no session. The admin client stays only for `setTags` (catalog-global) inside the TrackStore. The integration script seeds via a real created dev user OR is marked manual.
- **Acceptance:** `grep -rn "sp0-dev\|MUSIC_DEV_USER_ID"` returns nothing; routes 401 without a session (test).

### Task 3 — Landing page (public)
- **Files:** `app/page.tsx` (root, OUTSIDE `(app)`), `components/landing/*`.
- **Do:** honest positioning headline (BYOK + multi-source YouTube/Spotify + transparent learning recommender; "you own your taste data + your LLM key"); CTA → `/signup`; minimal, on-brand. NO "world's first" claim.
- **Acceptance:** renders at `/` to unsigned visitors; typecheck + build clean.

### Task 4 — App shell + route group
- **Files:** `app/(app)/layout.tsx`, `components/layout/app-shell.tsx` (sidebar + header + mobile bottom-nav).
- **Do:** `(app)/layout.tsx` mounts `PlayerProvider` (so audio outlives navigation) + the shell chrome; the portal iframe lives here. Move dashboard/settings under `(app)`. Ensure the public landing (`app/page.tsx`) stays outside `(app)` (no player/auth).
- **Acceptance:** shell renders around `(app)` pages; player persists across `(app)` navigation; typecheck + build clean.

### Task 5 — Music dashboard
- **Files:** `app/(app)/dashboard/page.tsx` (+ client components as needed).
- **Do:** graduate the SP-0 proof page into the real dashboard — discovery shelf + player + play/skip/like controls, all driven by the signed-in user's session (the routes from Task 2). Add a "Refresh shelf" + now-playing.
- **Acceptance:** dashboard loads behind auth; shelf + player work; typecheck + build clean.

### Task 6 — Settings shell
- **Files:** `app/(app)/settings/page.tsx`.
- **Do:** profile (email), sign-out button; a placeholder/disabled "LLM API keys" section labelled "coming in SP-2".
- **Acceptance:** renders behind auth; sign-out works; typecheck + build clean.

### Task 7 — Rate limit
- **Files:** `lib/rate-limit.ts`, wrap `app/api/music/shelf/route.ts` (+ optionally auth routes).
- **Do:** in-memory token bucket per user-id (e.g. shelf: ≤ 8 builds/min/user) returning 429 + `retry-after`. Coarse per-IP bucket on `/login`+`/signup` (≤ 10/min). Note single-region limitation in a comment.
- **Acceptance:** unit test for the token bucket (allows N, denies N+1, refills); typecheck + build clean.

### Task 8 — Build gate + verify + push
- **Do:** `pnpm typecheck` + `pnpm build` + `pnpm test` all clean; grep SC4 clean; commit; push. The live UAT (sign up → play → refresh → persisted) is controller/user-run (browser auth), documented in the report.
- **Acceptance:** SC1–SC5 (spec §4) met where verifiable without browser; pushed to GitHub.

## Self-Review (after all tasks)
- Spec coverage: every §4 success criterion maps to a task (SC1→T1, SC2→T1/T3, SC3→T2/T5, SC4→T2, SC5→T8).
- Type consistency: the music routes' user-resolution + TrackStore binding consistent across T2/T5.
- Engine purity untouched (no `(app)`/auth code in `packages/music-engine`).
