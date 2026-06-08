-- OZONTECK - Blindagem de integridade, estoque e idempotência
-- APLICAR NO SUPABASE ANTES DE PUBLICAR ESTA API.
-- O script é aditivo: não remove colunas nem apaga pedidos existentes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS public_access_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS stock_reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stock_reservation_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stock_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stock_release_reason TEXT,
  ADD COLUMN IF NOT EXISTS shipping_label_processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS product_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ad_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_costs NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_type_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_installments INTEGER,
  ADD COLUMN IF NOT EXISTS financial_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS unit_product_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_packaging_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_traffic_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_operational_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_other_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_orders_public_access_token_hash
  ON public.orders(public_access_token_hash)
  WHERE public_access_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_stock_reservation_expiry
  ON public.orders(stock_reservation_expires_at)
  WHERE stock_reserved_at IS NOT NULL AND stock_released_at IS NULL;

CREATE TABLE IF NOT EXISTS public.integration_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  admin_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_lookup
  ON public.integration_oauth_states(provider, token_hash, expires_at)
  WHERE consumed_at IS NULL;

REVOKE ALL ON TABLE public.integration_oauth_states FROM anon, authenticated;
GRANT ALL ON TABLE public.integration_oauth_states TO service_role;

-- Pedido + itens + reserva de estoque em uma única transação.
CREATE OR REPLACE FUNCTION public.create_store_order_atomic(
  p_order JSONB,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_item JSONB;
  v_product public.products%ROWTYPE;
  v_product_id UUID;
  v_quantity INTEGER;
  v_items JSONB;
BEGIN
  IF jsonb_typeof(p_order) <> 'object' THEN
    RAISE EXCEPTION 'ORDER_PAYLOAD_INVALID';
  END IF;

  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED';
  END IF;

  INSERT INTO public.orders (
    order_number,
    customer_name,
    customer_email,
    customer_phone,
    customer_cpf,
    shipping_cep,
    shipping_address,
    shipping_number,
    shipping_complement,
    shipping_neighborhood,
    shipping_city,
    shipping_state,
    shipping_carrier,
    shipping_service_code,
    shipping_service_name,
    shipping_delivery_time,
    shipping_quote_raw,
    shipping_label_status,
    subtotal,
    shipping_amount,
    discount_amount,
    total_amount,
    affiliate_id,
    affiliate_ref_code,
    affiliate_coupon_code,
    affiliate_commission_rate,
    affiliate_commission_amount,
    product_cost,
    ad_cost,
    other_costs,
    financial_snapshot,
    payment_status,
    order_status,
    tracking_code,
    notes,
    public_access_token_hash,
    stock_reserved_at,
    stock_reservation_expires_at,
    stock_released_at,
    stock_release_reason
  ) VALUES (
    NULLIF(p_order->>'order_number', ''),
    NULLIF(p_order->>'customer_name', ''),
    lower(NULLIF(p_order->>'customer_email', '')),
    NULLIF(p_order->>'customer_phone', ''),
    NULLIF(p_order->>'customer_cpf', ''),
    NULLIF(p_order->>'shipping_cep', ''),
    NULLIF(p_order->>'shipping_address', ''),
    NULLIF(p_order->>'shipping_number', ''),
    NULLIF(p_order->>'shipping_complement', ''),
    NULLIF(p_order->>'shipping_neighborhood', ''),
    NULLIF(p_order->>'shipping_city', ''),
    NULLIF(p_order->>'shipping_state', ''),
    NULLIF(p_order->>'shipping_carrier', ''),
    NULLIF(p_order->>'shipping_service_code', ''),
    NULLIF(p_order->>'shipping_service_name', ''),
    NULLIF(p_order->>'shipping_delivery_time', '')::INTEGER,
    COALESCE(p_order->'shipping_quote_raw', '{}'::jsonb),
    COALESCE(NULLIF(p_order->>'shipping_label_status', ''), 'pending'),
    COALESCE(NULLIF(p_order->>'subtotal', '')::NUMERIC, 0),
    COALESCE(NULLIF(p_order->>'shipping_amount', '')::NUMERIC, 0),
    COALESCE(NULLIF(p_order->>'discount_amount', '')::NUMERIC, 0),
    COALESCE(NULLIF(p_order->>'total_amount', '')::NUMERIC, 0),
    NULLIF(p_order->>'affiliate_id', '')::UUID,
    NULLIF(p_order->>'affiliate_ref_code', ''),
    NULLIF(p_order->>'affiliate_coupon_code', ''),
    NULLIF(p_order->>'affiliate_commission_rate', '')::NUMERIC,
    NULLIF(p_order->>'affiliate_commission_amount', '')::NUMERIC,
    COALESCE(NULLIF(p_order->>'product_cost', '')::NUMERIC, 0),
    COALESCE(NULLIF(p_order->>'ad_cost', '')::NUMERIC, 0),
    COALESCE(NULLIF(p_order->>'other_costs', '')::NUMERIC, 0),
    COALESCE(p_order->'financial_snapshot', '{}'::jsonb),
    COALESCE(NULLIF(p_order->>'payment_status', ''), 'pending'),
    COALESCE(NULLIF(p_order->>'order_status', ''), 'pending'),
    COALESCE(p_order->>'tracking_code', ''),
    COALESCE(p_order->>'notes', ''),
    NULLIF(p_order->>'public_access_token_hash', ''),
    now(),
    now() + interval '24 hours',
    NULL,
    NULL
  )
  RETURNING * INTO v_order;

  -- A ordenação evita deadlock quando dois carrinhos possuem os mesmos produtos.
  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(p_items)
    ORDER BY value->>'product_id'
  LOOP
    BEGIN
      v_product_id := NULLIF(v_item->>'product_id', '')::UUID;
      v_quantity := GREATEST(COALESCE(NULLIF(v_item->>'quantity', '')::INTEGER, 0), 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'ORDER_ITEM_INVALID';
    END;

    IF v_product_id IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'ORDER_ITEM_INVALID';
    END IF;

    SELECT * INTO v_product
    FROM public.products
    WHERE id = v_product_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND:%', v_product_id;
    END IF;

    IF COALESCE(
      NULLIF(to_jsonb(v_product)->>'is_active', '')::BOOLEAN,
      lower(COALESCE(to_jsonb(v_product)->>'status', '')) = 'active'
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'PRODUCT_INACTIVE:%', v_product_id;
    END IF;

    IF COALESCE(v_product.stock_quantity, 0) < v_quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
        v_product_id,
        COALESCE(v_product.stock_quantity, 0),
        v_quantity;
    END IF;

    INSERT INTO public.order_items (
      order_id,
      product_id,
      product_name,
      sku,
      quantity,
      unit_price,
      total_price,
      unit_product_cost,
      unit_packaging_cost,
      unit_traffic_cost,
      unit_operational_cost,
      unit_other_cost,
      unit_total_cost,
      total_cost,
      pricing_snapshot
    ) VALUES (
      v_order.id,
      v_product_id,
      COALESCE(NULLIF(v_item->>'product_name', ''), v_product.name),
      COALESCE(NULLIF(v_item->>'sku', ''), v_product.sku, ''),
      v_quantity,
      COALESCE(NULLIF(v_item->>'unit_price', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'total_price', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'unit_product_cost', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'unit_packaging_cost', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'unit_traffic_cost', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'unit_operational_cost', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'unit_other_cost', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'unit_total_cost', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_item->>'total_cost', '')::NUMERIC, 0),
      COALESCE(v_item->'pricing_snapshot', '{}'::jsonb)
    );

    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - v_quantity,
           updated_at = now()
     WHERE id = v_product_id;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(oi) ORDER BY oi.created_at, oi.id), '[]'::jsonb)
    INTO v_items
  FROM public.order_items oi
  WHERE oi.order_id = v_order.id;

  RETURN jsonb_build_object(
    'success', true,
    'order', to_jsonb(v_order),
    'items', v_items
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_order_stock(
  p_order_id UUID,
  p_reason TEXT DEFAULT 'cancelled'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_item RECORD;
BEGIN
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'order_not_found');
  END IF;

  IF v_order.stock_reserved_at IS NULL THEN
    RETURN jsonb_build_object('success', true, 'released', false, 'reason', 'stock_was_not_reserved');
  END IF;

  IF v_order.stock_released_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'released', false, 'reason', 'already_released');
  END IF;

  FOR v_item IN
    SELECT product_id, SUM(quantity)::INTEGER AS quantity
    FROM public.order_items
    WHERE order_id = p_order_id
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity,
           updated_at = now()
     WHERE id = v_item.product_id;
  END LOOP;

  UPDATE public.orders
     SET stock_released_at = now(),
         stock_release_reason = LEFT(COALESCE(p_reason, 'cancelled'), 180)
   WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'released', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_order_stock_reserved(
  p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_item RECORD;
  v_product public.products%ROWTYPE;
BEGIN
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reserved', false, 'reason', 'order_not_found');
  END IF;

  IF v_order.stock_reserved_at IS NOT NULL AND v_order.stock_released_at IS NULL THEN
    RETURN jsonb_build_object('success', true, 'reserved', true, 'reason', 'already_reserved');
  END IF;

  FOR v_item IN
    SELECT product_id, SUM(quantity)::INTEGER AS quantity
    FROM public.order_items
    WHERE order_id = p_order_id
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    SELECT * INTO v_product
    FROM public.products
    WHERE id = v_item.product_id
    FOR UPDATE;

    IF NOT FOUND OR COALESCE(v_product.stock_quantity, 0) < v_item.quantity THEN
      RETURN jsonb_build_object(
        'success', false,
        'reserved', false,
        'reason', 'insufficient_stock',
        'product_id', v_item.product_id
      );
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT product_id, SUM(quantity)::INTEGER AS quantity
    FROM public.order_items
    WHERE order_id = p_order_id
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - v_item.quantity,
           updated_at = now()
     WHERE id = v_item.product_id;
  END LOOP;

  UPDATE public.orders
     SET stock_reserved_at = now(),
         stock_reservation_expires_at = now() + interval '24 hours',
         stock_released_at = NULL,
         stock_release_reason = NULL
   WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'reserved', true, 'reason', 'reserved_again');
END;
$$;

CREATE OR REPLACE FUNCTION public.release_expired_order_stock_reservations(
  p_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_result JSONB;
  v_count INTEGER := 0;
BEGIN
  FOR v_order IN
    SELECT id
    FROM public.orders
    WHERE stock_reserved_at IS NOT NULL
      AND stock_released_at IS NULL
      AND stock_reservation_expires_at < now()
      AND lower(COALESCE(payment_status, '')) NOT IN ('paid','approved','pago','aprovado')
    ORDER BY stock_reservation_expires_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_result := public.release_order_stock(v_order.id, 'reservation_expired');
    IF COALESCE((v_result->>'released')::BOOLEAN, false) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'released_count', v_count);
END;
$$;

-- Claim atômico da geração de etiqueta para impedir compras duplicadas no Melhor Envio.
CREATE OR REPLACE FUNCTION public.claim_order_shipping_label_generation(
  p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_status TEXT;
BEGIN
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'claimed', false, 'reason', 'order_not_found');
  END IF;

  v_status := lower(trim(COALESCE(v_order.shipping_label_status, '')));

  IF COALESCE(v_order.shipping_shipment_id, '') <> ''
     OR COALESCE(v_order.shipping_tracking_code, '') <> ''
     OR COALESCE(v_order.tracking_code, '') <> ''
     OR v_status IN ('awaiting_shipping_label','cart_created','generated','shipped','posted','delivered') THEN
    RETURN jsonb_build_object(
      'success', true,
      'claimed', false,
      'reason', 'label_already_in_progress_or_done',
      'status', v_status
    );
  END IF;

  IF v_status = 'processing'
     AND v_order.shipping_label_processing_started_at IS NOT NULL
     AND v_order.shipping_label_processing_started_at > now() - interval '10 minutes' THEN
    RETURN jsonb_build_object(
      'success', true,
      'claimed', false,
      'reason', 'label_generation_claimed_by_another_worker',
      'status', v_status
    );
  END IF;

  UPDATE public.orders
     SET shipping_label_status = 'processing',
         shipping_label_processing_started_at = now(),
         shipping_label_error = ''
   WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'claimed', true, 'reason', 'claim_acquired');
