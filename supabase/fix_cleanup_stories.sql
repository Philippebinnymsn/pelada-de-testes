-- ============================================================
-- Conserta o job 'cleanup-expired-stories' (estava dando "failed":
-- "Direct deletion from storage tables is not allowed").
-- Agora só apaga as linhas vencidas da tabela stories.
-- Rode inteiro no SQL Editor do Supabase. Idempotente.
-- ============================================================
create or replace function cleanup_expired_stories()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from stories where expires_at <= now();
end;
$$;

select cleanup_expired_stories();

-- Confere o job de sexta 12h (publish-weekly-pelada) e os demais
select j.jobname, d.status, d.return_message,
       d.start_time at time zone 'America/Sao_Paulo' as inicio_brasilia
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname <> 'cleanup-expired-stories'
order by d.start_time desc
limit 10;
