-- OZONTECK — Web Push de novidades para visitantes e clientes.
-- Aplicar com PRODUCT_INTEREST_NOTIFICATIONS_ENABLED=false.
-- A migração é aditiva e mantém as inscrições/deliveries já existentes.

begin;

alter table public.customer_marketing_push_subscriptions
  alter column customer_id drop not null;

alter table public.customer_marketing_push_subscriptions
  add column if not exists visitor_id text,
  add column if not exists last_session_id text,
  add column if not exists profile_refreshed_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.customer_marketing_push_subscriptions'::regclass
      and conname = 'customer_marketing_push_owner_chk'
  ) then
    alter table public.customer_marketing_push_subscriptions
      add constraint customer_marketing_push_owner_chk
      check (customer_id is not null or visitor_id is not null);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.customer_marketing_push_subscriptions'::regclass
      and conname = 'customer_marketing_push_visitor_length_chk'
  ) then
    alter table public.customer_marketing_push_subscriptions
      add constraint customer_marketing_push_visitor_length_chk
      check (visitor_id is null or char_length(visitor_id) between 1 and 180);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.customer_marketing_push_subscriptions'::regclass
      and conname = 'customer_marketing_push_session_length_chk'
  ) then
    alter table public.customer_marketing_push_subscriptions
      add constraint customer_marketing_push_session_length_chk
      check (last_session_id is null or char_length(last_session_id) between 1 and 180);
  end if;
end;
$$;

create index if not exists customer_marketing_push_visitor_active_idx
  on public.customer_marketing_push_subscriptions (visitor_id, last_seen_at desc)
  where is_active = true and visitor_id is not null;

create index if not exists customer_marketing_push_profile_refresh_idx
  on public.customer_marketing_push_subscriptions
  (profile_refreshed_at, last_seen_at desc)
  where is_active = true and customer_id is null and visitor_id is not null;

create table if not exists public.visitor_interest_profiles (
  visitor_id text not null,
  category_key text not null,
  category_label text not null,
  category_score numeric(5,2) not null,
  confidence numeric(5,2) not null,
  qualifying_signal_count integer not null default 0,
  signal_counts jsonb not null default '{}'::jsonb,
  last_signal_at timestamptz,
  profile_version text not null,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (visitor_id, category_key),
  constraint visitor_interest_profiles_visitor_length_chk
    check (char_length(visitor_id) between 1 and 180),
  constraint visitor_interest_profiles_category_key_length_chk
    check (char_length(category_key) between 1 and 120),
  constraint visitor_interest_profiles_category_label_length_chk
    check (char_length(category_label) between 1 and 120),
  constraint visitor_interest_profiles_category_score_chk
    check (category_score between 0 and 100),
  constraint visitor_interest_profiles_confidence_chk
    check (confidence between 0 and 100),
  constraint visitor_interest_profiles_qualifying_signals_chk
    check (qualifying_signal_count >= 0)
);

create index if not exists visitor_interest_profiles_match_idx
  on public.visitor_interest_profiles
  (category_key, category_score desc, confidence desc, last_signal_at desc);

alter table public.visitor_interest_profiles enable row level security;
revoke all on table public.visitor_interest_profiles from public, anon, authenticated;
grant select, insert, update, delete
  on table public.visitor_interest_profiles
  to service_role;

alter table public.customer_notification_deliveries
  add column if not exists recipient_key text,
  add column if not exists visitor_id text,
  add column if not exists push_subscription_id uuid
    references public.customer_marketing_push_subscriptions(id) on delete set null;

update public.customer_notification_deliveries
set recipient_key = 'customer:' || customer_id::text
where recipient_key is null
  and customer_id is not null;

alter table public.customer_notification_deliveries
  alter column customer_id drop not null,
  alter column recipient_key set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.customer_notification_deliveries'::regclass
      and conname = 'customer_notification_deliveries_recipient_key_chk'
  ) then
    alter table public.customer_notification_deliveries
      add constraint customer_notification_deliveries_recipient_key_chk
      check (
        recipient_key ~ '^customer:[0-9a-f-]{36}$'
        or recipient_key ~ '^visitor:[0-9a-f]{64}$'
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.customer_notification_deliveries'::regclass
      and conname = 'customer_notification_deliveries_visitor_length_chk'
  ) then
    alter table public.customer_notification_deliveries
      add constraint customer_notification_deliveries_visitor_length_chk
      check (visitor_id is null or char_length(visitor_id) between 1 and 180);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.customer_notification_deliveries'::regclass
      and conname = 'customer_notification_deliveries_recipient_dedupe_uk'
  ) then
    alter table public.customer_notification_deliveries
      add constraint customer_notification_deliveries_recipient_dedupe_uk
      unique (campaign_id, recipient_key, channel);
  end if;
