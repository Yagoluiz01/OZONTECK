-- OZONTECK - Integridade financeira e snapshot de custos (Etapa 1)
-- Execute no SQL Editor do Supabase ANTES de publicar a API desta etapa.
-- Todos os comandos usam IF NOT EXISTS para não apagar nem sobrescrever dados atuais.

BEGIN;

-- 1) Snapshot financeiro do pedido e dados reais do Mercado Pago.
ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS product_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ad_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_costs NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_type_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_installments INTEGER,
  ADD COLUMN IF NOT EXISTS financial_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2) Snapshot por item: preserva o custo usado no momento da compra.
ALTER TABLE IF EXISTS public.order_items
  ADD COLUMN IF NOT EXISTS unit_product_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_packaging_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_traffic_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_operational_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_other_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3) Campos usados pela fórmula completa da precificação.
ALTER TABLE IF EXISTS public.product_pricing
  ADD COLUMN IF NOT EXISTS operational_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_cost_in_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS network_commission_percent NUMERIC(8, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS goal_bonus_per_sale NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worst_goal_bonus_per_sale NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worst_goal_level_name TEXT,
  ADD COLUMN IF NOT EXISTS direct_commission_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS network_commission_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS goal_bonus_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS affiliate_total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS goal_analysis JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS public.product_pricing_history
  ADD COLUMN IF NOT EXISTS operational_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_cost_in_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS network_commission_percent NUMERIC(8, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS goal_bonus_per_sale NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worst_goal_bonus_per_sale NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worst_goal_level_name TEXT,
  ADD COLUMN IF NOT EXISTS direct_commission_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS network_commission_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS goal_bonus_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS affiliate_total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS goal_analysis JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.orders.financial_snapshot IS
  'Snapshot dos custos e comissões estimadas no momento em que o pedido foi criado.';
COMMENT ON COLUMN public.order_items.pricing_snapshot IS
  'Snapshot dos custos unitários da precificação usado no momento da compra.';
COMMENT ON COLUMN public.orders.gateway_fee IS
  'Taxa real do gateway registrada pelo webhook do pagamento.';
COMMENT ON COLUMN public.orders.payment_net_amount IS
  'Valor líquido recebido do gateway após as taxas.';

COMMIT;

-- Atualiza o cache de esquema do PostgREST/Supabase.
NOTIFY pgrst, 'reload schema';
