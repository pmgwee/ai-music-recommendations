# AI Music Player (SaaS) — SP-0: Source-Neutral Engine Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a new standalone repo (`ai-music-recommendations`) and extract the recommendation engine from `subscription-agent` into a pure, source-neutral workspace package that runs through four injected provider seams, proven by a minimal app.

**Architecture:** A pnpm workspace: `packages/music-engine/` (pure TS, zero app-framework deps, `videoId`-keyed types refactored to a canonical `trackId` + `sources` model) consumed by a Next.js app that injects four launch providers (Supabase `TrackStore`, YouTube-IFrame `PlayerProvider`, server-GLM `LlmProvider`, InnerTube `CandidateSource`).

**Tech Stack:** Next.js (App Router) · Supabase (Auth + Postgres + RLS) · Tailwind v4 · TypeScript · pnpm workspaces · vitest · `youtubei.js` · Vercel.

## Global Constraints

- **New repo path:** `c:\Users\quekm\Desktop\projects\ai-music-recommendations` (sibling to `subscription-agent`). All paths below are relative to this new repo root unless prefixed with the `subscription-agent` absolute path.
- **GitHub remote:** `https://github.com/pmgwee/ai-music-recommendations.git` — add as `origin` in Task 1; commit per task; **push once at SP-0 completion** (Task 15). Commits carry the `Co-Authored-By: Claude` trailer.
- **Engine purity (SC1):** `packages/music-engine/` MAY depend on `youtubei.js` (data-source lib) but MUST NOT depend on `next`, `@supabase/*`, `react`, or any `"use client"`/`"server-only"` directive. Enforced by its `package.json` (no such deps listed) + a boundary unit test (Task 8).
- **Source-neutral identity (SC2):** the engine keys on `trackId`; any access to `sources.youtube` must be guarded. No unguarded YouTube assumption survives the refactor.
- **SP-0 trackId scheme:** every track in SP-0 is YouTube-origin, so `trackId = "yt:" + sources.youtube`. ISRC-based canonicalization is SP-3; `isrc?` is present on the type but unused in SP-0.
- **No behavior change in SP-0:** the minimal app's play/skip/like/discovery behavior must match `subscription-agent`'s current music widget. New capabilities (BYOK, ingestion, DJ) are out of scope.
- **Money/dates conventions:** N/A in SP-0 (no domain money/dates in the engine).
- **Commit convention:** conventional commits (`feat:`, `chore:`, `test:`, `refactor:`). This new repo commits code + docs freely (unlike `subscription-agent`'s no-doc-commits rule — that rule does NOT carry over).

**Reference spec:** `c:\Users\quekm\Desktop\projects\subscription-agent\docs\superpowers\specs\2026-08-06-ai-music-recommendations-sp0-design.md`

---

## File Structure

**New repo root** (`ai-music-recommendations/`):
- `pnpm-workspace.yaml` — lists `packages/*`.
- `package.json` — root workspace, devDeps (vitest, typescript), scripts (`dev`, `build`, `test`, `typecheck`).
- `vitest.config.ts` — workspace-wide test config.
- `app/` — Next.js App Router (minimal proof page: `app/page.tsx`, `app/layout.tsx`).
- `lib/supabase/{server,client,admin}.ts` — Supabase clients (ported pattern from `subscription-agent/lib/supabase/`).
- `lib/providers/` — the four launch provider impls:
  - `track-store-supabase.ts` — `TrackStore` impl.
  - `player-youtube.tsx` — `PlayerProvider` impl (YouTube IFrame).
  - `llm-glm.ts` — `LlmProvider` impl (server GLM key).
  - `candidate-source-youtube.ts` — `CandidateSource` impl (InnerTube, thin wrapper).
- `supabase/migrations/0001_music_source_neutral.sql` — schema.
- `lib/supabase/types.ts` — regenerated DB types.

**Engine package** (`packages/music-engine/`):
- `package.json` — name `@music-ai/engine`, deps: `youtubei.js` only (plus typescript/vitest as devDeps).
- `src/types.ts` — source-neutral `MusicTrack`, `HistoryEntry`, `Candidate`, `Occurrence`, `LikedTrack`, `Suppressions`, `TrackSources`.
- `src/ranking.ts` — ported; `score`, `assemble`, `pickSeeds`, `confidence`, `ScoreContext`, `AssembleOptions`.
- `src/similarity.ts` — ported; `sequence`, `cosine`, `TagVector`, `SequenceOptions`, `pathSmoothness`.
- `src/recommend.ts` — ported; `buildShelf`, `buildRadio`, `continueRadio` (now take injected `CandidateSource` + `TrackStore` + `LlmProvider`).
- `src/tags.ts` — ported; `GENRES`, `MOODS`, `ERAS`, `ensureTagVectors`, `tagVectorOf`, `TrackStore` (tag subset), `TrackInput`.
- `src/vibe.ts` — ported; `parseVibe`, `VibeConstraints`, `synthSeedQuery` (takes injected `LlmProvider`).
- `src/sources.ts` — ported InnerTube behind `CandidateSource`; `RadioQueue`, `RelatedShelves`.
- `src/seams.ts` — the four interface declarations (`LlmProvider`, `PlayerProvider`, `TrackStore`, `CandidateSource`).
- `src/index.ts` — re-exports the public API.
- `test/` — `boundary.test.ts` (SC1), `source-neutral.test.ts` (SC2), `ranking.test.ts`, `recommend.test.ts`.

---

## Task 1: Scaffold the new repo + pnpm workspace

**Files:**
- Create: `ai-music-recommendations/` (entire repo via `create-next-app`)
- Create: `ai-music-recommendations/pnpm-workspace.yaml`
- Modify: `ai-music-recommendations/package.json` (add workspace + scripts)

**Interfaces:** none (first task).

- [ ] **Step 1: Create the Next.js app**

Run (from `c:\Users\quekm\Desktop\projects`):
```bash
pnpm dlx create-next-app@latest ai-music-recommendations --typescript --tailwind --app --pnpm --no-src-dir --import-alias "@/*" --use-npm=false
```
If interactive prompts remain, accept defaults (App Router, Tailwind, TS, pnpm). Do NOT choose `src/` (we use `app/` + `lib/` at root).

- [ ] **Step 2: Verify it boots**

```bash
cd ai-music-recommendations && pnpm dev
```
Expected: dev server on :3000, default page renders. Stop it.

- [ ] **Step 3: Add the pnpm workspace declaration**

Create `pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

- [ ] **Step 4: Add root scripts + devDeps**

In root `package.json`, ensure:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```
Then:
```bash
pnpm add -D -w vitest @vitest/ui
```

- [ ] **Step 5: Init git + first commit**

```bash
git init && git add -A && git commit -m "chore: scaffold next.js + pnpm workspace"
```

---

## Task 2: vitest + sanity test + TypeScript paths for the workspace

**Files:**
- Create: `vitest.config.ts`
- Create: `tsconfig.json` adjustment (ensure `paths` covers `@music-ai/engine`)
- Create: `sanity.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing sanity test**

Create `sanity.test.ts` at root:
```ts
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (no vitest config yet)**

Run: `pnpm test`
Expected: FAIL or error (vitest has no config; may pass by auto-discovery — if it passes, still continue; the point is the runner is wired).

- [ ] **Step 3: Add vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["**/*.test.ts"], environment: "node" },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: wire vitest"
```

---

## Task 3: Supabase client scaffolding (port the three-client pattern)

**Files:**
- Create: `lib/supabase/server.ts`, `lib/supabase/client.ts`, `lib/supabase/admin.ts`
- Create: `.env.example`
- Source to port from: `c:\Users\quekm\Desktop\projects\subscription-agent\lib\supabase\server.ts` (and client/admin)

**Interfaces:** none yet (consumed in Task 9).

- [ ] **Step 1: Copy the three client files verbatim**

Copy `subscription-agent/lib/supabase/{server,client,admin}.ts` into `ai-music-recommendations/lib/supabase/`. These are cookie-bound server, browser, and service-role clients. Adjust import paths if they reference `./types` (that file is regenerated in Task 13; until then, create a placeholder `lib/supabase/types.ts` with `export type Database = any;` so it compiles).

- [ ] **Step 2: Write `.env.example`**

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# SP-0 only — server GLM key (BYOK replaces this in SP-2)
ZAI_API_KEY=
ZAI_BASE_URL=
GLM_MODEL=
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS (with `Database = any` placeholder).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(supabase): port three-client pattern"
```

