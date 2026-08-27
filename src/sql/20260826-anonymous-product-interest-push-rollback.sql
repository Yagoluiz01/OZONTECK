-- Rollback seguro: recusa perda silenciosa de inscrições/perfis anônimos.

begin;

do $$
begin
  if exists (
    select 1
    from public.customer_marketing_push_subscriptions
    where customer_id is null
  ) then
    raise exception 'Rollback recusado: existem inscrições Push anônimas.';
  end if;

  if exists (select 1 from public.visitor_interest_profiles) then
    raise exception 'Rollback recusado: existem perfis de interesse de visitantes.';
  end if;

  if exists (
    select 1
    from public.customer_notification_deliveries
    where customer_id is null
  ) then
    raise exception 'Rollback recusado: existem entregas destinadas a visitantes.';
  end if;
end;
$$;

drop function if exists public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
);
drop function if exists public.reserve_product_interest_recipient_delivery(
  uuid, text, uuid, text, uuid, text, text, numeric, jsonb, integer, integer, boolean
);

drop index if exists public.customer_notification_deliveries_recipient_frequency_idx;
drop index if exists public.customer_notification_deliveries_push_subscription_idx;
alter table public.customer_notification_deliveries
  drop constraint if exists customer_notification_deliveries_recipient_dedupe_uk,
  drop constraint if exists customer_notification_deliveries_recipient_key_chk,
  drop constraint if exists customer_notification_deliveries_visitor_length_chk,
  drop column if exists push_subscription_id,
  drop column if exists visitor_id,
  drop column if exists recipient_key,
  alter column customer_id set not null;

drop table if exists public.visitor_interest_profiles;

drop index if exists public.customer_marketing_push_profile_refresh_idx;
drop index if exists public.customer_marketing_push_visitor_active_idx;
alter table public.customer_marketing_push_subscriptions
  drop constraint if exists customer_marketing_push_owner_chk,
  drop constraint if exists customer_marketing_push_visitor_length_chk,
  drop constraint if exists customer_marketing_push_session_length_chk,
  drop column if exists profile_refreshed_at,
  drop column if exists last_session_id,
  drop column if exists visitor_id,
  alter column customer_id set not null;

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
    hashtextextended(p_customer_id::text || ':product-interest-' || v_channel, 0)
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
    if v_daily_count >= greatest(0, p_daily_cap) then return null; end if;
  end if;

  if greatest(0, coalesce(p_weekly_cap, 0)) > 0 then
    select count(*)::integer
    into v_weekly_count
    from public.customer_notification_deliveries as delivery
    where delivery.customer_id = p_customer_id
      and delivery.channel = v_channel
      and delivery.status = any(v_counted_statuses)
      and delivery.created_at >= v_now - interval '7 days';
    if v_weekly_count >= greatest(0, p_weekly_cap) then return null; end if;
  end if;

  insert into public.customer_notification_deliveries (
    campaign_id, customer_id, channel, category_key, match_score, status,
    metadata, simulated_at, created_at, updated_at
  )
  values (
    p_campaign_id, p_customer_id, v_channel, left(p_category_key, 120),
    greatest(0, least(100, p_match_score)),
    case when coalesce(p_dry_run, false) then 'simulated' else 'pending' end,
    coalesce(p_metadata, '{}'::jsonb),
    case when coalesce(p_dry_run, false) then v_now else null end,
    v_now, v_now
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

commit;
