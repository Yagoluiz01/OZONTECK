-- OZONTECK — plataforma administrativa de campanhas, promoções e atribuição.
--
-- Aplicar primeiro com as automações desativadas. Esta migration não envia
-- notificações, não altera preços e não aplica descontos em pedidos existentes.
-- O histórico das tabelas product_notification_* permanece preservado.

begin;

create table if not exists public.marketing_automation_settings (
  id smallint primary key default 1,
  enabled boolean not null default false,
  auto_publish boolean not null default false,
  default_dry_run boolean not null default true,
  notify_product_launch boolean not null default true,
  notify_product_reactivation boolean not null default true,
  notify_product_restock boolean not null default true,
  discovery_enabled boolean not null default true,
  restock_cooldown_hours integer not null default 72,
  daily_cap integer not null default 1,
  weekly_cap integer not null default 2,
  updated_by uuid references public.admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_automation_singleton_chk check (id = 1),
  constraint marketing_automation_restock_cooldown_chk
    check (restock_cooldown_hours between 1 and 2160),
  constraint marketing_automation_daily_cap_chk check (daily_cap between 0 and 20),
  constraint marketing_automation_weekly_cap_chk check (weekly_cap between 0 and 100)
);

insert into public.marketing_automation_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  campaign_type text not null,
  source text not null default 'manual',
  status text not null default 'draft',
  audience_mode text not null default 'smart',
  category_keys text[] not null default '{}'::text[],
  channels text[] not null default array['web_push']::text[],
  title text not null,
  body text not null,
  cta_label text not null default 'Ver novidade',
  destination_url text,
  image_url text,
  scheduled_at timestamptz,
  timezone text not null default 'America/Bahia',
  dry_run boolean not null default true,
  discovery_enabled boolean not null default true,
  daily_cap integer not null default 1,
  weekly_cap integer not null default 2,
  summary jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text,
  created_by uuid references public.admins(id) on delete set null,
  updated_by uuid references public.admins(id) on delete set null,
  published_by uuid references public.admins(id) on delete set null,
  published_at timestamptz,
  started_at timestamptz,
  last_simulated_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  last_error text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_campaigns_name_length_chk
    check (char_length(name) between 1 and 160),
  constraint marketing_campaigns_type_chk
    check (campaign_type in (
      'product_launch',
      'product_restock',
      'product_reactivation',
      'product_campaign',
      'promotion',
      'announcement'
    )),
  constraint marketing_campaigns_source_chk
    check (source in ('manual', 'product_trigger', 'restock_trigger', 'reactivation_trigger')),
  constraint marketing_campaigns_status_chk
    check (status in (
      'draft',
      'scheduled',
      'queued',
      'processing',
      'paused',
      'completed',
      'cancelled',
      'failed'
    )),
  constraint marketing_campaigns_audience_chk
    check (audience_mode in ('smart', 'all_opted_in', 'category')),
  constraint marketing_campaigns_channels_chk
    check (
      cardinality(channels) between 1 and 2
      and channels <@ array['web_push', 'email']::text[]
    ),
  constraint marketing_campaigns_title_length_chk
    check (char_length(title) between 1 and 120),
  constraint marketing_campaigns_body_length_chk
    check (char_length(body) between 1 and 360),
  constraint marketing_campaigns_cta_length_chk
    check (char_length(cta_label) between 1 and 50),
  constraint marketing_campaigns_timezone_length_chk
    check (char_length(timezone) between 1 and 80),
  constraint marketing_campaigns_caps_chk
    check (daily_cap between 0 and 20 and weekly_cap between 0 and 100),
  constraint marketing_campaigns_version_chk check (version >= 1),
  constraint marketing_campaigns_idempotency_uk unique (idempotency_key)
);

create table if not exists public.marketing_campaign_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  position integer not null default 0,
  product_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint marketing_campaign_items_position_chk check (position between 0 and 500),
  constraint marketing_campaign_items_campaign_product_uk unique (campaign_id, product_id)
);

create table if not exists public.marketing_promotions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  name text not null,
  code text,
  discount_type text not null,
  discount_value numeric(12,2) not null default 0,
  minimum_order_amount numeric(12,2) not null default 0,
  maximum_discount_amount numeric(12,2),
  usage_limit integer,
  per_recipient_limit integer not null default 1,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_automatic boolean not null default false,
  is_stackable boolean not null default false,
  status text not null default 'draft',
  created_by uuid references public.admins(id) on delete set null,
  updated_by uuid references public.admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_promotions_name_length_chk
    check (char_length(name) between 1 and 160),
  constraint marketing_promotions_code_format_chk
    check (code is null or code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  constraint marketing_promotions_type_chk
    check (discount_type in ('percentage', 'fixed_amount', 'free_shipping')),
  constraint marketing_promotions_value_chk
    check (
      discount_value >= 0
      and (discount_type <> 'percentage' or discount_value between 0.01 and 100)
      and (discount_type <> 'free_shipping' or discount_value = 0)
    ),
  constraint marketing_promotions_amounts_chk
    check (
      minimum_order_amount >= 0
      and (maximum_discount_amount is null or maximum_discount_amount >= 0)
    ),
  constraint marketing_promotions_limits_chk
    check (
      (usage_limit is null or usage_limit >= 1)
      and per_recipient_limit between 1 and 100
    ),
  constraint marketing_promotions_period_chk check (ends_at > starts_at),
  constraint marketing_promotions_status_chk
    check (status in ('draft', 'scheduled', 'active', 'paused', 'expired', 'cancelled'))
);

