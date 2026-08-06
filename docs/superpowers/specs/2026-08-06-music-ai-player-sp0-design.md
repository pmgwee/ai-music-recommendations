# Design Spec — AI Music Player (SaaS), SP-0: Source-Neutral Engine Foundation

- **Date:** 2026-08-06
- **Status:** Draft — awaiting user review
- **Author:** brainstorming session (superpowers:brainstorming)
- **Scope:** product-level architecture (context for all sub-projects) + detailed design of **SP-0**, the first implementable sub-project
- **Source repo:** `subscription-agent` (`lib/music/`, `features/dashboard/music/`, `lib/ai/zai.ts`)
- **Predecessor ADR:** ADR-0007 (LLM in the recommender — prior + intent, never the song-picker). This spec extends, does not override, ADR-0007.

---

## 1. Product context

Turn the existing music engine (currently a personal feature inside `subscription-agent`) into a **public, hosted, multi-tenant SaaS** — marketed as the first **BYOK, multi-source, transparent, learning** AI music player. The user connects their YouTube and/or Spotify playlists and brings their own LLM API key; the engine learns their taste over time and recommends tracks they'd love but haven't heard.

### Honest positioning (drives marketing + legal — see XC)

The literal claim "world's first AI music player" is **not substantiable**: Spotify DJ, YouTube Music "Ask Music," Apple Playlist Playground, and Deezer Text2Playlist all exist. The defensible, true differentiator:

> **First music player where the user owns their taste data *and* their LLM key, brings their own YouTube + Spotify playlists, and watches a transparent recommender learn their taste — powered by a behavioural engine that converges with their listening, not a black-box guess.**

Marketing must run on *that* claim. Substantiation is a first-class legal workstream (XC), gating launch.

## 2. Decisions log (locked during brainstorming)

| # | Decision | Choice | One-line rationale |
|---|---|---|---|
| D1 | Distribution | **Hosted SaaS** (you operate it) | Maximum reach + "world's first" marketing. Operator bears YT/Spotify ToS risk → legal is first-class (XC). |
| D2 | Playback | **YouTube-primary, source-neutral core** | Free for all users (no Premium gate at launch); `MusicTrack` decoupled from `videoId` so a Spotify player is additive later, not a rewrite. |
| D3 | Spotify tier | **Taste + ISRC-resolved YouTube playback**; SDK as a future optional Premium tier | Spotify playlists influence recs and *play* (via ISRC-matched YouTube audio) without excluding free users. Real Spotify audio is a later Premium upgrade. |
| D4 | LLM role | **Disciplined default** (prior + intent + top-N judge) **+ opt-in "LLM DJ" mode** | Preserves ADR-0007's integrity by default; the DJ ships as a *conversational steering layer over the ranker*, so it needs no usage data to launch (see §5). |
| D5 | v1 scope | **Maximalist** — all sub-projects in v1, each its own spec | The full pitch at launch. Each sub-project gets its own spec → plan → implementation cycle. |
| D6 | Repo | **New standalone repo**; engine extracted as a clean internal package | Clean break from `subscription-agent`; no release-cadence coupling to a personal app; engine publishable later. |

## 3. Architecture: a pure engine with four injected provider seams

The engine becomes an internal package (`packages/music-engine/`) with **zero app-framework dependencies** — no `next`, no `@supabase/*`, no `react`, no `server-only`. Boundary is enforced *physically*: the package's `package.json` does not declare those deps, so a leaky import fails to resolve at build time. (Data-source libraries such as `youtubei.js` are permitted — they are not app frameworks.)

The app injects four seams. The engine defines their interfaces; the app provides launch implementations.

| Seam | Responsibility | Launch impl | Future |
|---|---|---|---|
| `LlmProvider` | `chat(opts) → string`, `isConfigured()` | BYOK: OpenAI / Anthropic / Gemini / GLM (SP-2); SP-0 uses a server GLM key or a stub | org key, AI gateway |
| `PlayerProvider` | transport: load / play / pause / next / seek / volume / state stream | YouTube IFrame (preserving current fixed-portal + volume-mirror + signal-emit behaviour) | Spotify Web Playback SDK (Premium tier) |
| `TrackStore` | per-user history / likes / signals / transitions / tags CRUD | Supabase (RLS) | — |
| `CandidateSource` | radio / related / artist-songs / editorial / radio-continuation | anonymous InnerTube (`youtubei.js`), in-engine, behind the seam | official YT Data API, Spotify graph |

### Source-neutral track model (the SP-0 centerpiece)

Today `MusicTrack` is `videoId`-keyed end to end. SP-0 refactors it to a canonical, source-neutral shape so a track can carry one or more provider ids:

```ts
// packages/music-engine/src/types.ts
export interface TrackSources {
  youtube?: string;   // 11-char videoId
  spotify?: string;   // spotify track URI id
}
export interface MusicTrack {
  /** Canonical id. Prefer the ISRC when known (see §6); else a source-tagged
   *  composite e.g. `yt:<videoId>` or `sp:<spotifyId>` (resolved to ISRC later). */
  trackId: string;
  /** ISRC — the global canonical *recording* id. Load-bearing for dedup (§6). */
  isrc?: string;
  sources: TrackSources;
  title: string;
  artist: string;      // was `channel`
  thumbnail: string | null;
  durationMs?: number;
}
```

