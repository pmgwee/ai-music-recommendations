-- ============================================================================
-- SP-0 Task 10: Music schema, source-neutral (full CREATE).
--
-- Ported from subscription-agent's music migrations (0002, 0009, 0018, 0019,
-- 0020), unified into one CREATE migration because this project's Supabase is
-- empty. Renamed source-neutral so the recommender is not bolted to YouTube:
--   video_id       -> track_id
--   channel        -> artist
--   from_video_id  -> from_track_id
--   to_video_id    -> to_track_id
-- (and the matching p_* function params).
--
-- `google_tokens` and `set_updated_at()` are deliberately NOT ported: the YT
-- cookie sync was deleted upstream, and these tables use `default now()` (no
-- triggers). A new `music_track_sources` table is added so a track can resolve
-- to more than one provider (youtube today, spotify in a later story).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. music_plays — per-user listening history (powers "Listen again", ranker).
-- ----------------------------------------------------------------------------
create table if not exists public.music_plays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id text not null,
  title text not null,
  artist text not null default '',
  thumbnail text,
  play_count integer not null default 1,
  skip_count integer not null default 0,
  complete_count integer not null default 0,
  first_played_at timestamptz not null default now(),
  last_played_at timestamptz not null default now(),
  unique (user_id, track_id)
);

create index if not exists music_plays_recent_idx
  on public.music_plays(user_id, last_played_at desc);

alter table public.music_plays enable row level security;