create unique index if not exists marketing_promotions_code_uk
  on public.marketing_promotions (upper(code))
  where code is not null;

create table if not exists public.marketing_promotion_products (
  promotion_id uuid not null references public.marketing_promotions(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (promotion_id, product_id)
);

create table if not exists public.marketing_promotion_categories (
  promotion_id uuid not null references public.marketing_promotions(id) on delete cascade,
  category_key text not null,
  created_at timestamptz not null default now(),
  primary key (promotion_id, category_key),
  constraint marketing_promotion_categories_key_chk
    check (char_length(category_key) between 1 and 120)
);

create table if not exists public.marketing_campaign_jobs (
  id bigint generated by default as identity primary key,
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  job_type text not null default 'campaign_dispatch',
  status text not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_campaign_jobs_type_chk
    check (job_type in ('campaign_dispatch')),
  constraint marketing_campaign_jobs_status_chk
    check (status in ('queued', 'processing', 'retry', 'completed', 'failed', 'cancelled')),
  constraint marketing_campaign_jobs_attempts_chk
    check (attempts >= 0 and max_attempts between 1 and 20),
  constraint marketing_campaign_jobs_campaign_type_uk unique (campaign_id, job_type)
);

create table if not exists public.marketing_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  recipient_key text not null,
  customer_id uuid references public.customers(id) on delete set null,
  visitor_id text,
  selection_mode text not null,
  category_key text,
  match_score numeric(5,2) not null default 0,
  status text not null default 'selected',
  metadata jsonb not null default '{}'::jsonb,
  selected_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_campaign_recipients_key_chk
    check (
      recipient_key ~ '^customer:[0-9a-f-]{36}$'
      or recipient_key ~ '^visitor:[0-9a-f]{64}$'
    ),
  constraint marketing_campaign_recipients_owner_chk
    check (customer_id is not null or visitor_id is not null),
  constraint marketing_campaign_recipients_visitor_chk
    check (visitor_id is null or char_length(visitor_id) between 1 and 180),
  constraint marketing_campaign_recipients_selection_chk
    check (selection_mode in ('interest', 'discovery', 'all_opted_in', 'category', 'test')),
  constraint marketing_campaign_recipients_score_chk check (match_score between 0 and 100),
  constraint marketing_campaign_recipients_status_chk
    check (status in (
      'selected',
      'simulated',
      'provider_accepted',
      'partially_failed',
      'failed',
      'skipped',
      'cancelled'
    )),
  constraint marketing_campaign_recipients_campaign_key_uk
    unique (campaign_id, recipient_key)
);

create table if not exists public.marketing_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  recipient_id uuid not null references public.marketing_campaign_recipients(id) on delete cascade,
  push_subscription_id uuid references public.customer_marketing_push_subscriptions(id) on delete set null,
  channel text not null default 'web_push',
  status text not null default 'pending',
  attempt_count integer not null default 0,
  provider_status_code integer,
  provider_message_id text,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  attempted_at timestamptz,
  accepted_at timestamptz,
  simulated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_delivery_attempts_channel_chk
    check (channel in ('web_push', 'email')),
  constraint marketing_delivery_attempts_status_chk
    check (status in ('pending', 'simulated', 'provider_accepted', 'failed', 'stale', 'skipped')),
  constraint marketing_delivery_attempts_count_chk check (attempt_count between 0 and 20),
  constraint marketing_delivery_attempts_provider_status_chk
    check (provider_status_code is null or provider_status_code between 100 and 599),
  constraint marketing_delivery_attempts_recipient_subscription_uk
    unique (recipient_id, push_subscription_id, channel)
);

create table if not exists public.marketing_click_links (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  recipient_id uuid not null references public.marketing_campaign_recipients(id) on delete cascade,
  token_hash text not null,
  destination_url text not null,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  click_count integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint marketing_click_links_token_hash_chk
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint marketing_click_links_destination_chk
    check (char_length(destination_url) between 1 and 1500),
  constraint marketing_click_links_click_count_chk check (click_count >= 0),
  constraint marketing_click_links_token_hash_uk unique (token_hash),
  constraint marketing_click_links_recipient_uk unique (recipient_id)
);

create table if not exists public.marketing_campaign_events (
  id bigint generated by default as identity primary key,
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  recipient_id uuid references public.marketing_campaign_recipients(id) on delete set null,
  delivery_attempt_id uuid references public.marketing_delivery_attempts(id) on delete set null,
  event_type text not null,
  event_key text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint marketing_campaign_events_type_chk
    check (event_type in (
      'provider_accepted',
      'displayed',
      'clicked',
      'unsubscribed',
      'product_view',
      'add_to_cart',
      'checkout_started',
      'order_created',
      'order_paid'
    )),
  constraint marketing_campaign_events_event_key_uk unique (event_key)
);

