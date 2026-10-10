-- ============================================================
-- Fechamento automático da lista principal: segunda-feira 13h (Brasília)
--
-- Às 13h de segunda, todo mensalista (menos goleiro) que ainda NÃO marcou
-- presença nem ausência na pelada principal aberta de hoje é colocado como
-- AUSENTE pelo sistema (auto_absent = true). Com isso o app sobe sozinho os
-- avulsos da lista de espera para as vagas abertas, e mostra os selos
-- "AUSENTE AUTOMÁTICO PELO SISTEMA" / "PRESENÇA AUTOMÁTICA PELO SISTEMA".
--
-- Quem foi colocado como ausente e quiser jogar depois das 13h entra na
-- lista de avulsos (o app já faz isso).
--
-- Rode inteiro no SQL Editor do Supabase. Idempotente.
-- ============================================================

alter table presences add column if not exists auto_absent boolean not null default false;

create extension if not exists pg_cron;

create or replace function auto_close_main_list()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  insert into presences (pelada_id, player_id, status, auto_absent)
  select pe.id, pl.id, 'absent', true
  from peladas pe
  join players pl
    on pl.membership_type = 'mensalista'
   and coalesce(pl.is_gk, false) = false
  where pe.status = 'open'
    and pe.kind = 'main'
    and (pe.scheduled_for at time zone 'America/Sao_Paulo')::date = hoje
  on conflict (pelada_id, player_id) do nothing;
end;
$$;

-- Segunda 13h BRT = 16h UTC
do $$
begin
  perform cron.unschedule('auto-close-main-list');
exception when others then null;
end $$;
select cron.schedule('auto-close-main-list', '0 16 * * 1', $$select auto_close_main_list();$$);
