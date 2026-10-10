-- ============================================================
-- ENVIAR ALERTA de pagamento
--
-- O admin clica em "ENVIAR ALERTA" ao lado do nome (mensalista com
-- mensalidade em aberto, ou avulso que subiu e ainda não pagou) e a pessoa
-- recebe um pop-up cobrando o pagamento, na hora se estiver com o app
-- aberto, ou na próxima vez que abrir.
--
-- Rode inteiro no SQL Editor do Supabase. Idempotente.
-- ============================================================

create table if not exists payment_alerts (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  kind text not null check (kind in ('mensalista', 'avulso')),
  sent_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  seen_at timestamptz
);
create index if not exists payment_alerts_player_idx on payment_alerts (player_id, seen_at);
alter table payment_alerts enable row level security;

drop policy if exists "payment_alerts_select" on payment_alerts;
create policy "payment_alerts_select" on payment_alerts for select
  using (
    is_admin()
    or exists (select 1 from players p where p.id = player_id and p.user_id = auth.uid())
  );

drop policy if exists "payment_alerts_insert_admin" on payment_alerts;
create policy "payment_alerts_insert_admin" on payment_alerts for insert
  with check (is_admin());

-- O destinatário marca como visto (seen_at); admin também pode.
drop policy if exists "payment_alerts_update" on payment_alerts;
create policy "payment_alerts_update" on payment_alerts for update
  using (
    is_admin()
    or exists (select 1 from players p where p.id = player_id and p.user_id = auth.uid())
  )
  with check (
    is_admin()
    or exists (select 1 from players p where p.id = player_id and p.user_id = auth.uid())
  );

drop policy if exists "payment_alerts_delete_admin" on payment_alerts;
create policy "payment_alerts_delete_admin" on payment_alerts for delete
  using (is_admin());

do $$
begin
  alter publication supabase_realtime add table payment_alerts;
exception
  when duplicate_object then null;
end $$;