create table if not exists public.marketing_promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.marketing_promotions(id) on delete restrict,
  campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  order_id uuid references public.orders(id) on delete restrict,
  recipient_key text,
  discount_amount numeric(12,2) not null default 0,
  status text not null default 'reserved',
  reserved_at timestamptz not null default now(),
  applied_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_promotion_redemptions_amount_chk check (discount_amount >= 0),
  constraint marketing_promotion_redemptions_status_chk
    check (status in ('reserved', 'applied', 'released', 'reversed')),
  constraint marketing_promotion_redemptions_order_uk unique (promotion_id, order_id)
);

create table if not exists public.marketing_order_attributions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  campaign_id uuid not null references public.marketing_campaigns(id) on delete restrict,
  recipient_id uuid references public.marketing_campaign_recipients(id) on delete set null,
  attribution_type text not null default 'last_click',
  status text not null default 'pending',
  attributed_revenue numeric(12,2) not null default 0,
  clicked_at timestamptz,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint marketing_order_attributions_type_chk
    check (attribution_type in ('first_click', 'last_click')),
  constraint marketing_order_attributions_status_chk
    check (status in ('pending', 'converted', 'cancelled')),
  constraint marketing_order_attributions_revenue_chk check (attributed_revenue >= 0),
  constraint marketing_order_attributions_order_uk unique (order_id)
);

create index if not exists marketing_campaigns_status_schedule_idx
  on public.marketing_campaigns (status, scheduled_at, created_at desc);
create index if not exists marketing_campaigns_type_created_idx
  on public.marketing_campaigns (campaign_type, created_at desc);
create index if not exists marketing_campaign_items_product_idx
  on public.marketing_campaign_items (product_id, campaign_id);
create index if not exists marketing_promotions_status_period_idx
  on public.marketing_promotions (status, starts_at, ends_at);
create index if not exists marketing_campaign_jobs_ready_idx
  on public.marketing_campaign_jobs (available_at, id)
  where status in ('queued', 'retry');
create index if not exists marketing_campaign_jobs_lease_idx
  on public.marketing_campaign_jobs (locked_at, id)
  where status = 'processing';
create index if not exists marketing_campaign_recipients_frequency_idx
  on public.marketing_campaign_recipients (recipient_key, created_at desc)
  where status in ('selected', 'simulated', 'provider_accepted', 'partially_failed');
create index if not exists marketing_campaign_recipients_campaign_status_idx
  on public.marketing_campaign_recipients (campaign_id, status);
create index if not exists marketing_delivery_attempts_campaign_status_idx
  on public.marketing_delivery_attempts (campaign_id, status, created_at desc);
create index if not exists marketing_click_links_campaign_clicked_idx
  on public.marketing_click_links (campaign_id, first_clicked_at desc)
  where first_clicked_at is not null;
create index if not exists marketing_campaign_events_campaign_time_idx
  on public.marketing_campaign_events (campaign_id, occurred_at desc);
create index if not exists marketing_order_attributions_campaign_time_idx
  on public.marketing_order_attributions (campaign_id, converted_at desc)
  where status = 'converted';
create index if not exists marketing_promotion_redemptions_recipient_idx
  on public.marketing_promotion_redemptions (promotion_id, recipient_key, status)
  where recipient_key is not null;
create index if not exists marketing_automation_settings_updated_by_idx
  on public.marketing_automation_settings (updated_by)
  where updated_by is not null;
create index if not exists marketing_campaigns_created_by_idx
  on public.marketing_campaigns (created_by)
  where created_by is not null;
create index if not exists marketing_campaigns_updated_by_idx
  on public.marketing_campaigns (updated_by)
  where updated_by is not null;
create index if not exists marketing_campaigns_published_by_idx
  on public.marketing_campaigns (published_by)
  where published_by is not null;
create index if not exists marketing_promotions_campaign_idx
  on public.marketing_promotions (campaign_id)
  where campaign_id is not null;
create index if not exists marketing_promotions_created_by_idx
  on public.marketing_promotions (created_by)
  where created_by is not null;
create index if not exists marketing_promotions_updated_by_idx
  on public.marketing_promotions (updated_by)
  where updated_by is not null;
create index if not exists marketing_promotion_products_product_idx
  on public.marketing_promotion_products (product_id, promotion_id);
create index if not exists marketing_campaign_recipients_customer_idx
  on public.marketing_campaign_recipients (customer_id, created_at desc)
  where customer_id is not null;
create index if not exists marketing_delivery_attempts_subscription_idx
  on public.marketing_delivery_attempts (push_subscription_id, created_at desc)
  where push_subscription_id is not null;
create index if not exists marketing_click_links_campaign_idx
  on public.marketing_click_links (campaign_id, created_at desc);
create index if not exists marketing_campaign_events_recipient_idx
  on public.marketing_campaign_events (recipient_id, occurred_at desc)
  where recipient_id is not null;
create index if not exists marketing_campaign_events_attempt_idx
  on public.marketing_campaign_events (delivery_attempt_id)
  where delivery_attempt_id is not null;
create index if not exists marketing_promotion_redemptions_campaign_idx
  on public.marketing_promotion_redemptions (campaign_id)
  where campaign_id is not null;
create index if not exists marketing_promotion_redemptions_order_idx
  on public.marketing_promotion_redemptions (order_id)
  where order_id is not null;
