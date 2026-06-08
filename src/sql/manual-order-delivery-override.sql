-- OZONTECK - confirmação manual auditada de entrega
-- Execute este arquivo no Supabase antes de publicar a API que usa estas RPCs.
-- A implementação reaproveita shipping_label_raw para manter o histórico sem
-- adicionar novas colunas à tabela orders.

begin;

create or replace function public.confirm_order_manual_delivery(
  p_order_id uuid,
  p_admin_id uuid,
  p_admin_email text,
  p_admin_name text,
  p_reason text,
  p_tracking_code text default null,
  p_shipping_carrier text default null,
  p_admin_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_now timestamptz := now();
  v_reason text := trim(coalesce(p_reason, ''));
  v_raw jsonb;
  v_manual jsonb;
  v_payment_status text;
  v_order_status text;
begin
  if p_order_id is null then
    raise exception 'Pedido não informado.';
  end if;

  if p_admin_id is null then
    raise exception 'Administrador responsável não informado.';
  end if;

  if length(v_reason) < 10 then
    raise exception 'Informe um motivo com pelo menos 10 caracteres.';
  end if;

  if length(v_reason) > 500 then
    raise exception 'O motivo da entrega manual deve ter no máximo 500 caracteres.';
  end if;

  select *
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido não encontrado.';
  end if;

  v_payment_status := lower(trim(coalesce(v_order.payment_status::text, '')));
  v_order_status := lower(trim(coalesce(v_order.order_status::text, '')));
  v_raw := coalesce(to_jsonb(v_order.shipping_label_raw), '{}'::jsonb);
  v_manual := coalesce(v_raw -> 'manual_delivery', '{}'::jsonb);

  if v_payment_status not in ('paid', 'approved', 'pago', 'aprovado') then
    raise exception 'A entrega manual só pode ser confirmada após o pagamento.';
  end if;

  if v_order.paid_at is null then
    raise exception 'O pedido ainda não possui data de pagamento confirmada.';
  end if;

  if v_order_status in (
    'cancelled', 'canceled', 'cancelado', 'cancelada',
    'refunded', 'estornado', 'estornada', 'failed', 'falhou'
  ) or v_payment_status in (
    'refunded', 'estornado', 'estornada', 'failed', 'falhou',
    'rejected', 'rejeitado', 'rejeitada', 'charged_back', 'chargeback'
  ) then
    raise exception 'Pedido cancelado, estornado ou inválido não pode ser entregue.';
  end if;

  if v_order.delivered_at is not null
     or v_order_status in ('delivered', 'entregue') then

    if lower(coalesce(v_manual ->> 'source', '')) = 'admin_manual'
       and coalesce(v_manual ->> 'reverted_at', '') = '' then
      return jsonb_build_object(
        'success', true,
        'idempotent', true,
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'delivered_at', v_order.delivered_at,
        'message', 'Entrega manual já confirmada anteriormente.'
      );
    end if;

    raise exception 'Este pedido já possui uma confirmação de entrega.';
  end if;

  v_manual := jsonb_build_object(
    'source', 'admin_manual',
    'active', true,
    'reason', v_reason,
    'confirmed_at', v_now,
    'confirmed_by_admin_id', p_admin_id,
    'confirmed_by_admin_email',
      lower(trim(coalesce(p_admin_email, ''))),
    'confirmed_by_admin_name',
      trim(coalesce(p_admin_name, '')),
    'previous_order_status',
      v_order.order_status,
    'previous_shipped_at',
      v_order.shipped_at,
    'previous_delivered_at',
      v_order.delivered_at,
    'tracking_code',
      coalesce(
        nullif(trim(coalesce(p_tracking_code, '')), ''),
        v_order.shipping_tracking_code,
        v_order.tracking_code
      ),
    'shipping_carrier',
      coalesce(
        nullif(trim(coalesce(p_shipping_carrier, '')), ''),
        v_order.shipping_carrier
      )
  );

  update public.orders
  set
    order_status = 'delivered',
    delivered_at = v_now,
    shipped_at = coalesce(shipped_at, v_now),

    tracking_code = coalesce(
      nullif(trim(coalesce(p_tracking_code, '')), ''),
      tracking_code
    ),

    shipping_tracking_code = coalesce(
      nullif(trim(coalesce(p_tracking_code, '')), ''),
      shipping_tracking_code,
      tracking_code
    ),

    shipping_carrier = coalesce(
      nullif(trim(coalesce(p_shipping_carrier, '')), ''),
      shipping_carrier
    ),

    admin_notes = coalesce(
      nullif(trim(coalesce(p_admin_notes, '')), ''),
      admin_notes
    ),

    shipping_label_raw = jsonb_set(
      v_raw,
      '{manual_delivery}',
      v_manual,
      true
    ),

    updated_at = v_now
  where id = p_order_id;

  return jsonb_build_object(
    'success', true,
    'idempotent', false,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'delivered_at', v_now,
    'source', 'admin_manual',
    'reason', v_reason
  );
end;
$$;


create or replace function public.revert_order_manual_delivery(
  p_order_id uuid,
  p_admin_id uuid,
  p_admin_email text,
  p_admin_name text,
  p_reason text,
  p_target_status text default 'paid'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_now timestamptz := now();
  v_reason text := trim(coalesce(p_reason, ''));
  v_target_status text :=
    lower(trim(coalesce(p_target_status, 'paid')));
  v_raw jsonb;
  v_manual jsonb;
  v_official_statuses text[];
  v_paid_conversion_count integer := 0;
  v_reverted_conversion_count integer := 0;
  v_previous_shipped_at timestamptz := null;
  v_product_goal_result jsonb := null;
begin
  if p_order_id is null then
    raise exception 'Pedido não informado.';
  end if;

  if p_admin_id is null then
    raise exception 'Administrador responsável não informado.';
  end if;

  if length(v_reason) < 10 then
    raise exception 'Informe um motivo de reversão com pelo menos 10 caracteres.';
  end if;

  if length(v_reason) > 500 then
    raise exception 'O motivo da reversão deve ter no máximo 500 caracteres.';
  end if;

  if v_target_status not in ('paid', 'shipped', 'cancelled') then
    raise exception 'Status de destino inválido para reverter a entrega manual.';
  end if;

  select *
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido não encontrado.';
  end if;

  v_raw := coalesce(
    to_jsonb(v_order.shipping_label_raw),
    '{}'::jsonb
  );

  v_manual := coalesce(
    v_raw -> 'manual_delivery',
    '{}'::jsonb
  );

  if lower(coalesce(v_manual ->> 'source', '')) <> 'admin_manual'
     or coalesce(v_manual ->> 'reverted_at', '') <> '' then
    raise exception 'Este pedido não possui uma entrega manual ativa para reverter.';
  end if;

  v_official_statuses := array[
    lower(coalesce(v_order.shipping_label_status::text, '')),
    lower(coalesce(v_raw ->> 'sync_tracking_status', '')),
    lower(coalesce(v_raw ->> 'tracking_status', '')),
    lower(coalesce(v_raw ->> 'delivery_status', '')),
    lower(coalesce(v_raw ->> 'melhor_envio_status', '')),
    lower(coalesce(v_raw ->> 'melhor_envio_webhook_event', '')),
    lower(
      coalesce(
        v_raw #>> '{melhor_envio_webhook_data,status}',
        ''
      )
    ),
    lower(
      coalesce(
        v_raw #>> '{melhor_envio_webhook_data,event}',
        ''
      )
    )
  ];

  if v_official_statuses && array[
    'delivered',
    'entregue',
    'received',
    'recebido',
    'delivery_completed',
    'completed_delivery',
    'order.delivered',
    'shipment.delivered',
    'delivered_to_recipient',
    'entrega_realizada',
    'objeto_entregue'
  ]::text[] then
    raise exception 'A transportadora já confirmou a entrega. A reversão manual foi bloqueada.';
  end if;

  select count(*)
    into v_paid_conversion_count
  from public.affiliate_conversions
  where order_id = p_order_id
    and paid_at is not null;

  if v_paid_conversion_count > 0 then
    raise exception 'A entrega não pode ser revertida porque existe comissão já paga.';
  end if;

  begin
    v_previous_shipped_at :=
      nullif(
        v_manual ->> 'previous_shipped_at',
        ''
      )::timestamptz;
  exception
    when others then
      v_previous_shipped_at := null;
  end;

  v_manual := v_manual || jsonb_build_object(
    'active', false,
    'reverted_at', v_now,
    'reverted_by_admin_id', p_admin_id,
    'reverted_by_admin_email',
      lower(trim(coalesce(p_admin_email, ''))),
    'reverted_by_admin_name',
      trim(coalesce(p_admin_name, '')),
    'revert_reason', v_reason,
    'reverted_to_status', v_target_status
  );

  update public.orders
  set
    order_status = v_target_status,
    delivered_at = null,

    shipped_at = case
      when v_target_status = 'shipped'
        then coalesce(
          v_previous_shipped_at,
          shipped_at
        )
      else v_previous_shipped_at
    end,

    shipping_label_raw = jsonb_set(
      v_raw,
      '{manual_delivery}',
      v_manual,
      true
    ),

    updated_at = v_now
  where id = p_order_id;

  update public.affiliate_conversions
  set
    status = 'approved',
    released_at = null,

    metadata = (
      coalesce(metadata, '{}'::jsonb)
      - 'released_by_delivery'
      - 'released_by_delivery_source'
      - 'released_by_delivery_at'
      - 'released_order_id'
      - 'released_order_number'
      - 'released_order_status'
      - 'released_tracking_status'
    ) || jsonb_build_object(
      'manual_delivery_reverted', true,
      'manual_delivery_reverted_at', v_now,
      'manual_delivery_reverted_by_admin_id',
        p_admin_id,
      'manual_delivery_revert_reason',
        v_reason
    ),

    notes = trim(
      coalesce(notes, '')
      || E'\nLiberação revertida porque a confirmação manual de entrega foi desfeita.'
    )

  where order_id = p_order_id
    and paid_at is null
    and released_at is not null
    and lower(
      coalesce(
        metadata ->> 'released_by_delivery_source',
        ''
      )
    ) = 'admin_manual_delivery';

  get diagnostics
    v_reverted_conversion_count = row_count;

  if v_order.affiliate_id is not null
     and to_regprocedure(
       'public.process_affiliate_product_goal_bonuses(uuid,uuid,text)'
     ) is not null then

    execute
      'select public.process_affiliate_product_goal_bonuses($1, $2, $3)'
    into v_product_goal_result
    using
      v_order.affiliate_id,
      p_order_id,
      'admin_manual_delivery_reverted';

  end if;

  return jsonb_build_object(
    'success', true,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'target_status', v_target_status,
    'reverted_conversion_count',
      v_reverted_conversion_count,
    'product_goal_result',
      v_product_goal_result
  );
end;
$$;


revoke all on function public.confirm_order_manual_delivery(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text
) from public;

grant execute on function public.confirm_order_manual_delivery(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text
) to service_role;


revoke all on function public.revert_order_manual_delivery(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) from public;

grant execute on function public.revert_order_manual_delivery(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) to service_role;


comment on function public.confirm_order_manual_delivery(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text
) is
  'Confirma entrega manual auditada. A liberação de comissão é concluída pela API com compensação automática em caso de falha.';


comment on function public.revert_order_manual_delivery(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) is
  'Reverte somente entrega manual ativa, sem confirmação oficial da transportadora e sem comissão paga.';

commit;