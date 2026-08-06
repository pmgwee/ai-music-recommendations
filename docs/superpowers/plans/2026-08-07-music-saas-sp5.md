# SP-5 — One-prompt playlists (design + plan)

**Goal:** a member types a free-text vibe ("chill Sunday morning", "songs like Arctic Monkeys but dreamier", "hype workout") → gets a personalized playlist. The engine's `vibe.ts` already maps text → structured constraints; SP-5 adds the missing YouTube **search** (to ground seed names → a real track) + the route + UI.

**Predecessors:** SP-0 (`vibe.ts` `parseVibe` + the `LlmProvider` seam), SP-2 (BYOK `createByokLlm`). Basis: ADR-0007 (the vibe surface — LLM as intent parser, grounded via the retriever, never the song-picker).

## Decisions (defaults)
| # | Decision | Default |
|---|---|---|
| D1 | Search seam | Add `searchTracks(query, limit?) → MusicTrack[]` to the engine's `CandidateSource` interface + the InnerTube impl (youtubei.js). Anonymous, additive (SC1 intact). |
| D2 | Grounding | `parseVibe(prompt, llm)` → `{genres, moods, eras, seedNames, exclude, length}`. Resolve a concrete seed: if `seedNames[0]`, `searchTracks(seedName)` → first result's `trackId`; else `searchTracks(synthSeedQuery(constraints))` → first result. Never trust an LLM-emitted id — always resolve via search. |
| D3 | Fulfillment | `buildRadio({ seedTrackId, history, candidateSource, tagStore, llm, options })` → personalized (skips the user's skipped tracks) + on-vibe. Post-filter the result by `exclude` words (title contains → drop) + cap at `length`. If no seed resolves → return empty + a "couldn't ground that" message. |
| D4 | UI | A `/vibe` page (sidebar link): a prompt input + Generate → the playlist (reuses the player + shelf row UI). Show the parsed constraints as chips ("understood: chill + rainy-day + indie"). |

## Architecture
- `packages/music-engine/src/sources.ts` + `seams.ts`: add `searchTracks`.
- `lib/vibe/resolve.ts` — `resolveVibeSeed(constraints, candidateSource): Promise<{ seed: MusicTrack; via: "named"|"synthesized" } | null>` — the grounding step.
- `app/api/vibe/route.ts` — POST `{ prompt }` → `parseVibe` (BYOK llm) → resolve seed → `buildRadio` → filter → `{ tracks, constraints }`. Session-gated + rate-limited (LLM + search are costly: e.g. 6/min/user).
- `app/(app)/vibe/page.tsx` + client components — the prompt UI + results.

## Tasks
1. **Search seam** — add `searchTracks` to `CandidateSource` (seams.ts) + InnerTube impl (sources.ts, youtubei.js search → source-neutral MusicTrack via the existing `toTrack` mapper) + update the engine's mock sources in tests + the app's `createYoutubeCandidateSource`. Boundary test still green (youtubei.js allowed).
2. **Vibe route** — `resolveVibeSeed` + `/api/vibe` (parseVibe → resolve → buildRadio → filter). Tests (mocked llm + candidateSource; asserts grounding-via-search + exclude filter + no-LLM → empty).
3. **Vibe UI** — `/vibe` page (prompt input + Generate + playlist + parsed-constraint chips) + sidebar link.
4. **Gate + push.**

## Success criteria
- SC1. A prompt with a named seed ("like Arctic Monkeys") grounds via search → a real seed → a personalized radio.
- SC2. A prompt with only tags ("chill indie") synthesizes a query → grounds → radio.
- SC3. No BYOK LLM → vibe returns empty + a message (the engine degrades; vibe needs the LLM). typecheck + build + tests clean; pushed.

## Open items for review
- Vibe quality depends on the BYOK LLM's intent parsing + YouTube search relevance — first cut; refine with use.
- LLM + 2× search (seed resolve) + radio per vibe build — rate-limited (6/min/user) to bound cost under BYOK.
