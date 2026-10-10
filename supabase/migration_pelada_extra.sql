-- ============================================================
-- Migração: suporte a "pelada extra" (lista avulsa fora do
-- cronograma semanal) + exclusão reversível ("apagar" vira
-- "arquivar", dá pra reabrir depois).
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor
-- → New query → cola tudo → Run). Idempotente: pode rodar de novo
-- sem quebrar nada.
-- ============================================================

-- 1) Cada pelada agora tem um "tipo": 'main' é a semanal de sempre
--    (a que o cron de sexta/terça mexe), 'extra' é uma lista avulsa
--    que o admin publica manualmente, sem afetar a semanal.
alter table peladas
  add column if not exists kind text not null default 'main';

do $$
begin
  alter table peladas
    add constraint peladas_kind_check check (kind in ('main', 'extra'));
exception when duplicate_object then null;
end $$;

-- 2) "status" ganha um terceiro valor: 'deleted'. Antes, excluir uma
--    lista apagava a linha (e as presenças junto, on delete cascade)
--    pra sempre. Agora "excluir" só muda o status pra 'deleted' — a
--    lista some da tela, mas continua salva e o admin pode reabrir.
--    "Apagar de vez" (esse sim sem volta) continua existindo como
--    ação separada, pra quem realmente quiser limpar.
alter table peladas
  drop constraint if exists peladas_status_check;
alter table peladas
  add constraint peladas_status_check check (status in ('open', 'closed', 'deleted'));

-- 3) Os jobs automáticos de sexta/terça só devem mexer na pelada
--    PRINCIPAL (semanal) — uma pelada extra aberta pelo admin não
--    pode ser fechada sozinha por esse cron.
create or replace function publish_weekly_pelada()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  next_monday date;
begin
  next_monday := current_date + ((8 - extract(dow from current_date)::int) % 7);
  update peladas set status = 'closed' where status = 'open' and kind = 'main';
  insert into peladas (scheduled_for, location, status, kind)
  values (
    (next_monday + time '21:00') at time zone 'America/Sao_Paulo',
    'Arena PSG',
    'open',
    'main'
  );
end;
$$;

create or replace function close_weekly_pelada()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update peladas set status = 'closed' where status = 'open' and kind = 'main';
end;
$$;

-- Nada mais precisa mudar: as policies de RLS existentes (select
-- pública, insert/update/delete só admin) já cobrem tudo isso, porque
-- "excluir" agora é um UPDATE (status='deleted'), não um DELETE.
