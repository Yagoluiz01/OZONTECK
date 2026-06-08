-- OZONTECK — Liberação automática e idempotente do bônus da meta por produto
-- Esta etapa NÃO altera a patente global. Ela libera somente o bônus do nível atual
-- quando as unidades entregues do produto atingem a meta específica configurada.

create extension if not exists pgcrypto;

create table if not exists public.affiliate_product_goal_completions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  target_id uuid not null references public.affiliate_product_goal_targets(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  affiliate_level_id uuid not null references public.affiliate_levels(id) on delete restrict,
  required_units integer not null check (required_units > 0),
  confirmed_units integer not null default 0 check (confirmed_units >= 0),
  bonus_amount numeric(14,2) not null default 0 check (bonus_amount >= 0),
  completion_order_id uuid null references public.orders(id) on delete set null,
  conversion_id uuid null references public.affiliate_conversions(id) on delete set null,
  status text not null default 'processing'
    check (status in ('processing','released','completed_without_bonus','cancelled','review_required')),
  source text null,
  metadata jsonb not null default '{}'::jsonb,
  completed_at timestamptz null,
  released_at timestamptz null,
  cancelled_at timestamptz null,
  review_required_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint affiliate_product_goal_completions_affiliate_target_key
    unique (affiliate_id, target_id)
);

create index if not exists idx_affiliate_product_goal_completions_affiliate
  on public.affiliate_product_goal_completions (affiliate_id, updated_at desc);

create index if not exists idx_affiliate_product_goal_completions_conversion
  on public.affiliate_product_goal_completions (conversion_id)
  where conversion_id is not null;

alter table public.affiliate_product_goal_completions enable row level security;
revoke all on table public.affiliate_product_goal_completions from anon;
revoke all on table public.affiliate_product_goal_completions from authenticated;
grant select, insert, update, delete on table public.affiliate_product_goal_completions to service_role;

