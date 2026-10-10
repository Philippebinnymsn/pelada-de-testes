-- ============================================================
-- Migração: admin sobe um avulso da fila de espera direto pra lista
-- principal (CONFIRMADOS) a qualquer momento, mesmo sem vaga aberta por
-- ausência de mensalista.
--
-- Rode isso inteiro no SQL Editor do Supabase (Database → SQL Editor →
-- New query → cola tudo → Run). Idempotente: pode rodar de novo sem
-- quebrar nada.
-- ============================================================

alter table presences add column if not exists manually_promoted boolean not null default false;
