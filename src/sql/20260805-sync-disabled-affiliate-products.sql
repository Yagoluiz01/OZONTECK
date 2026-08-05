-- OZONTECK - Sincroniza produtos removidos do programa de afiliados
-- Execute no SQL Editor do Supabase antes do deploy desta correção.
-- Idempotente: pode ser executado mais de uma vez.

BEGIN;

UPDATE public.affiliate_product_goal_targets AS target
SET
  is_active = FALSE,
  updated_at = NOW()
FROM public.product_pricing AS pricing
WHERE pricing.product_id = target.product_id
  AND pricing.affiliate_program_enabled = FALSE
  AND target.is_active = TRUE;

DELETE FROM public.affiliate_storefront_items AS item
USING public.product_pricing AS pricing
WHERE pricing.product_id = item.product_id
  AND pricing.affiliate_program_enabled = FALSE;

UPDATE public.product_pricing
SET
  status = 'healthy',
  risk_message = 'Precificação calculada sem custos do programa de afiliados.',
  updated_at = NOW()
WHERE affiliate_program_enabled = FALSE
  AND (
    status IS DISTINCT FROM 'healthy'
    OR risk_message IS DISTINCT FROM
      'Precificação calculada sem custos do programa de afiliados.'
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