create or replace function public.process_affiliate_product_goal_bonuses(
  p_affiliate_id uuid,
  p_order_id uuid default null,
  p_source text default 'order_lifecycle'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_affiliate public.affiliates%rowtype;
  v_level public.affiliate_levels%rowtype;
  v_target record;
  v_completion public.affiliate_product_goal_completions%rowtype;
  v_units integer := 0;
  v_bonus numeric(14,2) := 0;
  v_conversion_id uuid;
  v_conversion_status text;
  v_events jsonb := '[]'::jsonb;
  v_goal_order integer := 1;
  v_goal_name text := null;
  v_created boolean := false;
begin
  if p_affiliate_id is null then
    return jsonb_build_object('success', false, 'reason', 'missing_affiliate_id', 'events', v_events);
  end if;

  select * into v_affiliate
  from public.affiliates
  where id = p_affiliate_id
  limit 1;

  if not found then
    return jsonb_build_object('success', false, 'reason', 'affiliate_not_found', 'events', v_events);
  end if;

  select
    coalesce(current_level_order, 1),
    current_level_name
  into v_goal_order, v_goal_name
  from public.affiliate_goal_overview
  where affiliate_id = p_affiliate_id
  limit 1;

  select l.* into v_level
  from public.affiliate_levels l
  where l.is_active = true
    and (
      l.level_order = coalesce(v_goal_order, 1)
      or lower(coalesce(l.name, '')) = lower(coalesce(v_goal_name, ''))
    )
  order by
    case when l.level_order = coalesce(v_goal_order, 1) then 0 else 1 end,
    l.level_order asc
  limit 1;

  if not found then
    select l.* into v_level
    from public.affiliate_levels l
    where l.is_active = true
    order by l.level_order asc
    limit 1;
  end if;

  if v_level.id is null then
    return jsonb_build_object('success', true, 'reason', 'active_level_not_found', 'events', v_events);
  end if;

  -- Primeiro reconcilia conclusões existentes. Isso permite invalidar bônus ainda não pagos
  -- se um pedido for cancelado/estornado posteriormente.
  for v_completion in
    select c.*
    from public.affiliate_product_goal_completions c
    where c.affiliate_id = p_affiliate_id
  loop
    select coalesce(sum(greatest(coalesce(oi.quantity, 0)::integer, 0)), 0)::integer
      into v_units
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.affiliate_product_goal_targets t on t.id = v_completion.target_id
    where o.affiliate_id = p_affiliate_id
      and oi.product_id = v_completion.product_id
      and coalesce(o.created_at, o.delivered_at, v_now) >= t.applied_at
      and (
        o.delivered_at is not null
        or lower(coalesce(o.order_status, '')) in (
          'delivered','entregue','received','recebido','delivery_completed',
          'completed_delivery','finalizado','delivered_to_recipient',
          'entrega_realizada','objeto_entregue'
        )
      )
      and lower(coalesce(o.order_status, '')) not in (
        'cancelled','canceled','cancelado','cancelada','refunded','estornado',
        'estornada','charged_back','chargeback','rejected','failed'
      )
      and lower(coalesce(o.payment_status, '')) in (
        'paid','approved','pago','aprovado'
      );

    update public.affiliate_product_goal_completions
       set confirmed_units = v_units,
           updated_at = v_now,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'last_recalculated_at', v_now,
             'last_recalculated_source', p_source
           )
     where id = v_completion.id;

    if v_units < v_completion.required_units
       and v_completion.status in ('released','completed_without_bonus') then
      select lower(coalesce(status, '')) into v_conversion_status
      from public.affiliate_conversions
      where id = v_completion.conversion_id
      limit 1;

      if v_conversion_status in ('paid','pago') then
        update public.affiliate_product_goal_completions
           set status = 'review_required',
               review_required_at = v_now,
               updated_at = v_now,
               metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                 'review_reason', 'confirmed_units_below_target_after_paid_bonus',
                 'confirmed_units_after_recalculation', v_units
               )
         where id = v_completion.id;

        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'action', 'review_required',
          'completion_id', v_completion.id,
          'target_id', v_completion.target_id,
          'product_id', v_completion.product_id,
          'affiliate_id', p_affiliate_id,
          'confirmed_units', v_units,
          'required_units', v_completion.required_units,
          'bonus_amount', v_completion.bonus_amount
        ));
      else
        if v_completion.conversion_id is not null then
          update public.affiliate_conversions
             set status = 'cancelled',
                 released_at = null,
                 metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                   'cancelled_by_product_goal_recalculation', true,
                   'cancelled_at', v_now,
                   'cancelled_source', p_source,
                   'confirmed_units_after_recalculation', v_units
                 ),
                 notes = trim(coalesce(notes, '') || E'\nBônus da meta específica cancelado após recálculo das unidades válidas.')
           where id = v_completion.conversion_id;
        end if;

        update public.affiliate_product_goal_completions
           set status = 'cancelled',
               cancelled_at = v_now,
               released_at = null,
               updated_at = v_now
         where id = v_completion.id;

        v_events := v_events || jsonb_build_array(jsonb_build_object(
          'action', 'cancelled',
          'completion_id', v_completion.id,
          'target_id', v_completion.target_id,
          'product_id', v_completion.product_id,
          'affiliate_id', p_affiliate_id,
          'confirmed_units', v_units,
          'required_units', v_completion.required_units,
          'bonus_amount', v_completion.bonus_amount
        ));
      end if;
    end if;
  end loop;

  -- Cria/libera somente metas específicas do nível atual do afiliado.
  for v_target in
    select t.*
    from public.affiliate_product_goal_targets t
    where t.affiliate_level_id = v_level.id
      and t.is_active = true
  loop
    select coalesce(sum(greatest(coalesce(oi.quantity, 0)::integer, 0)), 0)::integer
      into v_units
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.affiliate_id = p_affiliate_id
      and oi.product_id = v_target.product_id
      and coalesce(o.created_at, o.delivered_at, v_now) >= v_target.applied_at
      and (
        o.delivered_at is not null
        or lower(coalesce(o.order_status, '')) in (
          'delivered','entregue','received','recebido','delivery_completed',
          'completed_delivery','finalizado','delivered_to_recipient',
          'entrega_realizada','objeto_entregue'
        )
      )
      and lower(coalesce(o.order_status, '')) not in (
        'cancelled','canceled','cancelado','cancelada','refunded','estornado',
        'estornada','charged_back','chargeback','rejected','failed'
      )
      and lower(coalesce(o.payment_status, '')) in (
        'paid','approved','pago','aprovado'
      );

    if v_units < v_target.required_units then
      continue;
    end if;

    v_bonus := case
      when lower(coalesce(v_level.bonus_type, 'fixed')) = 'manual' then 0
      else greatest(coalesce(v_level.bonus_amount, 0), 0)
    end;

    v_created := false;
    insert into public.affiliate_product_goal_completions (
      affiliate_id,
      target_id,
      product_id,
      affiliate_level_id,
      required_units,
      confirmed_units,
      bonus_amount,
      completion_order_id,
      status,
      source,
      metadata,
      completed_at,
      created_at,
      updated_at
    ) values (
      p_affiliate_id,
      v_target.id,
      v_target.product_id,
      v_target.affiliate_level_id,
      v_target.required_units,
      v_units,
      v_bonus,
      p_order_id,
      'processing',
      p_source,
      jsonb_build_object(
        'level_name', v_level.name,
        'level_order', v_level.level_order,
        'target_applied_at', v_target.applied_at,
        'reference_price', v_target.reference_price,
        'safe_contribution_per_unit', v_target.safe_contribution_per_unit,
        'source', p_source
      ),
      v_now,
      v_now,
      v_now
    )
    on conflict (affiliate_id, target_id) do nothing
    returning * into v_completion;

    if v_completion.id is not null then
      v_created := true;
    else
      select * into v_completion
      from public.affiliate_product_goal_completions
      where affiliate_id = p_affiliate_id
        and target_id = v_target.id
      limit 1;
    end if;

    if not v_created then
      update public.affiliate_product_goal_completions
         set confirmed_units = v_units,
             updated_at = v_now
       where id = v_completion.id;

      if v_completion.status = 'cancelled' and v_completion.conversion_id is not null then
        select lower(coalesce(status, '')) into v_conversion_status
        from public.affiliate_conversions
        where id = v_completion.conversion_id
        limit 1;

        if v_conversion_status not in ('paid','pago') then
          update public.affiliate_conversions
             set status = 'released',
                 approved_at = coalesce(approved_at, v_now),
                 released_at = v_now,
                 metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                   'reactivated_by_product_goal', true,
                   'reactivated_at', v_now,
                   'reactivated_source', p_source,
                   'confirmed_units_after_recalculation', v_units
                 ),
                 notes = trim(coalesce(notes, '') || E'\nBônus reativado após novas unidades entregues atingirem novamente a meta específica.')
           where id = v_completion.conversion_id;

          update public.affiliate_product_goal_completions
             set status = 'released',
                 released_at = v_now,
                 cancelled_at = null,
                 updated_at = v_now
           where id = v_completion.id;

          v_events := v_events || jsonb_build_array(jsonb_build_object(
            'action', 'released',
            'reactivated', true,
            'completion_id', v_completion.id,
            'conversion_id', v_completion.conversion_id,
            'target_id', v_target.id,
            'product_id', v_target.product_id,
            'affiliate_id', p_affiliate_id,
            'confirmed_units', v_units,
            'required_units', v_target.required_units,
            'level_name', v_level.name,
            'bonus_amount', v_completion.bonus_amount
          ));
        end if;
      end if;

      continue;
    end if;

    if v_bonus <= 0 then
      update public.affiliate_product_goal_completions
         set status = 'completed_without_bonus',
             released_at = null,
             updated_at = v_now
       where id = v_completion.id;

      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'action', 'completed_without_bonus',
        'completion_id', v_completion.id,
        'target_id', v_target.id,
        'product_id', v_target.product_id,
        'affiliate_id', p_affiliate_id,
        'confirmed_units', v_units,
        'required_units', v_target.required_units,
        'level_name', v_level.name,
        'bonus_amount', 0
      ));
      continue;
    end if;

    insert into public.affiliate_conversions (
      affiliate_id,
      order_id,
      customer_id,
      ref_code,
      coupon_code,
      order_total,
      commission_rate,
      commission_amount,
      conversion_type,
      status,
      approved_at,
      released_at,
      metadata,
      notes
    ) values (
      p_affiliate_id,
      p_order_id,
      null,
      coalesce(v_affiliate.ref_code, ''),
      coalesce(v_affiliate.coupon_code, ''),
      0,
      0,
      v_bonus,
      'product_goal_bonus',
      'released',
      v_now,
      v_now,
      jsonb_build_object(
        'source', 'affiliate_product_goal_bonus',
        'lifecycle_source', p_source,
        'completion_id', v_completion.id,
        'target_id', v_target.id,
        'product_id', v_target.product_id,
        'affiliate_level_id', v_level.id,
        'level_name', v_level.name,
        'level_order', v_level.level_order,
        'required_units', v_target.required_units,
        'confirmed_units', v_units,
        'bonus_amount', v_bonus,
        'release_policy', 'after_delivered_units',
        'released_by_product_goal', true
      ),
      format(
        'Bônus de %s liberado automaticamente após atingir %s unidades entregues da meta específica do produto.',
        to_char(v_bonus, 'FM999999990D00'),
        v_target.required_units
      )
    )
    returning id into v_conversion_id;

    update public.affiliate_product_goal_completions
       set conversion_id = v_conversion_id,
           status = 'released',
           released_at = v_now,
           updated_at = v_now,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'conversion_id', v_conversion_id,
             'released_at', v_now
           )
     where id = v_completion.id;

    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'action', 'released',
      'completion_id', v_completion.id,
      'conversion_id', v_conversion_id,
      'target_id', v_target.id,
      'product_id', v_target.product_id,
      'affiliate_id', p_affiliate_id,
      'confirmed_units', v_units,
      'required_units', v_target.required_units,
      'level_name', v_level.name,
      'bonus_amount', v_bonus
    ));
  end loop;

  return jsonb_build_object(
    'success', true,
    'affiliate_id', p_affiliate_id,
    'current_level_id', v_level.id,
    'current_level_name', v_level.name,
    'events', v_events
  );
end;
$$;

revoke all on function public.process_affiliate_product_goal_bonuses(uuid, uuid, text) from public;
grant execute on function public.process_affiliate_product_goal_bonuses(uuid, uuid, text) to service_role;

comment on table public.affiliate_product_goal_completions is
  'Conclusões idempotentes das metas específicas por produto. Cada afiliado recebe no máximo um bônus por target.';

comment on function public.process_affiliate_product_goal_bonuses(uuid, uuid, text) is
  'Recalcula unidades entregues, libera bônus uma única vez e cancela bônus não pagos se unidades válidas caírem abaixo da meta.';
