-- Normaliza produtos antigos no programa de afiliados.
-- Execute no SQL Editor do Supabase antes do deploy da API.

BEGIN;

UPDATE public.product_pricing
SET affiliate_program_enabled = TRUE
WHERE affiliate_program_enabled IS NULL;

ALTER TABLE public.product_pricing
  ALTER COLUMN affiliate_program_enabled SET DEFAULT TRUE,
  ALTER COLUMN affiliate_program_enabled SET NOT NULL;

UPDATE public.product_pricing_history
SET affiliate_program_enabled = TRUE
WHERE affiliate_program_enabled IS NULL;

ALTER TABLE public.product_pricing_history
  ALTER COLUMN affiliate_program_enabled SET DEFAULT TRUE,
  ALTER COLUMN affiliate_program_enabled SET NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