END;
$$;

-- Transição financeira atômica. Somente a primeira mudança efetiva fica com claimed=true.
CREATE OR REPLACE FUNCTION public.apply_mercado_pago_payment_transition(
  p_external_reference TEXT,
  p_payment_id TEXT,
  p_raw_status TEXT,
  p_gateway_fee NUMERIC DEFAULT 0,
  p_net_amount NUMERIC DEFAULT 0,
  p_payment_method_id TEXT DEFAULT NULL,
  p_payment_type_id TEXT DEFAULT NULL,
  p_installments INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_status TEXT := lower(trim(COALESCE(p_raw_status, '')));
  v_previous_status TEXT;
  v_claimed BOOLEAN := false;
  v_match_count INTEGER := 0;
BEGIN
  SELECT count(*) INTO v_match_count
  FROM public.orders
  WHERE payment_external_reference = p_external_reference
     OR order_number = p_external_reference;

  IF v_match_count > 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'ambiguous_external_reference');
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE payment_external_reference = p_external_reference
     OR order_number = p_external_reference
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'order_not_found');
  END IF;

  v_previous_status := lower(COALESCE(v_order.payment_status, ''));

  IF COALESCE(trim(p_payment_id), '') <> '' AND EXISTS (
    SELECT 1
    FROM public.orders other_order
    WHERE other_order.payment_reference = p_payment_id
      AND other_order.id <> v_order.id
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'payment_id_already_linked_to_another_order');
  END IF;

  IF v_status = 'approved' THEN
    IF v_previous_status IN ('paid','approved','pago','aprovado') THEN
      RETURN jsonb_build_object(
        'success', true,
        'claimed', false,
        'reason', 'already_paid',
        'order', to_jsonb(v_order)
      );
    END IF;

    UPDATE public.orders
       SET payment_gateway = COALESCE(NULLIF(payment_gateway, ''), 'mercado_pago'),
           payment_reference = p_payment_id,
           payment_external_reference = p_external_reference,
           payment_raw_status = v_status,
           payment_status = 'paid',
           paid_at = COALESCE(paid_at, now()),
           order_status = CASE
             WHEN lower(COALESCE(order_status, '')) IN ('shipped','enviado','delivered','entregue')
               THEN order_status
             ELSE 'paid'
           END,
           webhook_last_event = 'payment',
           gateway_fee = COALESCE(p_gateway_fee, 0),
           payment_net_amount = COALESCE(p_net_amount, 0),
           payment_method_id = p_payment_method_id,
           payment_type_id = p_payment_type_id,
           payment_installments = p_installments
     WHERE id = v_order.id
     RETURNING * INTO v_order;

    v_claimed := true;
  ELSIF v_status IN ('pending','in_process') THEN
    IF v_previous_status IN ('paid','approved','pago','aprovado') THEN
      RETURN jsonb_build_object(
        'success', true,
        'claimed', false,
        'reason', 'paid_order_ignores_pending',
        'order', to_jsonb(v_order)
      );
    END IF;

    IF COALESCE(v_order.payment_reference, '') = COALESCE(p_payment_id, '')
       AND lower(COALESCE(v_order.payment_raw_status, '')) = v_status THEN
      RETURN jsonb_build_object(
        'success', true,
        'claimed', false,
        'reason', 'duplicate_status',
        'order', to_jsonb(v_order)
      );
    END IF;

    UPDATE public.orders
       SET payment_reference = p_payment_id,
           payment_external_reference = p_external_reference,
           payment_raw_status = v_status,
           payment_status = 'pending',
           webhook_last_event = 'payment',
           gateway_fee = COALESCE(p_gateway_fee, 0),
           payment_net_amount = COALESCE(p_net_amount, 0),
           payment_method_id = p_payment_method_id,
           payment_type_id = p_payment_type_id,
           payment_installments = p_installments
     WHERE id = v_order.id
     RETURNING * INTO v_order;

    v_claimed := true;
  ELSIF v_status IN ('rejected','cancelled','refunded','charged_back') THEN
    IF COALESCE(v_order.payment_reference, '') = COALESCE(p_payment_id, '')
       AND lower(COALESCE(v_order.payment_raw_status, '')) = v_status THEN
      RETURN jsonb_build_object(
        'success', true,
        'claimed', false,
        'reason', 'duplicate_status',
        'order', to_jsonb(v_order)
      );
    END IF;

    UPDATE public.orders
       SET payment_reference = p_payment_id,
           payment_external_reference = p_external_reference,
           payment_raw_status = v_status,
           payment_status = 'failed',
           order_status = CASE
             WHEN v_status IN ('cancelled','refunded','charged_back') THEN 'cancelled'
             ELSE order_status
           END,
           webhook_last_event = 'payment',
           gateway_fee = COALESCE(p_gateway_fee, 0),
           payment_net_amount = COALESCE(p_net_amount, 0),
           payment_method_id = p_payment_method_id,
           payment_type_id = p_payment_type_id,
           payment_installments = p_installments
     WHERE id = v_order.id
     RETURNING * INTO v_order;

    v_claimed := true;
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'claimed', false,
      'reason', 'unsupported_status',
      'order', to_jsonb(v_order)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'claimed', v_claimed,
    'previous_payment_status', v_previous_status,
    'order', to_jsonb(v_order)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_store_order_atomic(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_order_stock(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_order_stock_reserved(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_expired_order_stock_reservations(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_order_shipping_label_generation(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_mercado_pago_payment_transition(TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_store_order_atomic(JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_order_stock(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_order_stock_reserved(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_expired_order_stock_reservations(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_order_shipping_label_generation(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_mercado_pago_payment_transition(TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, INTEGER) TO service_role;

COMMIT;

-- Índices únicos só são criados se os dados atuais não tiverem conflitos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE order_number IS NOT NULL AND btrim(order_number) <> ''
    GROUP BY order_number
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_order_number
      ON public.orders(order_number)
      WHERE order_number IS NOT NULL AND btrim(order_number) <> '';
  ELSE
    RAISE WARNING 'uq_orders_order_number não criado: existem números de pedido duplicados.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.customers
    WHERE email IS NOT NULL AND btrim(email) <> ''
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_email_normalized
      ON public.customers(lower(btrim(email)))
      WHERE email IS NOT NULL AND btrim(email) <> '';
  ELSE
    RAISE WARNING 'uq_customers_email_normalized não criado: existem e-mails de clientes duplicados.';
  END IF;
END $$;


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE payment_external_reference IS NOT NULL AND btrim(payment_external_reference) <> ''
    GROUP BY payment_external_reference
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_payment_external_reference
      ON public.orders(payment_external_reference)
      WHERE payment_external_reference IS NOT NULL AND btrim(payment_external_reference) <> '';
  ELSE
    RAISE WARNING 'uq_orders_payment_external_reference não criado: existem referências externas duplicadas.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE payment_reference IS NOT NULL AND btrim(payment_reference) <> ''
    GROUP BY payment_reference
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_payment_reference
      ON public.orders(payment_reference)
      WHERE payment_reference IS NOT NULL AND btrim(payment_reference) <> '';
  ELSE
    RAISE WARNING 'uq_orders_payment_reference não criado: existem IDs de pagamento duplicados.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.affiliate_conversions
    WHERE conversion_type = 'sale_commission' AND order_id IS NOT NULL
    GROUP BY order_id
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_sale_commission_per_order
      ON public.affiliate_conversions(order_id)
      WHERE conversion_type = 'sale_commission' AND order_id IS NOT NULL;
  ELSE
    RAISE WARNING 'uq_affiliate_sale_commission_per_order não criado: existem comissões de venda duplicadas.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.affiliate_conversions
    WHERE conversion_type = 'recruitment_bonus' AND order_id IS NOT NULL
    GROUP BY order_id, affiliate_id, recruited_affiliate_id
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_recruitment_bonus_per_order
      ON public.affiliate_conversions(order_id, affiliate_id, recruited_affiliate_id)
      WHERE conversion_type = 'recruitment_bonus' AND order_id IS NOT NULL;
  ELSE
    RAISE WARNING 'uq_affiliate_recruitment_bonus_per_order não criado: existem bônus de recrutamento duplicados.';
  END IF;
END $$;


DO $$
BEGIN
  IF to_regclass('public.customer_activation_offers') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.customer_activation_offers
      WHERE order_id IS NOT NULL
      GROUP BY order_id
      HAVING count(*) > 1
    ) THEN
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_activation_offer_per_order
        ON public.customer_activation_offers(order_id)
        WHERE order_id IS NOT NULL;
    ELSE
      RAISE WARNING 'uq_customer_activation_offer_per_order não criado: existem ofertas duplicadas.';
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Resultado final visível no SQL Editor. Todos os itens devem retornar true antes do deploy.
SELECT
  to_regprocedure('public.create_store_order_atomic(jsonb,jsonb)') IS NOT NULL AS create_store_order_atomic_ok,
  to_regprocedure('public.release_order_stock(uuid,text)') IS NOT NULL AS release_order_stock_ok,
  to_regprocedure('public.ensure_order_stock_reserved(uuid)') IS NOT NULL AS ensure_order_stock_reserved_ok,
  to_regprocedure('public.release_expired_order_stock_reservations(integer)') IS NOT NULL AS cleanup_stock_reservations_ok,
  to_regprocedure('public.claim_order_shipping_label_generation(uuid)') IS NOT NULL AS shipping_label_claim_ok,
  to_regprocedure('public.apply_mercado_pago_payment_transition(text,text,text,numeric,numeric,text,text,integer)') IS NOT NULL AS payment_transition_ok,
  to_regclass('public.uq_orders_order_number') IS NOT NULL AS uq_order_number_ok,
  to_regclass('public.uq_customers_email_normalized') IS NOT NULL AS uq_customer_email_ok,
  to_regclass('public.uq_orders_payment_external_reference') IS NOT NULL AS uq_payment_external_reference_ok,
  to_regclass('public.uq_orders_payment_reference') IS NOT NULL AS uq_payment_reference_ok,
  to_regclass('public.uq_affiliate_sale_commission_per_order') IS NOT NULL AS uq_sale_commission_ok,
  to_regclass('public.uq_affiliate_recruitment_bonus_per_order') IS NOT NULL AS uq_recruitment_bonus_ok;
