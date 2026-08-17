-- OZONTECK - Rollback da migration de transições de estoque
-- Restaura somente create_store_order_atomic e ensure_order_stock_reserved
-- para o comportamento anterior ao alerta de estoque de 2026-08-17.

BEGIN;

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

REVOKE ALL ON FUNCTION public.create_store_order_atomic(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_order_stock_reserved(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_store_order_atomic(JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_order_stock_reserved(UUID) TO service_role;

COMMIT;
