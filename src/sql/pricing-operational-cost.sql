-- Adiciona o custo operacional separado para a aba de precificação.
-- Execute no SQL Editor do Supabase antes de salvar o campo separado no banco.

ALTER TABLE IF EXISTS public.product_pricing
  ADD COLUMN IF NOT EXISTS operational_cost NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS public.product_pricing_history
  ADD COLUMN IF NOT EXISTS operational_cost NUMERIC(12, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.product_pricing.operational_cost IS
  'Custo operacional rateado por pedido/produto: sistema, banco de dados, domínio, Render e ferramentas.';

COMMENT ON COLUMN public.product_pricing_history.operational_cost IS
  'Histórico do custo operacional usado no cálculo de precificação.';
