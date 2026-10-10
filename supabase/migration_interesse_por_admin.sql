-- ============================================================
-- Migração: admin inclui alguém na lista de interessados (aba Interessados)
-- e fica registrado QUAL admin incluiu (aparece só pra admin).
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente. Precisa da migração
-- migration_pix_e_mensalista_temporario.sql já ter sido rodada antes.
-- ============================================================

alter table players
  add column if not exists membership_interest_by uuid references auth.users(id) on delete set null;

-- Trava de campos protegidos — mesma da migração anterior, agora também
-- protegendo "quem incluiu": usuário comum não consegue se passar por admin,
-- e o registro some junto quando a pessoa sai da lista de interessados.
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

  return new;
end;
$$;
