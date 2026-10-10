-- ============================================================
-- Migração: pagamento cai no caixa de quem é dono do PIX do mês
--
-- Antes, o recebimento ia pro caixa do admin que marcou "pago". Agora vai
-- pro caixa do admin vinculado ao PIX ativo no momento do check
-- ("received_by"). Quem marcou continua guardado em updated_by / paid_by.
-- Qualquer admin pode mover um recebimento de caixa ou estornar depois.
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente.
-- ============================================================

alter table membership_payments
  add column if not exists received_by uuid references auth.users(id) on delete set null;
alter table presences
  add column if not exists received_by uuid references auth.users(id) on delete set null;

-- Registros antigos: ficam no caixa de quem marcou (comportamento de antes).
update membership_payments set received_by = updated_by
  where paid and received_by is null and updated_by is not null;
update presences set received_by = paid_by
  where paid and received_by is null and paid_by is not null;

-- Trava do pagamento avulso: usuário comum não mexe em nada disso
-- (agora incluindo o caixa de destino).
create or replace function lock_presence_paid_field()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    if tg_op = 'INSERT' then
      new.paid := false;
      new.paid_by := null;
      new.paid_at := null;
      new.received_by := null;
    else
      new.paid := old.paid;
      new.paid_by := old.paid_by;
      new.paid_at := old.paid_at;
      new.received_by := old.received_by;
    end if;
  end if;
  return new;
end;
$$;
