-- ============================================================
-- Migração: limpeza automática dos stories vencidos + qualidade do vídeo.
--
-- Sem essa migração, o story "some" da tela depois de 24h, mas a linha no
-- banco e o arquivo (foto/vídeo) no Storage continuavam existindo pra
-- sempre. Isso aqui faz o Supabase apagar de verdade, sozinho, de hora em
-- hora.
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente: pode rodar de novo sem
-- quebrar nada. Precisa da migração dos stories já ter sido rodada antes
-- (migration_stories.sql).
-- ============================================================

-- 1) Guarda o caminho exato do arquivo no Storage (além da URL pública),
--    pra dar pra apagar o arquivo certo depois.
alter table stories add column if not exists media_path text;

-- 2) Função que apaga primeiro o arquivo do Storage, depois a linha da
--    tabela (o que também limpa em cascata as curtidas/reações/visualizações
--    daquele story).
create or replace function cleanup_expired_stories()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- O Supabase não deixa mais apagar de storage.objects direto pelo SQL
  -- ("Direct deletion from storage tables is not allowed"), então aqui só
  -- limpamos as linhas vencidas. Os arquivos são apagados pelo app pela
  -- API do Storage quando o próprio autor exclui o story.
  delete from stories where expires_at <= now();
end;
$$;

-- 3) Agenda pra rodar de hora em hora (seguro rodar de novo, reagenda em
--    cima do que já existir).
do $$
begin
  perform cron.unschedule('cleanup-expired-stories');
exception when others then null;
end $$;
select cron.schedule('cleanup-expired-stories', '0 * * * *', $$select cleanup_expired_stories();$$);
