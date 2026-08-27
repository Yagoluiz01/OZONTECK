-- Verificação somente leitura da plataforma de campanhas.
-- Execute após a migration e antes de habilitar qualquer worker.

with checks(check_name, ok) as (
  values
    (
      'campaign_table_exists',
      to_regclass('public.marketing_campaigns') is not null
    ),
    (
      'recipient_table_exists',
      to_regclass('public.marketing_campaign_recipients') is not null
    ),
    (
      'attempt_table_exists',
      to_regclass('public.marketing_delivery_attempts') is not null
    ),
    (
      'click_table_exists',
      to_regclass('public.marketing_click_links') is not null
    ),
    (
      'attribution_table_exists',
      to_regclass('public.marketing_order_attributions') is not null
    ),
    (
      'metrics_view_exists',
      to_regclass('public.marketing_campaign_metrics') is not null
    ),
    (
      'daily_metrics_view_exists',
      to_regclass('public.marketing_campaign_daily_metrics') is not null
    ),
    (
      'foreign_key_support_indexes_present',
      to_regclass('public.marketing_automation_settings_updated_by_idx') is not null
      and to_regclass('public.marketing_campaigns_created_by_idx') is not null
      and to_regclass('public.marketing_campaigns_updated_by_idx') is not null
      and to_regclass('public.marketing_campaigns_published_by_idx') is not null
      and to_regclass('public.marketing_promotions_campaign_idx') is not null
      and to_regclass('public.marketing_promotions_created_by_idx') is not null
      and to_regclass('public.marketing_promotions_updated_by_idx') is not null
      and to_regclass('public.marketing_promotion_products_product_idx') is not null
      and to_regclass('public.marketing_campaign_recipients_customer_idx') is not null
      and to_regclass('public.marketing_delivery_attempts_subscription_idx') is not null
      and to_regclass('public.marketing_click_links_campaign_idx') is not null
      and to_regclass('public.marketing_campaign_events_recipient_idx') is not null
      and to_regclass('public.marketing_campaign_events_attempt_idx') is not null
      and to_regclass('public.marketing_promotion_redemptions_campaign_idx') is not null
      and to_regclass('public.marketing_promotion_redemptions_order_idx') is not null
      and to_regclass('public.marketing_order_attributions_campaign_idx') is not null
      and to_regclass('public.marketing_order_attributions_recipient_idx') is not null
    ),
    (
      'campaign_rls_enabled',
      coalesce((
        select class.relrowsecurity
        from pg_class as class
        join pg_namespace as namespace on namespace.oid = class.relnamespace
        where namespace.nspname = 'public'
          and class.relname = 'marketing_campaigns'
      ), false)
    ),
    (
      'recipient_rls_enabled',
      coalesce((
        select class.relrowsecurity
        from pg_class as class
        join pg_namespace as namespace on namespace.oid = class.relnamespace
        where namespace.nspname = 'public'
          and class.relname = 'marketing_campaign_recipients'
      ), false)
    ),
    (
      'anon_campaign_access_blocked',
      not has_table_privilege('anon', 'public.marketing_campaigns', 'SELECT')
    ),
    (
      'authenticated_campaign_access_blocked',
      not has_table_privilege('authenticated', 'public.marketing_campaigns', 'SELECT')
    ),
    (
      'service_role_campaign_access',
      has_table_privilege('service_role', 'public.marketing_campaigns', 'SELECT,INSERT,UPDATE,DELETE')
    ),
    (
      'atomic_draft_function_exists',
      to_regprocedure(
        'public.save_marketing_campaign_draft(uuid,integer,jsonb,jsonb,uuid)'
      ) is not null
    ),
    (
      'atomic_publish_function_exists',
      to_regprocedure(
        'public.publish_marketing_campaign(uuid,integer,text,timestamp with time zone,boolean,uuid)'
      ) is not null
    ),
    (
      'claim_function_exists',
      to_regprocedure(
        'public.claim_marketing_campaign_jobs(text,integer,integer)'
      ) is not null
    ),
    (
      'recipient_reservation_function_exists',
      to_regprocedure(
        'public.reserve_marketing_campaign_recipient(uuid,text,uuid,text,text,text,numeric,jsonb,integer,integer,boolean)'
      ) is not null
    ),
    (
      'click_function_exists',
      to_regprocedure(
        'public.register_marketing_campaign_click(text,jsonb)'
      ) is not null
    ),
    (
      'single_product_trigger',
      (
        select count(*)
        from pg_trigger as trigger
        where trigger.tgrelid = 'public.products'::regclass
          and not trigger.tgisinternal
          and trigger.tgname = 'products_enqueue_smart_marketing_campaign'
      ) = 1
    ),
    (
      'legacy_product_trigger_removed',
      not exists (
        select 1
        from pg_trigger as trigger
        where trigger.tgrelid = 'public.products'::regclass
          and not trigger.tgisinternal
          and trigger.tgname = 'products_enqueue_new_interest_campaign'
      )
    )
)
select
  bool_and(ok) as all_checks_ok,
  coalesce(
    jsonb_agg(check_name order by check_name) filter (where not ok),
    '[]'::jsonb
  ) as failed_checks
from checks;

select
  enabled,
  auto_publish,
  default_dry_run,
  notify_product_launch,
  notify_product_reactivation,
  notify_product_restock,
  discovery_enabled,
  daily_cap,
  weekly_cap
from public.marketing_automation_settings
where id = 1;

select
  count(*) filter (where key like 'campaigns.%') as campaign_permissions,
  count(*) filter (where key = 'promotions.manage') as promotion_permissions
from public.permissions_catalog
where key in (
  'campaigns.view',
  'campaigns.manage',
  'campaigns.publish',
  'campaigns.analytics',
  'promotions.manage'
);
