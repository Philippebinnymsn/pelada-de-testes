-- ============================================================
-- Migração: reenquadrar fotos de capa (igual já dava pra fazer na foto de
-- perfil) + caixa de sugestões (qualquer pessoa logada manda uma sugestão
-- pelo "Minha conta", o admin vê quem mandou).
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente: pode rodar de novo sem
-- quebrar nada.
-- ============================================================

-- 1) Posição de cada foto de capa (uma coluna por capa, igual já existia
--    "photo_position" pra foto de perfil).
alter table players add column if not exists cover1_position text default '50% 50%';
alter table players add column if not exists cover2_position text default '50% 50%';
alter table players add column if not exists cover3_position text default '50% 50%';
alter table players add column if not exists cover4_position text default '50% 50%';
alter table players add column if not exists cover5_position text default '50% 50%';

-- 2) Caixa de sugestões.
create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references players(id) on delete set null,
  author_name text not null,
  author_email text,
  message text not null,
  status text not null default 'new' check (status in ('new', 'read')),
  created_at timestamptz not null default now()
);
alter table suggestions enable row level security;

drop policy if exists "select_suggestions_admin" on suggestions;
create policy "select_suggestions_admin"
  on suggestions for select
  to authenticated
  using (is_admin());

drop policy if exists "insert_suggestions_authenticated" on suggestions;
create policy "insert_suggestions_authenticated"
  on suggestions for insert
  to authenticated
  with check (auth.uid() is not null);

drop policy if exists "update_suggestions_admin" on suggestions;
create policy "update_suggestions_admin"
  on suggestions for update
  to authenticated
  using (is_admin())
  with check (is_admin());

drop policy if exists "delete_suggestions_admin" on suggestions;
create policy "delete_suggestions_admin"
  on suggestions for delete
  to authenticated
  using (is_admin());
