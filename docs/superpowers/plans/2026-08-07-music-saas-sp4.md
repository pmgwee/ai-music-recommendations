# SP-4 — Taste-profile surface + top-N diversity judge (design + plan)

**Goal:** (1) show members what the engine has learned about their taste; (2) ship ADR-0007's *deferred* top-N LLM diversity judge — now data-backed, app-level, gated, position-bias-mitigated — to drop clunkers from the top of the slate.

**Predecessors:** SP-0 (engine + tags/history), SP-2 (BYOK `LlmProvider` via `createByokLlm`). Basis: ADR-0007 §"Deferred" (the judge runs only over the top ~12, with mitigation, only when a real LLM is configured, never on the per-request hot path unbounded).

## Decisions (defaults)
| # | Decision | Default |
|---|---|---|
| D1 | Taste profile | Derived from the user's own data: top artists (by weighted play/complete count), top tags (via the `music_track_tags` layer aggregated over their history), listening stats (total plays, skip vs complete rate, discovery ratio). Read-only. |
| D2 | Surface | A `/taste` page (sidebar link) — a "Your taste" profile. Plus a compact summary card on `/dashboard`. |
| D3 | Top-N judge | **App-level post-filter** (engine stays pure/behavioural). After `buildShelf` returns the slate, IF a BYOK LLM is configured: take the top ~10, **shuffle** (position-bias mitigation), ask the LLM "given this listener's top artists/tags, which 0–2 of these tracks are most likely a clunker or jarring fit?" → drop the flagged ones from the slate (they fall back into the unheard pool for next time). Bounded: max 2 drops, max 1 LLM call/shelf build. If no BYOK → skip (engine slate as-is). |
| D4 | Why-this | Each shelf row can optionally show provenance ("radio around X", "similar to Y") — the engine already tracks `occurrences`; expose the top occurrence as a one-liner. (Lightweight; skip if it bloats the slate payload.) |

## Architecture
- `lib/taste/profile.ts` — `buildTasteProfile(trackStore, userId): Promise<TasteProfile>` (top artists, top tags, stats). Pure aggregation over history + tags.
- `app/api/taste/route.ts` — GET (session-gated) → the profile.
- `app/(app)/taste/page.tsx` — the taste UI.
- `lib/taste/judge.ts` — `diversityJudge(llm, topSlate, profile): Promise<Set<trackId>>` — the mitigated top-N judge (shuffle input, parse the LLM's flagged ids, cap at 2). Returns the ids to drop.
- `/api/music/shelf` — after `buildShelf`, if BYOK llm + slate length ≥ ~10, run `diversityJudge` on the top 10 → filter → return. Cache per build (single call).

## Tasks
1. **Taste profile lib + route** — `lib/taste/profile.ts` + `/api/taste` (GET) + tests (aggregation from a mock history+tags).
2. **Taste UI** — `/taste` page (top artists, top tags as chips, stats) + a dashboard summary card + sidebar link.
3. **Top-N judge** — `lib/taste/judge.ts` (shuffle + LLM prompt + parse + cap-2) + tests (mocked LLM; asserts shuffle mitigation, cap, parse-tolerance); wire into `/api/music/shelf` as the gated post-filter.
4. **Gate + push.**

## Success criteria
- SC1. `/taste` shows the member's top artists + tags + stats from their live data.
- SC2. With a BYOK key set, the shelf build runs the judge (1 LLM call, top ~10, shuffled) + drops ≤2 flagged clunkers; without a key, the shelf is unchanged (judge skipped).
- SC3. The judge is bounded (max 2 drops, max 1 call/build) + shuffles its input (position-bias mitigation). typecheck + build + tests clean; pushed.

## Open items for review
- The judge prompt + "clunker" definition is a first cut — refine with real usage data (ADR-0007's intent).
- Taste "top tags" depends on the `music_track_tags` cache being populated (the LLM tag prior runs on first shelf build per track). A brand-new user sees sparse tags until they listen.
- Judge cost: 1 LLM call/shelf build per active user — acceptable under BYOK (user's key). Cache/dedupe later if abuse.