drop policy if exists "music_plays_select_own" on public.music_plays;
create policy "music_plays_select_own" on public.music_plays
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_plays_insert_own" on public.music_plays;
create policy "music_plays_insert_own" on public.music_plays
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_plays_update_own" on public.music_plays;
create policy "music_plays_update_own" on public.music_plays
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- 2. music_likes — explicit positive signal (Hu/Koren/Volinsky confidence term).
--    Separate from music_plays because a like can target a track never played
--    (tapping the heart on a shelf row).
-- ----------------------------------------------------------------------------
create table if not exists public.music_likes (
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id text not null,
  title text not null,
  artist text not null default '',
  thumbnail text,
  liked_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index if not exists music_likes_recent_idx
  on public.music_likes(user_id, liked_at desc);

alter table public.music_likes enable row level security;

drop policy if exists "music_likes_select_own" on public.music_likes;
create policy "music_likes_select_own" on public.music_likes
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_likes_insert_own" on public.music_likes;
create policy "music_likes_insert_own" on public.music_likes
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_likes_delete_own" on public.music_likes;
create policy "music_likes_delete_own" on public.music_likes
  for delete using ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- 3. music_suppressions — "not interested" (until is null) / "snooze" (until
--    is a timestamp, ~30d). One row per track; snoozing a not-interested track
--    just refreshes the row.
-- ----------------------------------------------------------------------------
create table if not exists public.music_suppressions (
  user_id uuid not null references auth.users(id) on delete cascade,
  track_id text not null,
  kind text not null check (kind in ('not_interested', 'snooze')),
  until timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index if not exists music_suppressions_active_idx
  on public.music_suppressions(user_id, until);

alter table public.music_suppressions enable row level security;

drop policy if exists "music_suppressions_select_own" on public.music_suppressions;
create policy "music_suppressions_select_own" on public.music_suppressions
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_suppressions_insert_own" on public.music_suppressions;
create policy "music_suppressions_insert_own" on public.music_suppressions
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_suppressions_update_own" on public.music_suppressions;
create policy "music_suppressions_update_own" on public.music_suppressions
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "music_suppressions_delete_own" on public.music_suppressions;
create policy "music_suppressions_delete_own" on public.music_suppressions
  for delete using ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- 4. music_transitions — local-sequential model: how a specific A->B hand-off
--    actually went. Laplace-smoothed completion rate per transition is the
--    sequencing signal that closes the gap left by absent audio features.
-- ----------------------------------------------------------------------------
create table if not exists public.music_transitions (
  user_id uuid not null references auth.users(id) on delete cascade,
  from_track_id text not null,
  to_track_id text not null,
  skips integer not null default 0,
  completions integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, from_track_id, to_track_id)
);

create index if not exists music_transitions_from_idx
  on public.music_transitions(user_id, from_track_id);

alter table public.music_transitions enable row level security;

drop policy if exists "music_transitions_select_own" on public.music_transitions;
create policy "music_transitions_select_own" on public.music_transitions
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_transitions_insert_own" on public.music_transitions;
create policy "music_transitions_insert_own" on public.music_transitions
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_transitions_update_own" on public.music_transitions;
create policy "music_transitions_update_own" on public.music_transitions
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- 5. music_track_tags — catalog-global LLM-derived tag cache keyed on track_id
--    alone (a track's genre/mood/era is the same for everyone). Server-managed
--    cache; reads for any authenticated listener, writes via service role (bypasses
--    RLS — no insert/update/delete policy granted to cookie-scoped clients).
-- ----------------------------------------------------------------------------
create table if not exists public.music_track_tags (
  track_id text primary key,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.music_track_tags enable row level security;

drop policy if exists "music_track_tags_read" on public.music_track_tags;
create policy "music_track_tags_read" on public.music_track_tags
  for select using ((select auth.uid()) is not null);


-- ----------------------------------------------------------------------------
-- 6. music_settings — per-user player settings (volume today). One row per user.
-- ----------------------------------------------------------------------------
create table if not exists public.music_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  volume smallint not null default 50 check (volume between 0 and 100),
  updated_at timestamptz not null default now()
);

alter table public.music_settings enable row level security;

drop policy if exists "music_settings_own_all" on public.music_settings;
create policy "music_settings_own_all" on public.music_settings
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- ----------------------------------------------------------------------------
-- 7. music_track_sources — provider routing for a track. A track_id may resolve
--    to more than one provider (youtube now, spotify later); the engine reads
--    the row for the active provider to get the provider-native source_id.
--    Catalog-global like music_track_tags: server-managed, authenticated read,
--    writes via service role.
-- ----------------------------------------------------------------------------
create table if not exists public.music_track_sources (
  track_id text not null,
  provider text not null check (provider in ('youtube', 'spotify')),
  source_id text not null,
  primary key (track_id, provider)
);

alter table public.music_track_sources enable row level security;

drop policy if exists "music_track_sources_read" on public.music_track_sources;
create policy "music_track_sources_read" on public.music_track_sources
  for select using ((select auth.uid()) is not null);


-- ============================================================================
-- Functions (SQL, security invoker, empty search_path — RLS applies as caller).
-- ============================================================================

-- Atomic upsert-increment for a play. Refreshes metadata on conflict so the
-- "Listen again" shelf shows the latest title/artist/thumbnail.
create or replace function public.log_music_play(
  p_track_id text,
  p_title text,
  p_artist text,
  p_thumbnail text
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.music_plays (user_id, track_id, title, artist, thumbnail)
  values (auth.uid(), p_track_id, p_title, coalesce(p_artist, ''), p_thumbnail)
  on conflict (user_id, track_id) do update
    set play_count     = public.music_plays.play_count + 1,
        last_played_at = now(),
        title          = excluded.title,
        artist         = excluded.artist,
        thumbnail      = excluded.thumbnail;
$$;

revoke execute on function public.log_music_play(text, text, text, text) from anon;
grant execute on function public.log_music_play(text, text, text, text) to authenticated;


-- Record a skip (abandoned inside the first 30s) or a completion. No-op if the
-- track was never played (music_plays has no row to update).
create or replace function public.log_music_signal(
  p_track_id text,
  p_signal text
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.music_plays
     set skip_count     = public.music_plays.skip_count
                          + case when p_signal = 'skip' then 1 else 0 end,
         complete_count = public.music_plays.complete_count
                          + case when p_signal = 'complete' then 1 else 0 end
   where user_id = (select auth.uid())
     and track_id = p_track_id;
$$;

revoke execute on function public.log_music_signal(text, text) from anon;
grant execute on function public.log_music_signal(text, text) to authenticated;


-- Atomic upsert-increment for an A->B transition outcome.
create or replace function public.log_music_transition(
  p_from_track_id text,
  p_to_track_id text,
  p_signal text
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.music_transitions (user_id, from_track_id, to_track_id, skips, completions)
  values (
    (select auth.uid()),
    p_from_track_id,
    p_to_track_id,
    case when p_signal = 'skip' then 1 else 0 end,
    case when p_signal = 'complete' then 1 else 0 end
  )
  on conflict (user_id, from_track_id, to_track_id) do update
    set skips       = public.music_transitions.skips
                      + case when p_signal = 'skip' then 1 else 0 end,
        completions = public.music_transitions.completions
                      + case when p_signal = 'complete' then 1 else 0 end,
        updated_at  = now();
$$;

revoke execute on function public.log_music_transition(text, text, text) from anon;
grant execute on function public.log_music_transition(text, text, text) to authenticated;