---

## Task 4: Create the engine workspace package shell

**Files:**
- Create: `packages/music-engine/package.json`
- Create: `packages/music-engine/tsconfig.json`
- Create: `packages/music-engine/src/index.ts`
- Modify: root `package.json` (add `@music-ai/engine` workspace dep), root `tsconfig.json` (paths)

**Interfaces:**
- Produces: empty package `@music-ai/engine` importable from the app as `@music-ai/engine`.

- [ ] **Step 1: Create the package manifest**

`packages/music-engine/package.json`:
```json
{
  "name": "@music-ai/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "youtubei.js": "^17.2.0" },
  "devDependencies": { "typescript": "^5.0.0", "vitest": "^1.0.0" }
}
```
Note: deliberately NO `next`, `@supabase/*`, or `react`. This is the SC1 boundary.

- [ ] **Step 2: Create the package tsconfig**

`packages/music-engine/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "rootDir": "src", "declaration": true },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Empty index + empty placeholder test**

`packages/music-engine/src/index.ts`:
```ts
export const ENGINE_VERSION = "0.0.0";
```
`packages/music-engine/test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ENGINE_VERSION } from "../src";
describe("engine package", () => {
  it("imports", () => expect(ENGINE_VERSION).toBe("0.0.0"));
});
```

- [ ] **Step 4: Wire the package into the app**

Root `package.json` devDependency: `"@music-ai/engine": "workspace:*"`. Root `tsconfig.json` `paths`: add `"@music-ai/engine": ["./packages/music-engine/src"]`. Then `pnpm install`.

- [ ] **Step 5: Run package test + commit**

```bash
pnpm --filter @music-ai/engine test
git add -A && git commit -m "feat(engine): create @music-ai/engine workspace package"
```

---

## Task 5: Source-neutral types (`types.ts`)

**Files:**
- Create: `packages/music-engine/src/types.ts`
- Source to adapt: `c:\Users\quekm\Desktop\projects\subscription-agent\lib\music\types.ts` + `types\music.ts`

**Interfaces:**
- Produces: `MusicTrack`, `TrackSources`, `HistoryEntry`, `Candidate`, `Occurrence`, `CandidateOrigin`, `LikedTrack`, `Suppressions`.

- [ ] **Step 1: Write the failing test (SC2 type-level: spotify-only track compiles)**

`packages/music-engine/test/source-neutral.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { MusicTrack } from "../src/types";