end;
$$;

create index if not exists customer_notification_deliveries_recipient_frequency_idx
  on public.customer_notification_deliveries (recipient_key, channel, created_at desc)
  where status in ('pending', 'simulated', 'sent');

create index if not exists customer_notification_deliveries_push_subscription_idx
  on public.customer_notification_deliveries (push_subscription_id)
  where push_subscription_id is not null;

create or replace function public.reserve_product_interest_recipient_delivery(
  p_campaign_id uuid,
  p_recipient_key text,
  p_customer_id uuid,
  p_visitor_id text,
  p_push_subscription_id uuid,
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
  v_recipient_key text := lower(trim(coalesce(p_recipient_key, '')));
  v_channel text := lower(trim(coalesce(p_channel, '')));
  v_visitor_id text := nullif(trim(coalesce(p_visitor_id, '')), '');
  v_now timestamptz := now();
  v_counted_statuses text[];
  v_daily_count integer := 0;
  v_weekly_count integer := 0;
begin
  if v_channel not in ('email', 'web_push') then
    raise exception 'Canal de notificação inválido.' using errcode = '22023';
  end if;

  if p_customer_id is not null then
    if v_recipient_key <> 'customer:' || p_customer_id::text then
      raise exception 'Destinatário de cliente inválido.' using errcode = '22023';
    end if;
  elsif v_visitor_id is not null then
    if v_recipient_key <> 'visitor:' || encode(sha256(convert_to(v_visitor_id, 'UTF8')), 'hex') then
      raise exception 'Destinatário de visitante inválido.' using errcode = '22023';
    end if;
  else
    raise exception 'Destinatário obrigatório.' using errcode = '22023';
  end if;

  if v_channel = 'email' and p_customer_id is null then
    raise exception 'E-mail exige cliente autenticado.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_recipient_key || ':product-interest:' || v_channel, 0)
  );

  if exists (
    select 1
    from public.customer_notification_deliveries as delivery
    where delivery.campaign_id = p_campaign_id
      and delivery.recipient_key = v_recipient_key
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
    where delivery.recipient_key = v_recipient_key
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
    where delivery.recipient_key = v_recipient_key
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
    visitor_id,
    push_subscription_id,
    recipient_key,
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
    v_visitor_id,
    p_push_subscription_id,
    v_recipient_key,
    v_channel,
    left(p_category_key, 120),
    greatest(0, least(100, p_match_score)),
    case when coalesce(p_dry_run, false) then 'simulated' else 'pending' end,
    coalesce(p_metadata, '{}'::jsonb),
    case when coalesce(p_dry_run, false) then v_now else null end,
    v_now,
    v_now
  )
  on conflict (campaign_id, recipient_key, channel) do nothing
  returning id into v_delivery_id;

  return v_delivery_id;
end;
$$;

revoke execute on function public.reserve_product_interest_recipient_delivery(
  uuid, text, uuid, text, uuid, text, text, numeric, jsonb, integer, integer, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_product_interest_recipient_delivery(
  uuid, text, uuid, text, uuid, text, text, numeric, jsonb, integer, integer, boolean
) to service_role;

-- Mantém compatibilidade com o worker anterior e passa a preencher recipient_key.
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
language sql
security invoker
set search_path = ''
as $$
  select public.reserve_product_interest_recipient_delivery(
    p_campaign_id,
    'customer:' || p_customer_id::text,
    p_customer_id,
    null,
    null,
    p_channel,
    p_category_key,
    p_match_score,
    p_metadata,
    p_daily_cap,
    p_weekly_cap,
    p_dry_run
  );
$$;

revoke execute on function public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
) to service_role;

comment on table public.customer_marketing_push_subscriptions is
  'Inscrições Web Push consentidas por visitante; customer_id é associado quando houver login.';
comment on table public.visitor_interest_profiles is
  'Projeção pseudônima do intent para visitantes com Web Push, sem exigir conta.';
comment on function public.reserve_product_interest_recipient_delivery(
  uuid, text, uuid, text, uuid, text, text, numeric, jsonb, integer, integer, boolean
) is
  'Reserva entrega por cliente ou visitante com deduplicação e limites serializados.';

commit;