create index if not exists marketing_order_attributions_campaign_idx
  on public.marketing_order_attributions (campaign_id, created_at desc);
create index if not exists marketing_order_attributions_recipient_idx
  on public.marketing_order_attributions (recipient_id)
  where recipient_id is not null;

alter table public.marketing_automation_settings enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.marketing_campaign_items enable row level security;
alter table public.marketing_promotions enable row level security;
alter table public.marketing_promotion_products enable row level security;
alter table public.marketing_promotion_categories enable row level security;
alter table public.marketing_campaign_jobs enable row level security;
alter table public.marketing_campaign_recipients enable row level security;
alter table public.marketing_delivery_attempts enable row level security;
alter table public.marketing_click_links enable row level security;
alter table public.marketing_campaign_events enable row level security;
alter table public.marketing_promotion_redemptions enable row level security;
alter table public.marketing_order_attributions enable row level security;

revoke all on table
  public.marketing_automation_settings,
  public.marketing_campaigns,
  public.marketing_campaign_items,
  public.marketing_promotions,
  public.marketing_promotion_products,
  public.marketing_promotion_categories,
  public.marketing_campaign_jobs,
  public.marketing_campaign_recipients,
  public.marketing_delivery_attempts,
  public.marketing_click_links,
  public.marketing_campaign_events,
  public.marketing_promotion_redemptions,
  public.marketing_order_attributions
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.marketing_automation_settings,
  public.marketing_campaigns,
  public.marketing_campaign_items,
  public.marketing_promotions,
  public.marketing_promotion_products,
  public.marketing_promotion_categories,
  public.marketing_campaign_jobs,
  public.marketing_campaign_recipients,
  public.marketing_delivery_attempts,
  public.marketing_click_links,
  public.marketing_campaign_events,
  public.marketing_promotion_redemptions,
  public.marketing_order_attributions
to service_role;

grant usage, select on sequence
  public.marketing_campaign_jobs_id_seq,
  public.marketing_campaign_events_id_seq
to service_role;

create or replace function public.save_marketing_campaign_draft(
  p_campaign_id uuid,
  p_expected_version integer,
  p_campaign jsonb,
  p_items jsonb,
  p_actor_id uuid default null
)
returns public.marketing_campaigns
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_campaign public.marketing_campaigns%rowtype;
  v_now timestamptz := now();
