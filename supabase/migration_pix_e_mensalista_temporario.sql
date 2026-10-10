-- ============================================================
-- Migração: PIX do mês + Mensalista temporário
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente: pode rodar de novo sem
-- quebrar nada.
-- ============================================================

-- 1) Mensalista temporário ---------------------------------------------------
-- Quando o admin coloca um interessado no lugar de um mensalista, o
-- interessado vira mensalista e guarda aqui de quem é a vaga. Ele continua
-- com a data/posição dele na fila de interessados (membership_interest_at /
-- membership_interest_order), só some da lista enquanto está como mensalista
-- — quando a vaga for devolvida, volta exatamente pro mesmo lugar da fila.
alter table players
  add column if not exists temp_replaces_player_id uuid references players(id) on delete set null;

-- Trava de campos protegidos (só admin altera), agora incluindo a vaga
-- temporária. O "time do coração" saiu da trava: cada jogador pode escolher
-- o próprio pelo "Meu perfil".
create or replace function lock_player_protected_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_order integer;
begin
  if not is_admin() then
    new.name := old.name;
    new.rating := old.rating;
    new.is_gk := old.is_gk;
    new.position := old.position;
    new.user_id := old.user_id;
    new.membership_type := old.membership_type;
    new.membership_interest_order := old.membership_interest_order;
    new.temp_replaces_player_id := old.temp_replaces_player_id;
  end if;

  if new.membership_interest_at is not null and old.membership_interest_at is null then
    select coalesce(max(membership_interest_order), 0) + 1 into next_order from players;
    new.membership_interest_order := next_order;
  end if;
  if new.membership_interest_at is null then
    new.membership_interest_order := null;
  end if;

  return new;
end;
$$;

-- Quando o mensalista original volta a ser mensalista (por qualquer caminho:
-- botão "voltou", tela de Mensalistas, editar jogador...), quem estava no
-- lugar dele volta sozinho pra lista de interessados, na mesma posição.
create or replace function release_temp_mensalista()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.membership_type = 'mensalista' and old.membership_type is distinct from 'mensalista' then
    update players
      set membership_type = 'avulso', temp_replaces_player_id = null
      where temp_replaces_player_id = new.id and id <> new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists players_release_temp_mensalista on players;
create trigger players_release_temp_mensalista
  after update of membership_type on players
  for each row execute function release_temp_mensalista();

-- 2) PIX do mês --------------------------------------------------------------
-- Fica em app_settings (chave 'pix_settings'), que todo mundo já pode ler e
-- só admin altera. Tempo real ligado pra que a troca de PIX chegue na hora
-- em quem estiver com o app aberto.
do $$
begin
  alter publication supabase_realtime add table app_settings;
exception
  when duplicate_object then null;
end $$;
