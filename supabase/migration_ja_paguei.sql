-- ============================================================
-- Migração: botão "JÁ PAGUEI" da mensalidade
--
-- Guarda o mês ('YYYY-MM') em que o próprio mensalista avisou que já pagou.
-- Com isso o pop-up de cobrança da mensalidade para de aparecer pra ele
-- naquele mês (em qualquer aparelho), e o admin vê "informou que pagou" no
-- controle de pagamentos — quem confirma o pagamento de verdade continua
-- sendo o admin (check de "pago").
--
-- O próprio jogador pode gravar isso no card dele (política de update
-- própria que já existe). Rode inteiro no SQL Editor do Supabase.
-- Idempotente.
-- ============================================================

alter table players add column if not exists membership_reported_month text;
