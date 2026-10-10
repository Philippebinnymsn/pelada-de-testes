-- ============================================================
-- Migração: o CAIXA passa a ser a CONTA PIX (não depende mais de conta de
-- admin no app). Cada pagamento marcado como pago entra no caixa da conta
-- PIX escolhida como "conta do mês" no Financeiro.
--
-- Tudo que já foi pago até agora (e as saídas já lançadas) vai pro caixa
-- do PIX do Felipe Freitas, que era o PIX das cobranças.
--
-- Rode inteiro no SQL Editor do Supabase. Pode rodar mesmo que as
-- migrações migration_caixa_pix.sql / migration_caixa_felipe.sql tenham
-- falhado ou não tenham sido rodadas. Idempotente.
-- ============================================================

alter table membership_payments add column if not exists caixa_id text;
alter table presences add column if not exists caixa_id text;
alter table cash_expenses add column if not exists caixa_id text;

-- (coluna da tentativa anterior — mantida só pra trava abaixo funcionar
-- mesmo que a migração anterior não tenha sido rodada)
alter table membership_payments add column if not exists received_by uuid references auth.users(id) on delete set null;
alter table presences add column if not exists received_by uuid references auth.users(id) on delete set null;

-- Tudo que já existe vai pro caixa do PIX do Felipe Freitas: usa o id dessa
-- conta se ela já foi salva na lista de PIX; senão, o id fixo do PIX padrão.
do $$
declare
  felipe_caixa text;
begin
  select acc->>'id' into felipe_caixa
  from app_settings s, jsonb_array_elements(coalesce(s.value->'accounts', '[]'::jsonb)) acc
  where s.key = 'pix_settings'
    and lower(trim(acc->>'key')) = 'duostudiophoto@gmail.com'
  limit 1;

  felipe_caixa := coalesce(felipe_caixa, 'pix-padrao');

  update membership_payments set caixa_id = felipe_caixa where paid and caixa_id is null;
  update presences set caixa_id = felipe_caixa where paid and caixa_id is null;
  update cash_expenses set caixa_id = felipe_caixa where caixa_id is null;

  raise notice 'Registros antigos colocados no caixa %', felipe_caixa;
end $$;

-- Trava do pagamento avulso: usuário comum não mexe em nada disso.
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
      new.caixa_id := null;
    else
      new.paid := old.paid;
      new.paid_by := old.paid_by;
      new.paid_at := old.paid_at;
      new.received_by := old.received_by;
      new.caixa_id := old.caixa_id;
    end if;
  end if;
  return new;
end;
$$;