`videoId` (used today in every candidate, occurrence, store row, and signal) becomes `sources.youtube`. The pipeline keys on `trackId`; playback resolves the best available source (YouTube-primary).

## 4. Maximalist v1 roadmap (each sub-project → own spec)

| # | Sub-project | Deps | Hardest new piece |
|---|---|---|---|
| **SP-0** | Extract + source-neutral core + 4 provider seams | — | `videoId → trackId` refactor; package boundary |
| SP-1 | Hosted SaaS shell (auth, landing, accounts, RLS, rate-limit/abuse, product chrome) | SP-0 | abuse/quota on a scraped-source app |
| SP-2 | BYOK LLM layer (4 providers, encrypted key store, per-user settings, degrade rules) | SP-0 | encrypted key storage + safe degradation |
| SP-3 | Playlist ingestion (YT OAuth + import; Spotify OAuth + import-as-taste → ISRC resolver) | SP-0 | ISRC resolver + canonicalization + per-source budget |
| SP-4 | Taste-profile surface + always-fresh discovery + top-N diversity judge (now data-backed) | SP-0, SP-2 | taste-profile UX + judge gating (ADR-0007 "Deferred") |
| SP-5 | One-prompt playlists (productized `vibe.ts`) | SP-0, SP-2 | first-class prompt UI + grounding |
| SP-DJ | Opt-in LLM DJ mode (conversational layer over ranker) | SP-0, SP-2, SP-4 | DJ loop + grounded re-ranking within ranked slate |
| XC | Legal/ToS + cost/abuse + marketing substantiation (parallel, gates launch) | from SP-1 | YT InnerTube + Spotify commercial ToS; GDPR on taste data |

**Stack** (deliberately unchanged from today): Next.js App Router · Supabase (Auth + Postgres + RLS + Realtime) · Tailwind v4 · TypeScript · pnpm · Vercel.

## 5. LLM DJ reconciliation — ships cold without breaking ADR-0007

ADR-0007 deferred an **LLM ranker/judge** because that needs real usage data. The DJ (D4) is **not** that. It is a **conversational steering layer over the disciplined ranker** — the Spotify DJ / YouTube "Ask Music" pattern:

1. The behavioural ranker **always** generates the candidate slate (ADR-0007 intact).
2. The DJ LLM receives the user's live request ("something chill," "more like this," "who's this artist?") + the current slate + the taste profile, and **re-orders / selects / annotates strictly within the ranked candidates** — grounded, no hallucinated tracks, bounded to what the ranker produced.
3. **Graceful degradation:** no key / over-quota / parse failure → the disciplined default keeps playing; the DJ simply stops narrating. The music never breaks.

Because the DJ rides the ranker, it ships **cold** (no training/usage data required). ADR-0007's "wait for usage data" applied to an LLM *ranker*; the DJ is not a ranker. This is the reconciliation.

## 6. ISRC canonicalization — the integrity backbone of source mixing

