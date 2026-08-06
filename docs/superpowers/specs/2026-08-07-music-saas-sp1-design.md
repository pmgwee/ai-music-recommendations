# Design Spec — AI Music Player (SaaS), SP-1: Hosted SaaS Shell

- **Date:** 2026-08-07
- **Status:** Draft — autonomous-run defaults (user reviews at completion)
- **Scope:** turn the SP-0 architecture proof into a real **multi-tenant product**: public auth, landing page, accounts, RLS-proper, app shell, and the music dashboard integrated behind auth. Resolves the SP-0 write-path limitation.
- **Predecessor:** SP-0 (source-neutral engine + 4 seams) — complete, published.

## 1. Goal

A public visitor can sign up / sign in, and a signed-in member sees the **music dashboard** (player + discovery shelf) with plays/skips/likes **persisted to their own account** (RLS), navigated via an app shell. The SP-0 admin-dev-mode concession (`lib/music/sp0-dev.ts`, `MUSIC_DEV_USER_ID`) is **deleted** — all routes use the cookie-bound server client, so `auth.uid()` is populated and the `log_music_*` RPCs work (the SP-0 write-path limitation is resolved).

## 2. Decisions (autonomous defaults — for user review)

| # | Decision | Default | Rationale |
|---|---|---|---|
| D1 | Auth providers | **Email/password + Google OAuth** (Supabase Auth) | Matches the stack; lowest-friction public signup; Google OAuth reuses the Supabase Google provider. |
| D2 | Route protection | **Middleware** refreshes the session + guards the `(app)` group; unsigned → `/login`; rescue `?code=` OAuth hand-offs (mirror subscription-agent's `middleware.ts`). | Standard Next.js + Supabase pattern. |
| D3 | Data access | **Cookie-bound server client** everywhere in `(app)`; DELETE `sp0-dev.ts` + `MUSIC_DEV_USER_ID`. The admin client survives only for the catalog-global tag-cache writes (`music_track_tags`) + (later) ingestion. | RLS-proper; resolves SP-0 write-path. |
| D4 | Landing page | Public `/` with the **honest** positioning (BYOK + multi-source + transparent + learning; first to own-your-taste+your-key) — NOT "world's first AI music player" (unsubstantiable). | Truthful; survives legal review. |
| D5 | App shell | Sidebar (desktop) + bottom nav (mobile) + header, with the YouTube `PlayerProvider` mounted once at the shell root (audio outlives navigation). | Mirrors the proven subscription-agent shell; player persistence. |
| D6 | Music dashboard | The SP-0 proof page graduates into the real `/dashboard`: discovery shelf + player + play/skip/like controls, all driven by the signed-in user's live data. | One cohesive surface; no separate "proof" page. |
| D7 | Rate-limit / abuse | Per-user **in-memory rate limit** on `/api/music/shelf` (e.g. ≤ N builds/min) — the InnerTube candidate source is the shared, scrape-costly resource. IP-based coarse limit on auth endpoints. | Protects the operator's scraping budget + deters abuse; full quota/billing is XC/later. |
| D8 | Settings | `/settings` shell (profile, sign-out) — BYOK keys land here in SP-2. | Placeholder for SP-2. |

## 3. Architecture changes

- **Auth wiring:** `lib/supabase/server.ts` already returns the cookie-bound client (from SP-0). Add the Google OAuth callback route (`/auth/callback`) + login/signup UI + middleware.
- **Delete the SP-0 concession:** remove `lib/music/sp0-dev.ts`, the `MUSIC_DEV_USER_ID` reads, and the admin-client binding in the music routes. The music API routes (`/api/music/shelf|plays|signals`) now resolve the user from the session (`(await serverClient.auth.getUser()).data.user?.id`) and 401 if none. The `TrackStore` is bound to the cookie client + that user id.
- **App shell:** `(app)/layout.tsx` mounts `PlayerProvider` + the shell chrome; `(app)/dashboard/page.tsx` is the music surface; `(app)/settings/page.tsx` is the settings shell. Public `app/page.tsx` (landing) moves out of the auth group.
- **Middleware:** `middleware.ts` refreshes session + guards `(app)`.
- **Rate limit:** a tiny `lib/rate-limit.ts` (in-memory token bucket per user-id/IP) wrapped around the shelf route + auth routes.

## 4. Success criteria (SP-1)

- SC1. A fresh visitor can **sign up (email) + sign in (email or Google)**; sessions persist; sign-out works.
- SC2. Unsigned visitors to `/dashboard` are redirected to `/login`; the public landing page renders to everyone.
- SC3. Signed-in members see `/dashboard`; **plays/skips/likes persist** to their own rows (verify: play a track, refresh, the play count + the personalized shelf reflect it — the SP-0 write-path limitation is gone).
- SC4. No `sp0-dev.ts` / `MUSIC_DEV_USER_ID` / admin-client-in-music-routes remains (grep-clean).
- SC5. `pnpm typecheck` + `pnpm build` + `pnpm test` clean; pushed to GitHub.

## 5. Out of scope (later SPs)

BYOK keys (SP-2) · playlist ingestion + ISRC (SP-3) · taste-profile UI + top-N judge (SP-4) · one-prompt productization (SP-5) · LLM DJ · billing/quotas (XC) · legal sign-off for public launch.

## 6. Open items for user review

- Google OAuth: needs a Google OAuth client (Client ID/Secret) in Supabase Auth config — user provides/registers. Email/password works without it; Google is a plus.
- The rate-limit is in-memory (per-instance) — fine for single-region Vercel; a real distributed limit (Upstash/Edge Config) is later.
- Landing copy is a truthful draft — user refines branding/voice.
