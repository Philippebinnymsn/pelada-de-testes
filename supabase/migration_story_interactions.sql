-- ============================================================
-- Migração: curtida, reação em emoji e "quem viu" nos stories.
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente: pode rodar de novo sem
-- quebrar nada. Precisa da migração dos stories já ter sido rodada antes
-- (migration_stories.sql).
-- ============================================================

create table if not exists story_interactions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references stories(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  viewed_at timestamptz,
  liked_at timestamptz,
  reaction text,
  reacted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (story_id, player_id)
);
alter table story_interactions enable row level security;

drop policy if exists "select_story_interactions" on story_interactions;
create policy "select_story_interactions"
  on story_interactions for select
  to authenticated
  using (
    is_admin()
    or exists (select 1 from players p where p.id = player_id and p.user_id = auth.uid())
    or exists (
      select 1 from stories s
      join players p on p.id = s.player_id
      where s.id = story_id and p.user_id = auth.uid()
    )
  );

drop policy if exists "insert_story_interactions_own" on story_interactions;
create policy "insert_story_interactions_own"
  on story_interactions for insert
  to authenticated
  with check (
    exists (select 1 from players where players.id = player_id and players.user_id = auth.uid())
  );

drop policy if exists "update_story_interactions_own" on story_interactions;
create policy "update_story_interactions_own"
  on story_interactions for update
  to authenticated
  using (
    exists (select 1 from players where players.id = player_id and players.user_id = auth.uid())
  )
  with check (
    exists (select 1 from players where players.id = player_id and players.user_id = auth.uid())
  );