begin
  if jsonb_typeof(coalesce(p_campaign, '{}'::jsonb)) <> 'object' then
    raise exception 'Campanha inválida.' using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 50 then
    raise exception 'Itens da campanha inválidos.' using errcode = '22023';
  end if;

  if p_campaign_id is null then
    insert into public.marketing_campaigns (
      name,
      campaign_type,
      source,
      status,
      audience_mode,
      category_keys,
      channels,
      title,
      body,
      cta_label,
      destination_url,
      image_url,
      timezone,
      dry_run,
      discovery_enabled,
      daily_cap,
      weekly_cap,
      metadata,
      created_by,
      updated_by,
      created_at,
      updated_at
    )
    values (
      p_campaign->>'name',
      p_campaign->>'campaign_type',
      'manual',
      'draft',
      p_campaign->>'audience_mode',
      array(
        select jsonb_array_elements_text(
          coalesce(p_campaign->'category_keys', '[]'::jsonb)
        )
      ),
      array(
        select jsonb_array_elements_text(
          coalesce(p_campaign->'channels', '[]'::jsonb)
        )
      ),
      p_campaign->>'title',
      p_campaign->>'body',
      p_campaign->>'cta_label',
      nullif(p_campaign->>'destination_url', ''),
      nullif(p_campaign->>'image_url', ''),
      p_campaign->>'timezone',
      coalesce((p_campaign->>'dry_run')::boolean, true),
      coalesce((p_campaign->>'discovery_enabled')::boolean, true),
      coalesce((p_campaign->>'daily_cap')::integer, 1),
      coalesce((p_campaign->>'weekly_cap')::integer, 2),
      coalesce(p_campaign->'metadata', '{}'::jsonb),
      p_actor_id,
      p_actor_id,
      v_now,
      v_now
    )
    returning * into v_campaign;
  else
    update public.marketing_campaigns as campaign
    set name = p_campaign->>'name',
        campaign_type = p_campaign->>'campaign_type',
        audience_mode = p_campaign->>'audience_mode',
        category_keys = array(
          select jsonb_array_elements_text(
            coalesce(p_campaign->'category_keys', '[]'::jsonb)
          )
        ),
        channels = array(
          select jsonb_array_elements_text(
            coalesce(p_campaign->'channels', '[]'::jsonb)
          )
        ),
        title = p_campaign->>'title',
        body = p_campaign->>'body',
        cta_label = p_campaign->>'cta_label',
        destination_url = nullif(p_campaign->>'destination_url', ''),
        image_url = nullif(p_campaign->>'image_url', ''),
        timezone = p_campaign->>'timezone',
        dry_run = coalesce((p_campaign->>'dry_run')::boolean, true),
        discovery_enabled = coalesce(
          (p_campaign->>'discovery_enabled')::boolean,
          true
        ),
        daily_cap = coalesce((p_campaign->>'daily_cap')::integer, 1),
        weekly_cap = coalesce((p_campaign->>'weekly_cap')::integer, 2),
        updated_by = p_actor_id,
        updated_at = v_now,
        version = campaign.version + 1
    where campaign.id = p_campaign_id
      and campaign.version = p_expected_version
      and campaign.status = 'draft'
    returning campaign.* into v_campaign;

    if not found then
      raise exception 'A campanha foi alterada em outra sessão ou não pode ser editada.'
        using errcode = '40001';
    end if;

    delete from public.marketing_campaign_items as item
    where item.campaign_id = v_campaign.id;
  end if;

  insert into public.marketing_campaign_items (
    campaign_id,
    product_id,
    position,
    product_snapshot
  )
  select
    v_campaign.id,
    (item.value->>'product_id')::uuid,
    (item.position - 1)::integer,
    coalesce(item.value->'product_snapshot', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
    with ordinality as item(value, position);

  return v_campaign;
end;
$$;

revoke execute on function public.save_marketing_campaign_draft(
  uuid, integer, jsonb, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.save_marketing_campaign_draft(
  uuid, integer, jsonb, jsonb, uuid
) to service_role;

create or replace function public.publish_marketing_campaign(
  p_campaign_id uuid,
  p_expected_version integer,
  p_status text,
  p_scheduled_at timestamptz,
  p_dry_run boolean,
  p_actor_id uuid default null
)
returns public.marketing_campaigns
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_campaign public.marketing_campaigns%rowtype;
  v_status text := lower(trim(coalesce(p_status, '')));
  v_now timestamptz := now();
  v_available_at timestamptz;
begin
  if v_status not in ('queued', 'scheduled') then
    raise exception 'Status de publicação inválido.' using errcode = '22023';
  end if;

  if v_status = 'scheduled' and (p_scheduled_at is null or p_scheduled_at <= v_now) then
    raise exception 'Agendamento inválido.' using errcode = '22023';
  end if;

  v_available_at := case
    when v_status = 'scheduled' then p_scheduled_at
    else v_now
  end;

  update public.marketing_campaigns as campaign
  set status = v_status,
      scheduled_at = case when v_status = 'scheduled' then p_scheduled_at else null end,
      dry_run = coalesce(p_dry_run, true),
      published_by = case
        when coalesce(p_dry_run, true) then campaign.published_by
        else p_actor_id
      end,
      published_at = case
        when coalesce(p_dry_run, true) then campaign.published_at
        else coalesce(campaign.published_at, v_now)
      end,
      cancelled_at = null,
      completed_at = null,
      last_error = null,
      updated_by = p_actor_id,
      updated_at = v_now,
      version = campaign.version + 1
  where campaign.id = p_campaign_id
    and campaign.version = p_expected_version
    and campaign.status in ('draft', 'scheduled', 'paused', 'failed')
  returning campaign.* into v_campaign;

  if not found then
    raise exception 'A campanha foi alterada em outra sessão ou não pode ser publicada.'
      using errcode = '40001';
  end if;

  insert into public.marketing_campaign_jobs (
    campaign_id,
    job_type,
    status,
    payload,
    attempts,
    max_attempts,
    available_at,
    locked_at,
    locked_by,
    last_error,
    completed_at,
    updated_at
  )
  values (
    v_campaign.id,
    'campaign_dispatch',
    'queued',
    jsonb_build_object('published_from', 'admin'),
    0,
    5,
    v_available_at,
    null,
    null,
    null,
    null,
    v_now
  )
  on conflict (campaign_id, job_type) do update
  set status = 'queued',
      payload = excluded.payload,
      attempts = 0,
      max_attempts = excluded.max_attempts,
      available_at = excluded.available_at,
      locked_at = null,
      locked_by = null,
      last_error = null,
      completed_at = null,
      updated_at = excluded.updated_at;

  return v_campaign;
end;
$$;

revoke execute on function public.publish_marketing_campaign(
  uuid, integer, text, timestamptz, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.publish_marketing_campaign(
  uuid, integer, text, timestamptz, boolean, uuid
) to service_role;

create or replace function public.claim_marketing_campaign_jobs(
  p_worker_id text,
  p_limit integer default 5,
  p_lease_seconds integer default 300
)
returns setof public.marketing_campaign_jobs
language sql
security invoker
set search_path = ''
as $$
  with candidates as (
    select job.id
    from public.marketing_campaign_jobs as job
    join public.marketing_campaigns as campaign on campaign.id = job.campaign_id
    where job.attempts < job.max_attempts
      and campaign.status not in ('paused', 'cancelled', 'completed')
      and (
        (
          job.status in ('queued', 'retry')
          and job.available_at <= now()
        )
        or (
          job.status = 'processing'
          and job.locked_at < now() - make_interval(
            secs => greatest(30, least(3600, coalesce(p_lease_seconds, 300)))
          )
        )
      )
    order by job.available_at asc, job.id asc
    for update of job skip locked
    limit greatest(1, least(50, coalesce(p_limit, 5)))
  )
  update public.marketing_campaign_jobs as job
  set status = 'processing',
      attempts = job.attempts + 1,
      locked_at = now(),
      locked_by = left(coalesce(nullif(trim(p_worker_id), ''), 'unknown-worker'), 180),
      updated_at = now()
  from candidates
  where job.id = candidates.id
  returning job.*;
$$;

revoke execute on function public.claim_marketing_campaign_jobs(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_marketing_campaign_jobs(text, integer, integer)
  to service_role;

create or replace function public.reserve_marketing_campaign_recipient(
  p_campaign_id uuid,
  p_recipient_key text,
  p_customer_id uuid,
  p_visitor_id text,
  p_selection_mode text,
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
  v_id uuid;
  v_key text := lower(trim(coalesce(p_recipient_key, '')));
  v_mode text := lower(trim(coalesce(p_selection_mode, '')));
  v_visitor text := nullif(trim(coalesce(p_visitor_id, '')), '');
  v_daily integer := 0;
  v_weekly integer := 0;
  v_counted_statuses text[];
begin
  if p_customer_id is not null then
    if v_key <> 'customer:' || p_customer_id::text then
      raise exception 'Destinatário de cliente inválido.' using errcode = '22023';
    end if;
  elsif v_visitor is not null then
    if v_key <> 'visitor:' || encode(sha256(convert_to(v_visitor, 'UTF8')), 'hex') then
      raise exception 'Destinatário de visitante inválido.' using errcode = '22023';
    end if;
  else
    raise exception 'Destinatário obrigatório.' using errcode = '22023';
  end if;

  if v_mode not in ('interest', 'discovery', 'all_opted_in', 'category', 'test') then
    raise exception 'Modo de seleção inválido.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_key || ':marketing-web-push', 0));

  if exists (
    select 1
    from public.marketing_campaign_recipients as recipient
    where recipient.campaign_id = p_campaign_id
      and recipient.recipient_key = v_key
  ) then
    return null;
  end if;

  v_counted_statuses := case
    when coalesce(p_dry_run, false)
      then array['selected', 'simulated', 'provider_accepted', 'partially_failed']::text[]
    else array['selected', 'provider_accepted', 'partially_failed']::text[]
  end;

  if greatest(0, coalesce(p_daily_cap, 0)) > 0 then
    select count(*)::integer
      into v_daily
    from public.marketing_campaign_recipients as recipient
    where recipient.recipient_key = v_key
      and recipient.status = any(v_counted_statuses)
      and recipient.created_at >= now() - interval '24 hours';

    if v_daily >= greatest(0, p_daily_cap) then
      return null;
    end if;
  end if;

  if greatest(0, coalesce(p_weekly_cap, 0)) > 0 then
    select count(*)::integer
      into v_weekly
    from public.marketing_campaign_recipients as recipient
    where recipient.recipient_key = v_key
      and recipient.status = any(v_counted_statuses)
      and recipient.created_at >= now() - interval '7 days';

    if v_weekly >= greatest(0, p_weekly_cap) then
      return null;
    end if;
  end if;

  insert into public.marketing_campaign_recipients (
    campaign_id,
    recipient_key,
    customer_id,
    visitor_id,
    selection_mode,
    category_key,
    match_score,
    status,
    metadata
  )
  values (
    p_campaign_id,
    v_key,
    p_customer_id,
    v_visitor,
    v_mode,
    nullif(left(trim(coalesce(p_category_key, '')), 120), ''),
    greatest(0, least(100, coalesce(p_match_score, 0))),
    case when coalesce(p_dry_run, false) then 'simulated' else 'selected' end,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (campaign_id, recipient_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.reserve_marketing_campaign_recipient(
  uuid, text, uuid, text, text, text, numeric, jsonb, integer, integer, boolean
) from public, anon, authenticated;
grant execute on function public.reserve_marketing_campaign_recipient(
  uuid, text, uuid, text, text, text, numeric, jsonb, integer, integer, boolean
) to service_role;

create or replace function public.register_marketing_campaign_click(
  p_token_hash text,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  campaign_id uuid,
  recipient_id uuid,
  destination_url text,
  click_count integer,
  first_click boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_link public.marketing_click_links%rowtype;
  v_first boolean;
begin
  select *
    into v_link
  from public.marketing_click_links as link
  where link.token_hash = lower(trim(coalesce(p_token_hash, '')))
    and link.expires_at > now()
  for update;

  if not found then
    return;
  end if;

  v_first := v_link.first_clicked_at is null;

  update public.marketing_click_links as link
  set first_clicked_at = coalesce(link.first_clicked_at, now()),
      last_clicked_at = now(),
      click_count = link.click_count + 1
  where link.id = v_link.id
  returning link.* into v_link;

  insert into public.marketing_campaign_events (
    campaign_id,
    recipient_id,
    event_type,
    event_key,
    metadata,
    occurred_at
  )
  values (
    v_link.campaign_id,
    v_link.recipient_id,
    'clicked',
    case when v_first then 'click:first:' || v_link.id::text else null end,
    coalesce(p_metadata, '{}'::jsonb),
    now()
  )
  on conflict (event_key) do nothing;

  return query
  select
    v_link.campaign_id,
    v_link.recipient_id,
    v_link.destination_url,
    v_link.click_count,
    v_first;
end;
$$;

revoke execute on function public.register_marketing_campaign_click(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.register_marketing_campaign_click(text, jsonb)
  to service_role;

create or replace view public.marketing_campaign_metrics
with (security_invoker = true)
as
with recipient_metrics as (
  select
    campaign_id,
    count(*)::bigint as selected_recipients,
    count(*) filter (where status = 'simulated')::bigint as simulated_recipients,
    count(*) filter (
      where status in ('provider_accepted', 'partially_failed')
    )::bigint as accepted_recipients,
    count(*) filter (where status = 'failed')::bigint as failed_recipients,
    count(*) filter (where selection_mode = 'interest')::bigint as interest_recipients,
    count(*) filter (where selection_mode = 'discovery')::bigint as discovery_recipients
  from public.marketing_campaign_recipients
  group by campaign_id
),
attempt_metrics as (
  select
    campaign_id,
    count(*)::bigint as device_attempts,
    count(*) filter (where status = 'provider_accepted')::bigint as provider_accepted_attempts,
    count(*) filter (where status = 'simulated')::bigint as simulated_attempts,
    count(*) filter (where status in ('failed', 'stale'))::bigint as failed_attempts
  from public.marketing_delivery_attempts
  group by campaign_id
),
click_metrics as (
  select
    campaign_id,
    count(*) filter (where first_clicked_at is not null)::bigint as unique_clicks,
    coalesce(sum(click_count), 0)::bigint as total_clicks
  from public.marketing_click_links
  group by campaign_id
),
conversion_metrics as (
  select
    campaign_id,
    count(*)::bigint as conversions,
    coalesce(sum(attributed_revenue), 0)::numeric(14,2) as attributed_revenue
  from public.marketing_order_attributions
  where status = 'converted'
  group by campaign_id
)
select
  campaign.id as campaign_id,
  coalesce(recipient.selected_recipients, 0) as selected_recipients,
  coalesce(recipient.simulated_recipients, 0) as simulated_recipients,
  coalesce(recipient.accepted_recipients, 0) as accepted_recipients,
  coalesce(recipient.failed_recipients, 0) as failed_recipients,
  coalesce(recipient.interest_recipients, 0) as interest_recipients,
  coalesce(recipient.discovery_recipients, 0) as discovery_recipients,
  coalesce(attempt.device_attempts, 0) as device_attempts,
  coalesce(attempt.provider_accepted_attempts, 0) as provider_accepted_attempts,
  coalesce(attempt.simulated_attempts, 0) as simulated_attempts,
  coalesce(attempt.failed_attempts, 0) as failed_attempts,
  coalesce(clicks.unique_clicks, 0) as unique_clicks,
  coalesce(clicks.total_clicks, 0) as total_clicks,
  coalesce(conversion.conversions, 0) as conversions,
  coalesce(conversion.attributed_revenue, 0)::numeric(14,2) as attributed_revenue,
  case
    when coalesce(recipient.accepted_recipients, 0) > 0
      then round(
        100.0 * coalesce(clicks.unique_clicks, 0)
        / recipient.accepted_recipients,
        2
      )
    else 0::numeric
  end as ctr_percent
from public.marketing_campaigns as campaign
left join recipient_metrics as recipient on recipient.campaign_id = campaign.id
left join attempt_metrics as attempt on attempt.campaign_id = campaign.id
left join click_metrics as clicks on clicks.campaign_id = campaign.id
left join conversion_metrics as conversion on conversion.campaign_id = campaign.id;

revoke all on table public.marketing_campaign_metrics from public, anon, authenticated;
grant select on table public.marketing_campaign_metrics to service_role;

create or replace view public.marketing_campaign_daily_metrics
with (security_invoker = true)
as
select
  event.campaign_id,
  event.occurred_at::date as metric_date,
  count(*) filter (where event.event_type = 'clicked')::bigint as clicks,
  count(*) filter (where event.event_type = 'order_paid')::bigint as conversions
from public.marketing_campaign_events as event
where event.event_type in ('clicked', 'order_paid')
group by event.campaign_id, event.occurred_at::date;

revoke all on table public.marketing_campaign_daily_metrics
  from public, anon, authenticated;
grant select on table public.marketing_campaign_daily_metrics to service_role;

insert into public.permissions_catalog (key, label, module, description, is_active)
values
  ('campaigns.view', 'Campanhas (visualizar)', 'campaigns', 'Permite visualizar campanhas e métricas.', true),
  ('campaigns.manage', 'Campanhas (gerenciar)', 'campaigns', 'Permite criar e editar rascunhos de campanhas.', true),
  ('campaigns.publish', 'Campanhas (publicar)', 'campaigns', 'Permite testar, agendar, publicar, pausar e cancelar campanhas.', true),
  ('campaigns.analytics', 'Campanhas (análises)', 'campaigns', 'Permite visualizar métricas detalhadas de campanhas.', true),
  ('promotions.manage', 'Promoções (gerenciar)', 'promotions', 'Permite criar e editar promoções e cupons.', true)
on conflict (key) do update
set
  label = excluded.label,
  module = excluded.module,
  description = excluded.description,
  is_active = excluded.is_active,
  updated_at = now();

create or replace function public.enqueue_smart_product_marketing_campaign()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_settings public.marketing_automation_settings%rowtype;
  v_event_type text;
  v_source text;
  v_campaign_id uuid;
  v_idempotency_key text;
  v_recent_exists boolean := false;
begin
  select * into v_settings
  from public.marketing_automation_settings
  where id = 1;

  if not coalesce(v_settings.enabled, false) then
    return new;
  end if;

  if lower(trim(coalesce(new.status, ''))) <> 'active'
     or coalesce(new.stock_quantity, 0) <= 0 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not v_settings.notify_product_launch then return new; end if;
    v_event_type := 'product_launch';
    v_source := 'product_trigger';
    v_idempotency_key := 'product:' || new.id::text || ':launch';
  elsif lower(trim(coalesce(old.status, ''))) <> 'active'
        and lower(trim(coalesce(new.status, ''))) = 'active' then
    if not v_settings.notify_product_reactivation then return new; end if;
    v_event_type := 'product_reactivation';
    v_source := 'reactivation_trigger';
    v_idempotency_key := 'product:' || new.id::text || ':reactivation:' || txid_current()::text;
  elsif coalesce(old.stock_quantity, 0) <= 0
        and coalesce(new.stock_quantity, 0) > 0 then
    if not v_settings.notify_product_restock then return new; end if;
    v_event_type := 'product_restock';
    v_source := 'restock_trigger';

    select exists (
      select 1
      from public.marketing_campaigns as campaign
      join public.marketing_campaign_items as item on item.campaign_id = campaign.id
      where item.product_id = new.id
        and campaign.campaign_type = 'product_restock'
        and campaign.created_at >= now() - make_interval(
          hours => greatest(1, least(2160, v_settings.restock_cooldown_hours))
        )
        and campaign.status not in ('cancelled', 'failed')
    ) into v_recent_exists;

    if v_recent_exists then return new; end if;
    v_idempotency_key := 'product:' || new.id::text || ':restock:' || txid_current()::text;
  else
    return new;
  end if;

  begin
    insert into public.marketing_campaigns (
      name,
      campaign_type,
      source,
      status,
      audience_mode,
      title,
      body,
      destination_url,
      dry_run,
      discovery_enabled,
      daily_cap,
      weekly_cap,
      idempotency_key,
      metadata,
      published_at
    )
    values (
      case
        when v_event_type = 'product_restock' then 'Reposição: ' || new.name
        when v_event_type = 'product_reactivation' then 'Produto reativado: ' || new.name
        else 'Lançamento: ' || new.name
      end,
      v_event_type,
      v_source,
      case when v_settings.auto_publish then 'queued' else 'draft' end,
      'smart',
      left(new.name, 120),
      left(
        case
          when v_event_type = 'product_restock'
            then new.name || ' voltou ao estoque. Toque para conferir.'
          when v_event_type = 'product_reactivation'
            then new.name || ' está disponível novamente. Toque para conferir.'
          else new.name || ' acabou de chegar. Toque para conhecer.'
        end,
        360
      ),
      null,
      v_settings.default_dry_run,
      v_settings.discovery_enabled,
      v_settings.daily_cap,
      v_settings.weekly_cap,
      v_idempotency_key,
      jsonb_build_object('automatic', true, 'product_id', new.id),
      case when v_settings.auto_publish then now() else null end
    )
    on conflict (idempotency_key) do nothing
    returning id into v_campaign_id;

    if v_campaign_id is null then return new; end if;

    insert into public.marketing_campaign_items (
      campaign_id,
      product_id,
      product_snapshot
    )
    values (
      v_campaign_id,
      new.id,
      jsonb_build_object(
        'id', new.id,
        'name', new.name,
        'sku', new.sku,
        'category', new.category,
        'price', new.price,
        'stock_quantity', new.stock_quantity,
        'status', new.status,
        'image_url', new.image_url,
        'image_card_url', new.image_card_url,
        'image_thumb_url', new.image_thumb_url
      )
    );

    if v_settings.auto_publish then
      insert into public.marketing_campaign_jobs (
        campaign_id,
        status,
        available_at,
        payload
      )
      values (
        v_campaign_id,
        'queued',
        now(),
        jsonb_build_object('source', v_source)
      )
      on conflict (campaign_id, job_type) do nothing;
    end if;
  exception
    when others then
      raise warning 'OZONTECK marketing outbox failed for product %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke execute on function public.enqueue_smart_product_marketing_campaign()
  from public, anon, authenticated;

-- A partir desta migration existe uma única fonte automática de campanhas.
-- As tabelas legadas continuam disponíveis somente como histórico.
drop trigger if exists products_enqueue_new_interest_campaign on public.products;
drop trigger if exists products_enqueue_smart_marketing_campaign on public.products;
create trigger products_enqueue_smart_marketing_campaign
after insert or update of status, stock_quantity on public.products
for each row execute function public.enqueue_smart_product_marketing_campaign();

comment on table public.marketing_campaigns is
  'Fonte única de campanhas manuais e automáticas, com conteúdo versionado e estado auditável.';
comment on table public.marketing_campaign_recipients is
  'Uma linha por pessoa pseudônima selecionada; não representa dispositivos individuais.';
comment on table public.marketing_delivery_attempts is
  'Uma linha por tentativa em dispositivo/canal para métricas honestas de entrega.';
comment on view public.marketing_campaign_metrics is
  'Métricas agregadas: aceite do provedor não significa leitura da notificação.';

commit;
