-- Rollback da plataforma administrativa de campanhas.
-- Não remove o histórico legado product_notification_*.

begin;

drop trigger if exists products_enqueue_smart_marketing_campaign on public.products;
drop function if exists public.enqueue_smart_product_marketing_campaign();

-- Restaura o trigger legado caso a função anterior ainda exista.
do $$
begin
  if to_regprocedure('public.enqueue_new_product_interest_campaign()') is not null then
    drop trigger if exists products_enqueue_new_interest_campaign on public.products;
    create trigger products_enqueue_new_interest_campaign
      after insert or update of status, stock_quantity on public.products
      for each row execute function public.enqueue_new_product_interest_campaign();
  end if;
end;
$$;

drop view if exists public.marketing_campaign_daily_metrics;
drop view if exists public.marketing_campaign_metrics;
drop function if exists public.register_marketing_campaign_click(text, jsonb);
drop function if exists public.save_marketing_campaign_draft(
  uuid, integer, jsonb, jsonb, uuid
);
drop function if exists public.publish_marketing_campaign(
  uuid, integer, text, timestamptz, boolean, uuid
);
drop function if exists public.reserve_marketing_campaign_recipient(
  uuid, text, uuid, text, text, text, numeric, jsonb, integer, integer, boolean
);
drop function if exists public.claim_marketing_campaign_jobs(text, integer, integer);

delete from public.admin_permissions
where permission_key in (
  'campaigns.view',
  'campaigns.manage',
  'campaigns.publish',
  'campaigns.analytics',
  'promotions.manage'
);

delete from public.permissions_catalog
where key in (
  'campaigns.view',
  'campaigns.manage',
  'campaigns.publish',
  'campaigns.analytics',
  'promotions.manage'
);

drop table if exists public.marketing_order_attributions;
drop table if exists public.marketing_promotion_redemptions;
drop table if exists public.marketing_campaign_events;
drop table if exists public.marketing_click_links;
drop table if exists public.marketing_delivery_attempts;
drop table if exists public.marketing_campaign_recipients;
drop table if exists public.marketing_campaign_jobs;
drop table if exists public.marketing_promotion_categories;
drop table if exists public.marketing_promotion_products;
drop table if exists public.marketing_promotions;
drop table if exists public.marketing_campaign_items;
drop table if exists public.marketing_campaigns;
drop table if exists public.marketing_automation_settings;

commit;
