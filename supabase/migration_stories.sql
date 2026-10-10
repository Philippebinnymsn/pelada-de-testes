-- ============================================================
-- Migração: Stories (fotos/vídeos temporários, estilo Instagram).
-- Qualquer jogador logado posta uma foto ou vídeo que some sozinho
-- depois de 24h. Aparecem em bolinhas no topo da Home.
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente: pode rodar de novo sem
-- quebrar nada.
-- ============================================================

create table if not exists stories (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('image', 'video')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
alter table stories enable row level security;

drop policy if exists "select_stories_public" on stories;
create policy "select_stories_public"
  on stories for select
  to anon, authenticated
  using (true);

drop policy if exists "insert_stories_own" on stories;
create policy "insert_stories_own"
  on stories for insert
  to authenticated
  with check (
    exists (select 1 from players where players.id = player_id and players.user_id = auth.uid())
  );

drop policy if exists "delete_stories_owner_or_admin" on stories;
create policy "delete_stories_owner_or_admin"
  on stories for delete
  to authenticated
  using (
    is_admin()
    or exists (select 1 from players where players.id = player_id and players.user_id = auth.uid())
  );

-- Storage: bucket público pra foto/vídeo dos stories.
insert into storage.buckets (id, name, public)
values ('stories', 'stories', true)
on conflict (id) do nothing;

drop policy if exists "select_stories_media_public" on storage.objects;
create policy "select_stories_media_public"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'stories');

drop policy if exists "insert_stories_media_authenticated" on storage.objects;
create policy "insert_stories_media_authenticated"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'stories');

drop policy if exists "delete_stories_media_authenticated" on storage.objects;
create policy "delete_stories_media_authenticated"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'stories');
