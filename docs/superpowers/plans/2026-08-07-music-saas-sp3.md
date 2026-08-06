# SP-3 — Playlist ingestion (design + plan)

**Goal:** members connect YouTube + Spotify, import their playlists as **taste** (cold-start history prior), with YouTube tracks playing natively and Spotify tracks resolved to YouTube via **ISRC**. Per-source controls + a per-source taste budget so a big import can't drown the recommender.

**Status this run:** code-complete + **mock-tested**. Live OAuth (YouTube + Spotify) is pending the user's OAuth credentials at review — flows are scaffolded, token-exchange mocked. The ISRC resolver + import-as-taste logic (the IP) are fully built + tested.

**Predecessors:** SP-0 (engine, `music_track_sources`, `MusicTrack.isrc`), SP-2 (BYOK not needed here). Basis: the brainstorming decisions (YouTube-primary; Spotify = taste, ISRC-resolved; ISRC canonicalization is the mixing-integrity backbone; per-source budget).

## Decisions (defaults)
| # | Decision | Default |
|---|---|---|
| D1 | Schema | `music_imports` table: `(user_id, provider, source_playlist_id, source_playlist_name, track_id, isrc?, imported_at, pk(user_id, provider, source_playlist_id, track_id))`. Imports populate `music_track_sources` (the `(track_id, provider, source_id)` map from SP-0) so a track's provenance is queryable. RLS owner-only. |
| D2 | ISRC resolver | `resolveToYoutube(track: { title, artist, isrc? }, candidateSource): Promise<MusicTrack | null>` — if `isrc`, search YouTube Music by ISRC; the youtubei.js track metadata exposes ISRC, so match the search result whose ISRC equals the query. Fallback: title+artist search, pick the top result, mark lower confidence. Never fabricate — return null if no confident match. |
| D3 | Import-as-taste | Imported tracks become **cold-start history prior**: upsert into `music_plays` (play_count=1, a `first_played_at`/`last_played_at` at import time) — the engine's `buildShelf` already treats cold-start history as a soft prior that fades as real behaviour accrues. Mark imported rows distinctly (a `source` column value or the `music_imports` join) so they can be distinguished/cleared. |
| D4 | Per-source budget | Cap imports per source (e.g. 200 tracks/source/user) sampled if the playlist is larger, so a 2000-track Spotify library doesn't drown a 20-track YouTube one. `pickSeeds` already samples proportionally + forces long-tail; the budget is a user-legible backstop. |
| D5 | OAuth | YouTube: Google OAuth (`youtube.readonly` scope) via Supabase Auth's Google provider OR a dedicated OAuth flow — fetch playlists via the YouTube Data API. Spotify: Spotify OAuth (`playlist-read-private`) — fetch via the Spotify Web API. Both scaffolded this run with **mocked token exchange**; live pending creds. Tokens stored encrypted (reuse the BYOK crypto root key) in a `provider_tokens` table (or reuse `user_llm_keys`-style). |

## Architecture
- `lib/ingest/resolver.ts` — `resolveToYoutube` (ISRC-first, title+artist fallback) + tests (mocked candidateSource).
- `lib/ingest/import.ts` — `importPlaylist(user, provider, tracks): Promise<ImportResult>` — resolve each track → upsert `music_plays` (cold-start prior) + `music_imports` + `music_track_sources`; apply the per-source budget. Tests (mocked store + resolver).
- `lib/ingest/providers/{youtube,spotify}.ts` — the provider fetch adapters (list playlists, fetch tracks). YouTube: YouTube Data API (needs OAuth token). Spotify: Spotify Web API. **Scaffolded this run**; the fetch is mockable.
- `app/api/ingest/[provider]/connect/route.ts` + `/callback/route.ts` — OAuth connect/callback (PKCE). **Scaffolded + mocked token exchange** (live pending creds).
- `app/api/ingest/[provider]/playlists/route.ts` — list the connected user's playlists.
- `app/api/ingest/import/route.ts` — POST `{ provider, playlistId }` → importPlaylist.
- `app/(app)/library/page.tsx` — connect buttons + playlist list + import + per-source status/budget.

## Tasks
1. **Schema + ISRC resolver** — `music_imports` migration + types; `lib/ingest/resolver.ts` (ISRC-first, title fallback) + tests (mocked candidateSource.searchTracks returning tracks with/without ISRC).
2. **Import logic** — `lib/ingest/import.ts` (resolve → cold-start prior upsert + music_imports + music_track_sources + per-source budget) + tests (mocked store/resolver).
3. **Provider adapters + OAuth scaffolding** — `lib/ingest/providers/{youtube,spotify}.ts` (fetch adapters, mockable) + the connect/callback routes (PKCE, mocked token exchange, clearly marked "live pending creds") + encrypted token storage.
4. **API + UI** — playlists route + import route + `/library` page (connect, list, import, per-source budget/status).
5. **Gate + push.**

## Success criteria (this run, mock-tested)
- SC1. `resolveToYoutube` matches by ISRC when present; falls back to title+artist; returns null on no confident match.
- SC2. `importPlaylist` upserts cold-start history prior + `music_imports` + `music_track_sources`, applies the per-source budget (caps/samples).
- SC3. The OAuth routes are scaffolded + mock-token-exchange (not live until creds); the provider adapters are mockable. typecheck + build + tests clean; pushed.

## Open items (user, at review)
- **Apply `0003_music_imports.sql`** via Dashboard (I'll write it; you run it).
- **YouTube OAuth**: register a Google OAuth client (`youtube.readonly`) — set client id/secret in env. **Spotify OAuth**: register a Spotify Developer app (`playlist-read-private`) — set client id/secret. Then the connect flows go live.
- ISRC availability: YouTube Music InnerTube exposes ISRC on most official tracks — confirm the exact accessor against live data at review (the resolver tolerates its absence via the title fallback).
- Legal: importing a user's own Spotify playlists as taste (then playing via YouTube) is the lowest-risk Spotify integration (no Spotify streaming, no off-platform playback) — but it still touches Spotify's API under commercial use; XC legal review before public launch.
