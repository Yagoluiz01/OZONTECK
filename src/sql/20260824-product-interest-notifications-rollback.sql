-- Rollback isolado do módulo de notificações por interesse.
begin;

drop trigger if exists products_enqueue_new_interest_campaign
  on public.products;

drop function if exists public.enqueue_new_product_interest_campaign();
drop function if exists public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
);
drop function if exists public.suppress_customer_product_marketing(uuid, text);
drop function if exists public.reserve_product_interest_delivery(
  uuid, uuid, text, numeric, jsonb, integer, integer, boolean
);
drop function if exists public.claim_product_notification_jobs(text, integer, integer);

drop table if exists public.customer_notification_deliveries;
drop table if exists public.customer_marketing_push_subscriptions;
drop table if exists public.product_notification_jobs;
drop table if exists public.product_notification_campaigns;
drop table if exists public.customer_marketing_suppressions;
drop table if exists public.customer_interest_profiles;
drop table if exists public.customer_visitor_links;

commit;
