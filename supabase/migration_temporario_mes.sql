-- ============================================================
-- Migração: guarda QUANDO o mensalista temporário entrou, pra mostrar o
-- mês da troca na lista de interessados.
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente. Precisa das migrações
-- migration_pix_e_mensalista_temporario.sql e
-- migration_interesse_por_admin.sql já rodadas antes.
-- ============================================================

alter table players add column if not exists temp_started_at timestamptz;

-- Quem já estava como temporário antes dessa coluna existir fica com o mês
-- atual (melhor palpite disponível).
update players
  set temp_started_at = now()
  where temp_replaces_player_id is not null
    and membership_type = 'mensalista'
    and temp_started_at is null;

-- Trava de campos protegidos — mesma da migração anterior + a data da troca.
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
    new.temp_started_at := old.temp_started_at;
    new.membership_interest_by := old.membership_interest_by;
  end if;

  if new.membership_interest_at is not null and old.membership_interest_at is null then
    select coalesce(max(membership_interest_order), 0) + 1 into next_order from players;
    new.membership_interest_order := next_order;
  end if;
  if new.membership_interest_at is null then
    new.membership_interest_order := null;
    new.membership_interest_by := null;
  end if;
  -- Sem vaga temporária, sem data de troca.
  if new.temp_replaces_player_id is null then
    new.temp_started_at := null;
  end if;

  return new;
end;
$$;

-- A devolução automática (quando o mensalista original volta) também limpa
-- a data — já coberto pela trava acima, já que ela zera temp_replaces_player_id.