describe("source-neutral track model", () => {
  it("accepts a spotify-only track (no youtube source)", () => {
    const t: MusicTrack = {
      trackId: "yt:__pending__", // SP-0 scheme; resolver fills real id in SP-3
      sources: { spotify: "0VjIjW4GlU" },
      title: "x", artist: "y", thumbnail: null,
    };
    expect(t.sources.youtube).toBeUndefined();
    expect(t.sources.spotify).toBe("0VjIjW4GlU");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @music-ai/engine test`
Expected: FAIL ("Cannot find module '../src/types'").

- [ ] **Step 3: Write `types.ts`**

`packages/music-engine/src/types.ts`:
```ts
/** Per-provider ids for one canonical track. youtube = 11-char videoId; spotify = track id. */
export interface TrackSources {
  youtube?: string;
  spotify?: string;
}

/** A playable track — the engine's shared currency. Keys on canonical `trackId`,
 *  NOT on any provider id. Playback resolves the best available source. */
export interface MusicTrack {
  /** Canonical id. SP-0: "yt:<videoId>". SP-3: ISRC when known, else source-tagged. */
  trackId: string;
  /** ISRC — global canonical recording id. Unused in SP-0; load-bearing in SP-3. */
  isrc?: string;
  sources: TrackSources;
  title: string;
  artist: string;       // was `channel` in subscription-agent
  thumbnail: string | null;
  durationMs?: number;
  /** Provenance for shelf badges. */
  source?: "local" | "recommended";
}

export type CandidateOrigin =
  | "radio" | "also-like" | "similar-artist" | "editorial" | "history";

export interface Occurrence {
  sourceId: string;
  origin: CandidateOrigin;
  rank: number;
  seedWeight: number;
}

export interface Candidate {
  track: MusicTrack;
  occurrences: Occurrence[];
}

export interface LikedTrack {
  trackId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  likedAt: string;
}

export interface Suppressions {
  notInterested: Set<string>;
  snoozedUntil: Map<string, string>;
}

export interface HistoryEntry {
  trackId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  playCount: number;
  lastPlayedAt: string;
  skipCount: number;
  completeCount: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @music-ai/engine test`
Expected: PASS.

- [ ] **Step 5: Export from index + commit**

`packages/music-engine/src/index.ts`: add `export * from "./types";`
```bash
git add -A && git commit -m "feat(engine): source-neutral track model (trackId + sources)"
```

---

## Task 6: Port `ranking.ts` + `similarity.ts` (pure modules, identity rename)

**Files:**
- Create: `packages/music-engine/src/ranking.ts`, `packages/music-engine/src/similarity.ts`
- Source: `subscription-agent/lib/music/ranking.ts`, `similarity.ts`

**Interfaces:**
- Consumes: `Candidate`, `HistoryEntry`, `ScoreContext` (from `./types`).
- Produces: `score(candidate, ctx)`, `assemble(scored, opts)`, `pickSeeds(pool, count, now, random, likeIds)`, `confidence(...)`, `ScoreContext`, `AssembleOptions`; `sequence(slate, seedIndex, opts)`, `cosine(a,b)`, `TagVector`, `SequenceOptions`, `pathSmoothness(candidates)`.

**Rename rule (critical — apply at every site):**
- `track.videoId` / `videoId` as **identity** (Map/Set keys, dedup, param names, `occurrence.sourceId` derived from it) → `track.trackId` / `trackId`.
- `track.videoId` passed to a **YouTube-specific call** → `track.sources.youtube` (none exist in these two pure modules — they only do math on ids, so this is a pure identity rename here).

- [ ] **Step 1: Write a failing ranking test**

`packages/music-engine/test/ranking.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { score, ScoreContext } from "../src/ranking";
import type { Candidate, HistoryEntry } from "../src/types";

const history: HistoryEntry[] = [{
  trackId: "yt:seed", title: "s", artist: "a", thumbnail: null,
  playCount: 5, lastPlayedAt: new Date().toISOString(), skipCount: 0, completeCount: 2,
}];
const ctx: ScoreContext = {
  history: new Map(history.map((h) => [h.trackId, h])),
  likes: new Set(["yt:liked"]),
  now: Date.now(),
};
const candidate: Candidate = {
  track: { trackId: "yt:c1", sources: { youtube: "c1" }, title: "c", artist: "a", thumbnail: null },
  occurrences: [{ sourceId: "yt:seed", origin: "radio", rank: 0, seedWeight: 5 }],
};

describe("ranking", () => {
  it("scores a candidate without referencing sources.youtube", () => {
    const v = score(candidate, ctx);
    expect(typeof v).toBe("number");
    expect(Number.isFinite(v)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @music-ai/engine test`
Expected: FAIL (module not found).

- [ ] **Step 3: Copy + rename the two source files**

Copy `subscription-agent/lib/music/{ranking,similarity}.ts` into `packages/music-engine/src/`. Apply the identity rename: every `videoId` → `trackId` (these modules use ids only as map/set keys and math — no YouTube calls). Keep `confidence`, `score`, `assemble`, `pickSeeds`, `ScoreContext`, `AssembleOptions`, `sequence`, `cosine`, `TagVector`, `SequenceOptions`, `pathSmoothness` exports intact. Fix imports: `from "@/types/music"` / `from "./types"` → `from "./types"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @music-ai/engine test`
Expected: PASS.

- [ ] **Step 5: Export from index + commit**

Add to `index.ts`: `export * from "./ranking"; export * from "./similarity";`
```bash
git add -A && git commit -m "feat(engine): port ranking + similarity (trackId identity rename)"
```

---

## Task 7: Port `tags.ts` + `vibe.ts` (LLM via injected provider)

**Files:**
- Create: `packages/music-engine/src/tags.ts`, `packages/music-engine/src/vibe.ts`
- Source: `subscription-agent/lib/music/tags.ts`, `vibe.ts`

**Interfaces:**
- Consumes: `LlmProvider` (from `./seams`, declared in Task 9 — for this task, define a local minimal type the functions accept).
- Produces: `GENRES`, `MOODS`, `ERAS`, `tagVectorOf`, `ensureTagVectors`, `TrackInput`; `parseVibe(prompt, llm)`, `synthSeedQuery`, `VibeConstraints`.

- [ ] **Step 1: Failing test — vibe parse with a stub LlmProvider**

`packages/music-engine/test/vibe.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseVibe } from "../src/vibe";
import type { LlmProvider } from "../src/seams";

const stub: LlmProvider = {
  isConfigured: () => true,
  chat: async () =>
    JSON.stringify({ genres: ["pop"], moods: ["happy"], eras: [], seedNames: [], exclude: [], length: 10 }),
};

describe("vibe", () => {
  it("parses constraints via injected LlmProvider", async () => {
    const c = await parseVibe("upbeat pop for the gym", stub);
    expect(c).not.toBeNull();
    expect(c!.genres).toContain("pop");
    expect(c!.length).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @music-ai/engine test` → expected FAIL.

- [ ] **Step 3: Declare the four seams (needed by vibe)**

Create `packages/music-engine/src/seams.ts` with the four interface declarations exactly as sketched in spec §8 (`LlmProvider`, `PlayerProvider`, `TrackStore`, `CandidateSource`), using `Observable<T>` described as "any subscribable stream; concrete type chosen in app impl" — define a minimal local type:
```ts
export type Observable<T> = { subscribe: (cb: (v: T) => void) => () => void };
```
Full `seams.ts` content (copy from spec §8 verbatim, with the `Observable` alias above prepended and the `MusicTrack`/`RadioQueue`/etc. types imported from `./types`/`./sources`).

- [ ] **Step 4: Port `tags.ts` and `vibe.ts`**

Copy both files. Changes:
- `vibe.ts`: replace `import { createChat, isZaiConfigured } from "@/lib/ai/zai"` — `parseVibe(prompt)` becomes `parseVibe(prompt: string, llm: LlmProvider)`. Internally: `if (!llm.isConfigured()) return null;` and `content = await llm.chat({...})`. Keep `synthSeedQuery` unchanged.
- `tags.ts`: `ensureTagVectors` currently takes a `TagStore`; keep that. It does NOT call the LLM directly (the LLM call lives inside the `TagStore` impl in the app). So `tags.ts` needs no LLM injection. (The `TagStore` interface stays here; the app's `SupabaseTrackStore` implements `getTags`/`setTags` which is where the GLM call actually happens — confirmed by reading `subscription-agent/lib/music/tags-store.ts`.)
- Rename `videoId` → `trackId` in `TrackInput` and any id usage.

- [ ] **Step 5: Run test to verify it passes + commit**

Run: `pnpm --filter @music-ai/engine test` → PASS.
Add to `index.ts`: `export * from "./tags"; export * from "./vibe"; export * from "./seams";`
```bash
git add -A && git commit -m "feat(engine): port tags + vibe (LLM via injected provider)"
```

---

## Task 8: Port `sources.ts` behind `CandidateSource` + SC1 boundary test

**Files:**
- Create: `packages/music-engine/src/sources.ts`
- Create: `packages/music-engine/test/boundary.test.ts`
- Source: `subscription-agent/lib/music/sources.ts`

**Interfaces:**
- Produces: `CandidateSource` impl `createYoutubeCandidateSource()` returning `{ fetchRadio, fetchRelated, fetchArtistSongs, fetchPlaylistTracks, extendRadio }`; types `RadioQueue`, `RelatedShelves`.

- [ ] **Step 1: Write the failing SC1 boundary test**

`packages/music-engine/test/boundary.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = readdirSync(root).filter((f) => f.endsWith(".ts"));

describe("engine purity (SC1)", () => {
  for (const f of files) {
    it(`${f} has no app-framework imports`, () => {
      const src = readFileSync(join(root, f), "utf8");
      expect(src).not.toMatch(/from\s+["']next["']/);
      expect(src).not.toMatch(/from\s+["']@supabase\//);
      expect(src).not.toMatch(/from\s+["']react["']/);
      expect(src).not.toMatch(/"use client"/);
      expect(src).not.toMatch(/"server-only"/);
    });
  }
});
```

- [ ] **Step 2: Run test — may fail if any ported file has a banned import**

Run: `pnpm --filter @music-ai/engine test` → fix any `@supabase`/`next` import found in ported files (there shouldn't be any if Tasks 5–7 were clean).

- [ ] **Step 3: Port `sources.ts` behind the seam**

Copy `subscription-agent/lib/music/sources.ts`. Wrap the existing functions in a factory implementing `CandidateSource`:
```ts
import type { CandidateSource } from "./seams";

export function createYoutubeCandidateSource(): CandidateSource {
  return {
    fetchRadio: (seedTrackId: string) => fetchRadio(toYoutubeId(seedTrackId)),
    fetchRelated: (seedTrackId: string) => fetchRelated(toYoutubeId(seedTrackId)),
    fetchArtistSongs, fetchPlaylistTracks, extendRadio,
  };
}
/** SP-0: trackId is "yt:<videoId>". Strip the prefix for InnerTube calls. */
function toYoutubeId(trackId: string): string {
  return trackId.startsWith("yt:") ? trackId.slice(3) : trackId;
}
```
Also map each track returned by InnerTube from `{ videoId, channel, ... }` → source-neutral `{ trackId: "yt:" + videoId, sources: { youtube: videoId }, artist: channel, ... }`. Keep `RadioQueue`/`RelatedShelves` types; their `tracks: MusicTrack[]` now carry the source-neutral shape.

- [ ] **Step 4: Run full engine test suite + commit**

Run: `pnpm --filter @music-ai/engine test` → all PASS (boundary, source-neutral, ranking, vibe, smoke).
```bash
git add -A && git commit -m "feat(engine): port InnerTube sources behind CandidateSource + SC1 boundary test"
```

---

## Task 9: `recommend.ts` ported to injected seams

**Files:**
- Create: `packages/music-engine/src/recommend.ts`
- Create: `packages/music-engine/test/recommend.test.ts`
- Source: `subscription-agent/lib/music/recommend.ts`

**Interfaces:**
- Consumes: `CandidateSource`, `TrackStore`, `LlmProvider` (injected), `pickSeeds`/`score`/`assemble`/`sequence`/`ensureTagVectors`.
- Produces: `buildShelf(args)`, `buildRadio(args)`, `continueRadio(...)`.

- [ ] **Step 1: Failing test — buildShelf runs end-to-end through a mock CandidateSource**

`packages/music-engine/test/recommend.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildShelf } from "../src/recommend";
import type { CandidateSource } from "../src/seams";
import type { MusicTrack, HistoryEntry } from "../src/types";

const mockSource: CandidateSource = {
  fetchRadio: async () => ({ seedId: "yt:seed", tracks: [
    { trackId: "yt:r1", sources: { youtube: "r1" }, title: "r", artist: "a", thumbnail: null },
  ], continuation: null }),
  fetchRelated: async () => ({ alsoLike: [], similarArtistIds: [], playlistIds: [] }),
  fetchArtistSongs: async () => [], fetchPlaylistTracks: async () => [],
  extendRadio: async () => null,
};

describe("buildShelf", () => {
  it("produces a slate through injected seams without touching youtube directly", async () => {
    const history: HistoryEntry[] = [{
      trackId: "yt:seed", title: "s", artist: "a", thumbnail: null,
      playCount: 3, lastPlayedAt: new Date().toISOString(), skipCount: 0, completeCount: 1,
    }];
    const slate = await buildShelf({
      history, candidateSource: mockSource,
      // tagStore + llm stubs: skip the LLM prior (returns empty tag vectors)
      tagStore: { get: async () => null, set: async () => {} },
    });
    expect(slate.length).toBeGreaterThan(0);
    expect(slate[0].trackId.startsWith("yt:")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @music-ai/engine test` → FAIL.

- [ ] **Step 3: Port `recommend.ts` to a seams-injected signature**

Copy `subscription-agent/lib/music/recommend.ts`. Change the signatures from importing `./sources` directly to accepting injected deps:
```ts
export interface BuildShelfArgs {
  history: HistoryEntry[];
  candidateSource: CandidateSource;
  tagStore: { get: (id: string) => Promise<string[] | null>; set: (id: string, t: string[]) => Promise<void> };
  options?: ShelfOptions;
}
export async function buildShelf(args: BuildShelfArgs): Promise<MusicTrack[]> { /* same body, calls args.candidateSource.* */ }
```
Apply the identity rename (`videoId` → `trackId`). `buildRadio` and `continueRadio` get the same treatment (`continueRadio` stays a thin pass-through to `candidateSource.extendRadio`). Internal `fetchRadio`/`fetchRelated`/etc. calls become `args.candidateSource.fetchRadio(...)`.

- [ ] **Step 4: Run test to verify it passes + commit**

Run: `pnpm --filter @music-ai/engine test` → PASS.
Add to `index.ts`: `export * from "./recommend"; export * from "./sources";`
```bash
git add -A && git commit -m "feat(engine): port recommend to injected seams"
```

---

## Task 10: Schema migration + regenerate types

**Files:**
- Create: `supabase/migrations/0001_music_source_neutral.sql`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Produces: `music_plays.track_id` (renamed from `video_id`), new `music_track_sources` table.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0001_music_source_neutral.sql`:
```sql
-- Rename video_id → track_id on all music tables (source-neutral identity).
alter table music_plays rename column video_id to track_id;
alter table music_likes rename column video_id to track_id;
alter table music_suppressions rename column video_id to track_id;
alter table music_transitions rename column from_video_id to from_track_id;
alter table music_transitions rename column to_video_id to to_track_id;
alter table music_track_tags rename column video_id to track_id;

-- Per-track provider ids (one track → many provider sources). Populated with
-- {provider:'youtube', source_id:<videoId>} in SP-0; Spotify rows arrive in SP-3.
create table if not exists music_track_sources (
  track_id text not null,
  provider text not null check (provider in ('youtube','spotify')),
  source_id text not null,
  primary key (track_id, provider)
);
alter table music_track_sources enable row level security;
create policy "users see own sources" on music_track_sources
  for select using (exists (
    select 1 from music_plays p where p.track_id = music_track_sources.track_id));
```
(Adjust the exact `from_video_id`/`to_video_id` names if the live `music_transitions` schema differs — verify against `subscription-agent/supabase/migrations/` before running.)

- [ ] **Step 2: Apply + regenerate types**

Apply via Supabase MCP `apply_migration` (or `supabase db push`), then regenerate `lib/supabase/types.ts` (MCP `generate_typescript_types`, or `supabase gen types typescript`). Replace the Task 3 `Database = any` placeholder.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck` → PASS with real types.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(db): source-neutral music schema (track_id + music_track_sources)"
```

---

## Task 11: `TrackStore` Supabase impl

**Files:**
- Create: `lib/providers/track-store-supabase.ts`
- Source: `subscription-agent/lib/music/store.ts`, `tags-store.ts`

**Interfaces:**
- Consumes: `TrackStore` (from `@music-ai/engine`), `SupabaseClient`, regenerated `Database` types.
- Produces: `createSupabaseTrackStore(supabase, userId): TrackStore`.

- [ ] **Step 1: Failing test — recordPlay then loadHistory round-trip (mocked supabase)**

`lib/providers/track-store-supabase.test.ts`: mock a minimal supabase client (in-memory upsert/select), assert `recordPlay` then `loadHistory` returns the track with `trackId`. (Use a hand-rolled mock object implementing `from().select().eq().order().limit()` and `from().upsert()` — keep it small.)

- [ ] **Step 2: Run test to verify it fails** → `pnpm test` → FAIL.

- [ ] **Step 3: Implement**

Port `store.ts`'s `loadHistory`/`loadLikes`/`loadSuppressions`/`loadTransitionBias` and `tags-store.ts`'s `createDbTagStore` into one factory `createSupabaseTrackStore(supabase, userId)` returning a `TrackStore`. Rename all `video_id` → `track_id`, `channel` → `artist`. Add `recordPlay(userId, track)` (upsert into `music_plays`, incrementing `play_count`, stamping `last_played_at`) and `recordSignal(userId, trackId, "skip"|"complete")` (increment the respective counter).

- [ ] **Step 4: Run test to verify it passes + commit**

`pnpm test` → PASS.
```bash
git add -A && git commit -m "feat(providers): Supabase TrackStore"
```

---

## Task 12: `PlayerProvider` YouTube IFrame impl

**Files:**
- Create: `lib/providers/player-youtube.tsx`
- Source: `subscription-agent/features/dashboard/music/use-yt-player.ts`, `player-context.tsx`

**Interfaces:**
- Consumes: `PlayerProvider` (from `@music-ai/engine`).
- Produces: `<YoutubePlayerProvider>` + `usePlayer()` returning a `PlayerProvider`-shaped controller.

- [ ] **Step 1: Failing test — provider exposes the transport contract**

`lib/providers/player-youtube.test.tsx`: render the provider (jsdom — no real IFrame), assert `usePlayer()` returns `{ load, play, pause, next, seek, setVolume, state$ }` with correct types. Mock `window.YT` to avoid network.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement**

Copy `use-yt-player.ts` logic (lazy IFrame API load, fixed-portal mount, queue, volume mirror, signal emit on track start). Adapt:
- It loads a track by resolving `track.sources.youtube` (guard: if absent, skip — this is the SC2 runtime guarantee). The public `load(track: MusicTrack)` maps to `player.loadVideoById(track.sources.youtube)`.
- Expose the `PlayerProvider` interface: `load/play/pause/next/seek/setVolume` + `state$` as a simple subscribe-able emitter (implement `Observable<T>` from the seam: `{ subscribe(cb) { …return unsubscribe } }`).
- Preserve: the never-reparent-the-iframe portal behaviour, volume persistence via the `music_settings`-equivalent (or a local key in SP-0 — keep minimal), and the `onTrackStart` signal used to emit `recordPlay`.

- [ ] **Step 4: Run test to verify it passes + commit**

`pnpm test` → PASS.
```bash
git add -A && git commit -m "feat(providers): YouTube IFrame PlayerProvider"
```

---

## Task 13: `LlmProvider` GLM impl

**Files:**
- Create: `lib/providers/llm-glm.ts`
- Source: `subscription-agent/lib/ai/zai.ts`

**Interfaces:**
- Consumes: `LlmProvider` (from `@music-ai/engine`).
- Produces: `createGlmLlm(): LlmProvider`.

- [ ] **Step 1: Failing test — isConfigured reflects env, chat returns string (mocked OpenAI client)**

`lib/providers/llm-glm.test.ts`: with `ZAI_API_KEY` unset, `isConfigured()` is false; with it set + a mocked `OpenAI` constructor, `chat()` returns the mocked content.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement**

Copy `zai.ts`. Export `createGlmLlm(): LlmProvider` returning `{ isConfigured: () => Boolean(process.env.ZAI_API_KEY), chat: async (opts) => {…} }`. Keep the `thinking`/`json`/`maxTokens` handling and the OpenAI-compatible base URL default. Add `openai` as an app-level dep (`pnpm add openai`) — it lives in the app, NOT the engine.

- [ ] **Step 4: Run test to verify it passes + commit**

`pnpm test` → PASS.
```bash
git add -A && git commit -m "feat(providers): GLM LlmProvider"
```

---

## Task 14: Minimal proof page (SC3)

**Files:**
- Create: `app/layout.tsx` (wrap in `YoutubePlayerProvider`)
- Modify: `app/page.tsx` (the proof surface)
- Create: `app/api/music/shelf/route.ts` (server route wiring buildShelf through the seams)

**Interfaces:**
- Consumes: all four providers + `buildShelf` + `loadHistory`.

- [ ] **Step 1: Write the proof page**

`app/page.tsx` (client): on mount, fetch `/api/music/shelf`, render a list; clicking a row calls `usePlayer().load(track)`; on track start, `recordPlay` via `/api/music/plays` (POST). Show play/pause/next + skip/complete buttons that POST to `/api/music/signals`. This mirrors the subscription-agent widget's play/skip/like/discovery at the thinnest possible fidelity.

`app/api/music/shelf/route.ts` (server): get the signed-in user (SP-0: fall back to `DEMO_USER_ID` since auth is SP-1), build `createSupabaseTrackStore(serverClient, userId)`, `createYoutubeCandidateSource()`, `createGlmLlm()`, call `buildShelf({ history, candidateSource, tagStore, llm })`, return JSON.

- [ ] **Step 2: Manual UAT (behavior parity)**

Run `pnpm dev`. With a valid `ZAI_API_KEY` + Supabase env: play a track → it plays via YouTube IFrame; the discovery shelf populates; skipping a track within 30s records a skip; the shelf differs from a plain history shuffle. Confirm parity with the subscription-agent widget qualitatively. (Auth is mocked to `DEMO_USER_ID` for SP-0.)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(app): minimal proof page wired through four seams"
```

---

## Task 15: Build gate (SC4) + finalize

**Files:** none (verification + docs).

- [ ] **Step 1: Clean typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: both PASS.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: all green (boundary SC1, source-neutral SC2, ranking, vibe, recommend, providers).

- [ ] **Step 3: Verify the four success criteria explicitly**

- SC1: boundary.test.ts green (engine has no `next`/`@supabase`/`react` imports).
- SC2: source-neutral.test.ts green + recommend.test.ts green (spotify-only track + mock source flow through).
- SC3: Task 14 manual UAT passed.
- SC4: Step 1 passed.

- [ ] **Step 4: README + final commit**

Write `README.md` describing the workspace, how to run, the SP-0 scope, and that SP-1+ are separate cycles.
```bash
git add -A && git commit -m "docs: README + SP-0 complete"
```

---

## Self-Review (completed inline)

- **Spec coverage:** spec §7 in-scope items 1–5 → Tasks 1–4 (scaffold+package), 5–9 (engine+refactor), 10 (migration), 11–13 (seams impls), 14 (proof app). SC1→Task 8, SC2→Tasks 5/9, SC3→Task 14, SC4→Task 15. Out-of-scope items (auth, BYOK UI, ingestion, taste UI, DJ, legal) correctly absent.
- **Placeholder scan:** none. Each code step has real code or a concrete source-file port with explicit rename rules.
- **Type consistency:** `trackId` used uniformly across types/ranking/similarity/recommend/sources; `TrackStore`, `CandidateSource`, `LlmProvider`, `PlayerProvider` match between `seams.ts` (Task 7/8) and impls (Tasks 11–13). `buildShelf` signature consistent between Task 9 (define) and Task 14 (call).
- **One assumption flagged for the implementer:** Task 10's `music_transitions` column names (`from_video_id`/`to_video_id`) must be verified against the live schema before running the migration.
