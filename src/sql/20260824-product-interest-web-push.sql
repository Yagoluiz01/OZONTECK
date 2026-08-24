-- OZONTECK — extensão Web Push das notificações por interesse.
-- Aplicar depois de 20260824-product-interest-notifications.sql.
-- A migration apenas prepara persistência e reserva; não envia notificações.

begin;

alter table public.customer_marketing_suppressions
  drop constraint if exists customer_marketing_suppressions_channel_chk;

alter table public.customer_marketing_suppressions
  add constraint customer_marketing_suppressions_channel_chk
  check (channel in ('email', 'web_push'));

alter table public.customer_notification_deliveries
  drop constraint if exists customer_notification_deliveries_channel_chk;

alter table public.customer_notification_deliveries
  add constraint customer_notification_deliveries_channel_chk
  check (channel in ('email', 'web_push'));

create table if not exists public.customer_marketing_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  endpoint text not null,
  endpoint_hash text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  is_active boolean not null default true,
  consented_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  last_sent_at timestamptz,
  fail_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_marketing_push_endpoint_hash_uk unique (endpoint_hash),
  constraint customer_marketing_push_endpoint_length_chk
    check (char_length(endpoint) between 1 and 2048),
  constraint customer_marketing_push_endpoint_hash_chk
    check (endpoint_hash ~ '^[0-9a-f]{64}$'),
  constraint customer_marketing_push_p256dh_length_chk
    check (char_length(p256dh) between 1 and 1024),
  constraint customer_marketing_push_auth_length_chk
    check (char_length(auth) between 1 and 1024),
  constraint customer_marketing_push_fail_count_chk
    check (fail_count between 0 and 99)
);

create index if not exists customer_marketing_push_customer_active_idx
  on public.customer_marketing_push_subscriptions (customer_id, last_seen_at desc)
  where is_active = true;

alter table public.customer_marketing_push_subscriptions enable row level security;

revoke all on table public.customer_marketing_push_subscriptions
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.customer_marketing_push_subscriptions
  to service_role;

create or replace function public.reserve_product_interest_channel_delivery(
  p_campaign_id uuid,
  p_customer_id uuid,
  p_channel text,
  p_category_key text,
  p_match_score numeric,
  p_metadata jsonb,
  p_daily_cap integer,
  p_weekly_cap integer,
  p_dry_run boolean
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_delivery_id uuid;
  v_channel text := lower(trim(coalesce(p_channel, '')));
  v_now timestamptz := now();
  v_daily_count integer := 0;
  v_weekly_count integer := 0;
  v_counted_statuses text[];
begin
  if v_channel not in ('email', 'web_push') then
    raise exception 'Canal de notificação inválido.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_customer_id::text || case
        when v_channel = 'email' then ':product-interest-email'
        else ':product-interest-web_push'
      end,
      0
    )
  );

  if exists (
    select 1
    from public.customer_notification_deliveries as delivery
    where delivery.campaign_id = p_campaign_id
      and delivery.customer_id = p_customer_id
      and delivery.channel = v_channel
  ) then
    return null;
  end if;

  v_counted_statuses := case
    when coalesce(p_dry_run, false)
      then array['pending', 'simulated', 'sent']::text[]
    else array['pending', 'sent']::text[]
  end;

  if greatest(0, coalesce(p_daily_cap, 0)) > 0 then
    select count(*)::integer
    into v_daily_count
    from public.customer_notification_deliveries as delivery
    where delivery.customer_id = p_customer_id
      and delivery.channel = v_channel
      and delivery.status = any(v_counted_statuses)
      and delivery.created_at >= v_now - interval '24 hours';

    if v_daily_count >= greatest(0, p_daily_cap) then
      return null;
    end if;
  end if;

  if greatest(0, coalesce(p_weekly_cap, 0)) > 0 then
    select count(*)::integer
    into v_weekly_count
    from public.customer_notification_deliveries as delivery
    where delivery.customer_id = p_customer_id
      and delivery.channel = v_channel
      and delivery.status = any(v_counted_statuses)
      and delivery.created_at >= v_now - interval '7 days';

    if v_weekly_count >= greatest(0, p_weekly_cap) then
      return null;
    end if;
  end if;

  insert into public.customer_notification_deliveries (
    campaign_id,
    customer_id,
    channel,
    category_key,
    match_score,
    status,
    metadata,
    simulated_at,
    created_at,
    updated_at
  )
  values (
    p_campaign_id,
    p_customer_id,
    v_channel,
    left(p_category_key, 120),
    greatest(0, least(100, p_match_score)),
    case when coalesce(p_dry_run, false) then 'simulated' else 'pending' end,
    coalesce(p_metadata, '{}'::jsonb),
    case when coalesce(p_dry_run, false) then v_now else null end,
    v_now,
    v_now
  )
  on conflict (campaign_id, customer_id, channel) do nothing
  returning id into v_delivery_id;

  return v_delivery_id;
end;
$$;

revoke execute on function public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
) from public, anon, authenticated;

grant execute on function public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
) to service_role;

comment on table public.customer_marketing_push_subscriptions is
  'Inscrições Web Push de marketing vinculadas pela API à conta autenticada do cliente.';

comment on function public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
) is
  'Reserva entrega de novidade por cliente e canal com deduplicação e limites serializados.';

commit;