Mixing YouTube + Spotify imports does **not** break the engine (radio and co-occurrence always come from YouTube Music regardless of a seed's origin; imports enter as soft `coldStart`/`likes` priors that fade as real behaviour accrues, and skip signals self-correct resolver errors). The one failure mode is **identity collision**: the same song arriving as multiple nodes (YT music video, YT "official audio," Spotify-resolved YT video), which splits play counts and pollutes co-occurrence.

**Mitigation:** use **ISRC** (the global canonical *recording* id, exposed by both Spotify and YouTube Music) as the canonical `trackId`. Same-ISRC tracks collapse to one node; per-source ids live in `sources`. This is the single design decision that makes multi-source mixing safe. It is therefore a **must-have of SP-3**, not optional.

- **Verify at SP-3:** the exact InnerTube field that exposes a track's ISRC (used by YT-Music dedup tools — confirm the accessor before relying on it).
- Fallback when ISRC is absent: title + artist + duration match, marked lower-confidence.

## 7. SP-0 detailed scope

### Goal
Prove the engine runs **source-neutral through four provider seams** in a new standalone repo. Not the SaaS, not ingestion, not the DJ. Just the architecture, validated end-to-end.

### In scope
1. **New repo scaffold** — Next.js App Router · Supabase · Tailwind v4 · TS · pnpm · Vercel (same stack).
2. **`packages/music-engine/`** — extracted from `subscription-agent/lib/music/`, zero app-framework deps:
   - `types.ts` → source-neutral `MusicTrack` (§3).
   - `ranking.ts`, `similarity.ts`, `recommend.ts`, `tags.ts`, `vibe.ts` ported with `videoId → trackId`.
   - `store.ts` → **interfaces only** (`TrackStore`); the Supabase impl moves to the app.
   - `sources.ts` (InnerTube) stays in-engine, behind the `CandidateSource` seam.
3. **Four provider seams** — interfaces in the engine, launch impls in the app (interface sketches in §8).
4. **Minimal runnable proof** — one page that plays a track, logs play/skip/like, builds the discovery shelf, and runs the LLM tag prior **through the seams**. Behaviour identical to today. Dev-mode single user (`DEMO_USER_ID`, like the current mock path) is acceptable.
5. **Schema migration** — `music_plays.video_id → track_id`; add `music_track_sources` (`track_id → {provider, id}`); RLS per-user retained. Regenerate `lib/supabase/types.ts`.

### Explicitly out of scope
Auth/signup/landing (SP-1) · BYOK UI + encrypted key store (SP-2) · playlist ingestion + ISRC resolver (SP-3) · taste UI / one-prompt productization / LLM DJ (SP-4 / SP-5 / SP-DJ) · legal workstream (XC, starts SP-1).

### Risks (the two hard parts)
- **R1 — `videoId → trackId` refactor.** Every candidate, occurrence, store row, and signal is `videoId`-keyed today. *Mitigation:* type-level rename + `sources` addition first, with **runtime unchanged** (every `trackId` still has exactly one `youtube` source). Generalization is then validated by a test in which a track carries only `sources.spotify`.
- **R2 — `PlayerProvider` abstraction.** Must preserve the current fixed-portal, volume-mirror, and signal-emit behaviour (`use-yt-player.ts`). *Mitigation:* the YouTube IFrame impl keeps all current behaviour; the seam exposes only transport + state streams.

### Success criteria (testable — the SP-0 exit gate)
- SC1. Engine package has zero `next` / `@supabase/*` / `react` imports — enforced by its `package.json` (a leaky import won't resolve).
- SC2. A unit test passes a `MusicTrack` with only `sources.spotify` (no `youtube`) through the pipeline; the engine does not assume YouTube until playback resolves it.
- SC3. The minimal app plays a track, logs play/skip/like, and builds the discovery shelf **identically to today**, now via the four seams.
- SC4. `pnpm typecheck` and `pnpm build` are clean.

## 8. Provider-seam interface sketches (SP-0 contracts)

```ts
// LlmProvider — replaces the direct lib/ai/zai.ts import
export interface LlmProvider {
  isConfigured(): boolean;
  chat(opts: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    temperature?: number;
    json?: boolean;
    maxTokens?: number;
    thinkingDisabled?: boolean;
  }): Promise<string>;
}

// PlayerProvider — abstracts use-yt-player.ts transport
export interface PlayerProvider {
  load(track: MusicTrack): Promise<void>;
  play(): void;
  pause(): void;
  next(): void;
  seek(seconds: number): void;
  setVolume(v: number): void;     // 0..100
  // observable state stream — concrete type chosen in the plan
  // (minimal emitter / RxJS / React signal). Not part of SP-0's contract lock.
  state$: Observable<{ current: MusicTrack | null; isPlaying: boolean; position: number; duration: number }>;
}

// TrackStore — interfaces only in the engine; Supabase impl in the app
export interface TrackStore {
  loadHistory(userId: string): Promise<HistoryEntry[]>;
  loadLikes(userId: string): Promise<LikedTrack[]>;
  loadSuppressions(userId: string): Promise<Suppressions>;
  recordPlay(userId: string, track: MusicTrack): Promise<void>;
  recordSignal(userId: string, trackId: string, signal: "skip" | "complete"): Promise<void>;
  loadTransitionBias(userId: string): Promise<Map<string, number>>;
  // tag cache (LLM prior) — keyed by trackId
  getTags(trackId: string): Promise<string[] | null>;
  setTags(trackId: string, tags: string[]): Promise<void>;
}

// CandidateSource — InnerTube impl lives in-engine behind this seam
export interface CandidateSource {
  fetchRadio(seedTrackId: string): Promise<RadioQueue>;
  fetchRelated(seedTrackId: string): Promise<RelatedShelves>;
  fetchArtistSongs(channelId: string): Promise<MusicTrack[]>;
  fetchPlaylistTracks(playlistId: string): Promise<MusicTrack[]>;
  extendRadio(continuation: string): Promise<RadioQueue | null>;
}
```

## 9. Open questions / to-verify (deferred out of SP-0)

- **ISRC accessor** in `youtubei.js` InnerTube metadata — confirm the field at SP-3 (§6).
- **Exact Spotify bitrate / HiFi status** — volatile; verify when speccing the Premium SDK tier (not in v1 playback).
- **Legal (XC):** YouTube InnerTube-scraping ToS at commercial scale; Spotify Developer ToS commercial-use + no-off-platform-playback clauses; "world's first" substantiation; GDPR for taste profiles. Run `grill-with-docs` over these before public launch.
- **Abuse / cost model** for a public multi-tenant app on a scraped candidate source — define in SP-1.

## 10. Next

This spec covers SP-0 only. Upon approval, invoke **`superpowers:writing-plans`** to produce the SP-0 implementation plan (task breakdown, file-level changes, build sequence, verification steps). Each subsequent sub-project (SP-1 … SP-DJ, XC) gets its own brainstorm → spec → plan cycle.
