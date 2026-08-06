# ai-music-recommendations

A source-neutral music recommender — a two-stage candidate-generation +
ranking/sequencing engine, ported from the subscription-agent in-app music
recommender and re-platformed onto four injected provider seams so the same
pipeline can run against YouTube today and another source (Spotify, Apple) in
a later story without touching the engine.

This repo is the **SP-0 cycle**: the source-neutral refactor plus a minimal
architecture proof. Auth/RLS-proper, BYOK, playlist ingestion, taste UI, and
the LLM DJ surface are SP-1+ (separate cycles, out of scope here).

## Workspace

A pnpm workspace with one pure engine package + a Next.js app:

```
packages/music-engine/      pure engine, no app-framework deps
  src/
    types.ts                MusicTrack / HistoryEntry / Candidate / etc.
    ranking.ts              behavioural scoring + assembly (epsilon-greedy)
    similarity.ts           co-occurrence cosine + LLM-tag-prior sequencing
    tags.ts                 constrained-vocabulary LLM tag layer + TagStore
    vibe.ts                 LLM intent parser (the vibe surface)
    sources.ts              anonymous InnerTube + createYoutubeCandidateSource()
    recommend.ts            buildShelf / buildRadio / continueRadio
    seams.ts                the four provider interfaces (below)
app/                        Next.js app (the SP-0 proof surface)
lib/
  providers/                app-side impls of the four seams
  supabase/                 three-client pattern (server / client / admin)
scripts/
  sp0-integration-check.ts  SC3 live integration proof (see below)
supabase/migrations/        source-neutral music schema (single CREATE)
```

## The four provider seams

Everything framework- or credential-specific lives behind one of four
interfaces defined in `packages/music-engine/src/seams.ts` (+ `tags.ts`). The
engine imports none of `next` / `@supabase/*` / `react` / `server-only` —
**SC1**, the engine purity boundary, is enforced by a boundary test
(`packages/music-engine/test/boundary.test.ts`).

| Seam               | Engine interface                       | App impl                                  | Role |
| ------------------ | -------------------------------------- | ----------------------------------------- | ---- |
| `LlmProvider`      | `seams.ts`                             | `lib/providers/llm-glm.ts` (Z.ai / GLM)   | Cold-start tag prior + vibe intent parser. Anonymous: only track metadata is sent. |
| `PlayerProvider`   | `seams.ts`                             | `lib/providers/player-youtube.tsx` (IFrame) | Resolves `track.sources.youtube` and drives the never-reparented IFrame portal. |
| `TrackStore`       | `seams.ts` (broad)                     | `lib/providers/track-store-supabase.ts`   | Per-user history / likes / suppressions / learned transitions + tag cache. |
| `CandidateSource`  | `seams.ts`                             | `createYoutubeCandidateSource()` in-engine | Anonymous candidate generation (song radio, related, similar artists, editorial). |
| `TagStore`         | `tags.ts` (narrow: `get`/`put`)        | broad → narrow adapter at the call site   | LLM tag cache. Catalog-global (no user_id), so writes go via the admin client. |

A source-neutral `MusicTrack` carries `trackId: "yt:<videoId>"` and a
`sources: { youtube: "<videoId>" }` map; playback resolves `sources.youtube`
and is a no-op when that field is absent — **SC2**, the source-neutral runtime
guarantee, is verified by `packages/music-engine/test/source-neutral.test.ts`.

## SP-0 scope (success criteria)

- **SC1 — engine purity**: `boundary.test.ts` green (engine has no
  `next` / `@supabase` / `react` imports).
- **SC2 — source-neutral**: `source-neutral.test.ts` + `recommend.test.ts`
  green (a spotify-only track + a mock source flow through the engine without
  YouTube being contacted).
- **SC3 — live integration**: the proof page (`app/page.tsx`) exercises all
  four seams end-to-end; `scripts/sp0-integration-check.ts` reproduces the
  same against the live DB + live InnerTube headlessly.
- **SC4 — build gate**: `pnpm typecheck && pnpm build && pnpm test` all clean.

## Run

```bash
pnpm install            # pnpm@11+, Node 20+
pnpm dev                # Next.js dev server on :3000 (the SP-0 proof page)
pnpm test               # vitest — 41 tests across engine + providers
pnpm build              # next build (also runs ESLint + type gen)
pnpm typecheck          # tsc --noEmit, whole workspace
pnpm check:sp0          # SC3 live integration check (see below)
```

### SC3 integration check

```bash
pnpm exec tsx --env-file=.env scripts/sp0-integration-check.ts
```

Ensures a dev auth user exists (`music-check@local`), seeds one play via a direct
admin insert (the auth-coupled `log_music_play` RPC is the route's path), then
builds the discovery shelf through the four real seams against the live DB +
live InnerTube. Prints the slate count + sample titles; exits `0` if the slate
is non-empty, `1` otherwise. Runs with no `ZAI_API_KEY` — the LLM tag prior
silently falls back to pure co-occurrence when GLM isn't configured.

## Environment

Copy `.env.example` to `.env` and fill in:

| Var                                | Required for           | Notes |
| ---------------------------------- | ---------------------- | ----- |
| `NEXT_PUBLIC_SUPABASE_URL`         | all paths              | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | app routes          | Supabase anon/publishable key. |
| `SUPABASE_SERVICE_ROLE_KEY`        | integration check, catalog tag-cache writes | Service role. The music routes use the cookie-bound client (RLS); the admin client survives only for `setTags` (catalog-global `music_track_tags`) and the dev integration check. |
| `ZAI_API_KEY`                      | LLM tag prior + vibe   | Optional. When unset, `isConfigured()` returns false and the tag prior is skipped (co-occurrence only). |
| `ZAI_BASE_URL`                     | LLM (optional)         | Defaults to the Z.ai coding endpoint. |
| `GLM_MODEL`                        | LLM (optional)         | Defaults to `glm-5.2` (1M context). |

## Roadmap (SP-1+, separate cycles)

The following are intentionally absent from SP-0 and will land in later
cycles:

- **SP-1** — real auth + RLS: swap the admin-bound `TrackStore` for the
  cookie-bound server client and source `userId` from the session. Delete
  `lib/music/sp0-dev.ts` and `MUSIC_DEV_USER_ID`.
- **BYOK** — per-user LLM keys (replaces the server `ZAI_API_KEY`).
- **Playlist ingestion** — import the listener's YouTube "Liked Music" as a
  cold-start prior.
- **Taste UI** — the vibe surface's frontend.
- **LLM DJ** — conversational station seeding.
- **Legal** — provider ToS review for non-YouTube sources.
