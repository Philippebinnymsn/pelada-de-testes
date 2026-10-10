-- ============================================================
-- Conferir / consertar a publicação automática da lista de sexta 12h
--
-- Rode inteiro no SQL Editor do Supabase. Seguro rodar mais de uma vez:
--   1) garante que o agendador (pg_cron) está ligado e os 2 jobs existem
--   2) se a lista desta semana (segunda 21h) ainda NÃO foi criada, cria
--      agora — se já existe, não mexe em nada
--   3) mostra o histórico das últimas execuções do agendador (pra ver se
--      o job de hoje rodou e, se falhou, qual foi o erro)
-- ============================================================

create extension if not exists pg_cron;

-- 1) (Re)agenda os jobs — sexta 12h BRT (15h UTC) e terça 0h BRT (03h UTC)
do $$
begin
  perform cron.unschedule('publish-weekly-pelada');
exception when others then null;
end $$;
select cron.schedule('publish-weekly-pelada', '0 15 * * 5', $$select publish_weekly_pelada();$$);

do $$
begin
  perform cron.unschedule('close-weekly-pelada');
exception when others then null;
end $$;
select cron.schedule('close-weekly-pelada', '0 3 * * 2', $$select close_weekly_pelada();$$);

-- 2) Publica a lista desta semana agora, se ainda não existir
do $$
declare
  next_monday date := (now() at time zone 'America/Sao_Paulo')::date
    + ((8 - extract(dow from (now() at time zone 'America/Sao_Paulo'))::int) % 7);
begin
  if not exists (
    select 1 from peladas
    where kind = 'main'
      and status = 'open'
      and scheduled_for = (next_monday + time '21:00') at time zone 'America/Sao_Paulo'
  ) then
    perform publish_weekly_pelada();
    raise notice 'Lista da segunda % publicada agora.', next_monday;
  else
    raise notice 'A lista da segunda % já existia — nada foi alterado.', next_monday;
  end if;
end $$;

-- 3) Últimas execuções do agendador (status 'succeeded' ou 'failed' + erro)
select j.jobname, d.status, d.return_message,
       d.start_time at time zone 'America/Sao_Paulo' as inicio_brasilia
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
order by d.start_time desc
limit 15;
