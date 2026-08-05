-- OZONTECK - Precificação atualizada e participação de afiliados por produto
-- Execute no SQL Editor do Supabase ANTES de publicar a API e o Admin desta correção.
-- A migração é idempotente e não remove dados existentes.

BEGIN;

ALTER TABLE IF EXISTS public.product_pricing
  ADD COLUMN IF NOT EXISTS affiliate_program_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS installment_interest_policy TEXT NOT NULL DEFAULT 'customer_pays',
  ADD COLUMN IF NOT EXISTS payment_interest_policy TEXT NOT NULL DEFAULT 'customer_pays',
  ADD COLUMN IF NOT EXISTS tax_automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tax_regime TEXT,
  ADD COLUMN IF NOT EXISTS tax_annex TEXT,
  ADD COLUMN IF NOT EXISTS tax_revenue_12m NUMERIC(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS public.product_pricing_history
  ADD COLUMN IF NOT EXISTS affiliate_program_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS installment_interest_policy TEXT NOT NULL DEFAULT 'customer_pays',
  ADD COLUMN IF NOT EXISTS payment_interest_policy TEXT NOT NULL DEFAULT 'customer_pays',
  ADD COLUMN IF NOT EXISTS tax_automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tax_regime TEXT,
  ADD COLUMN IF NOT EXISTS tax_annex TEXT,
  ADD COLUMN IF NOT EXISTS tax_revenue_12m NUMERIC(14, 2) NOT NULL DEFAULT 0;

UPDATE public.product_pricing
SET affiliate_program_enabled = TRUE
WHERE affiliate_program_enabled IS NULL;

UPDATE public.product_pricing_history
SET affiliate_program_enabled = TRUE
WHERE affiliate_program_enabled IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_pricing_affiliate_program_enabled
  ON public.product_pricing (affiliate_program_enabled, updated_at DESC);

COMMENT ON COLUMN public.product_pricing.affiliate_program_enabled IS
  'Define se o produto participa do programa de afiliados. Quando falso, comissões, rede e bônus de metas são ignorados.';

COMMENT ON COLUMN public.product_pricing_history.affiliate_program_enabled IS
  'Snapshot da participação do produto no programa de afiliados no momento do histórico.';

COMMENT ON COLUMN public.product_pricing.tax_revenue_12m IS
  'Faturamento acumulado dos últimos 12 meses usado pela automação de imposto.';

COMMIT;

NOTIFY pgrst, 'reload schema';
