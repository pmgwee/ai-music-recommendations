-- ============================================================================
-- SP-3 Task 1: Playlist ingestion — `music_imports`.
--
-- Each row is one track imported from an external provider's playlist, kept
-- distinct from real listening history (music_plays) so an import can be
-- audited/cleared per source. Imports ALSO populate music_plays (cold-start
-- prior, play_count=1) and music_track_sources (provider routing) — but those
-- writes happen in app code (lib/ingest/import.ts), not in this migration.
--
-- PK (user_id, provider, source_playlist_id, track_id) makes a re-import of
-- the same playlist idempotent at the row level: importing the same Spotify
-- playlist twice updates in place rather than creating duplicates. The PK is
-- multi-column because the same track_id may legitimately appear under two
-- different source playlists (a user's "Liked Songs" and "Workout"), and we
-- want both rows.
--
-- RLS owner-only: each user reads/writes only their own imports. The
-- catalog-global side-effect tables (music_track_sources) still need the
-- service-role client (their RLS has no owner-write policy) — that's handled
-- in import.ts, same pattern as setTags.
-- ============================================================================


create table if not exists public.music_imports (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 'youtube' today; 'spotify' is the multi-source mixing case.
  provider text not null check (provider in ('youtube', 'spotify')),
  source_playlist_id text not null,
  source_playlist_name text not null default '',
  -- Canonical track_id (the engine's "yt:<videoId>" once resolved). NOT the
  -- provider-native source_id — that lives in music_track_sources.
  track_id text not null,
  -- ISRC of the source track when the provider exposed one (Spotify always
  -- does; YouTube rarely). Null for title-resolved imports.
  isrc text,
  imported_at timestamptz not null default now(),
  primary key (user_id, provider, source_playlist_id, track_id)
);

create index if not exists music_imports_user_idx
  on public.music_imports(user_id);

alter table public.music_imports enable row level security;

-- Single owner-all policy covers SELECT/INSERT/UPDATE/DELETE. Imports are
-- per-user provenance rows (not catalog-global like music_track_sources), so
-- the cookie-scoped server client owns all four operations.
drop policy if exists "music_imports_owner_all" on public.music_imports;
create policy "music_imports_owner_all" on public.music_imports
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
