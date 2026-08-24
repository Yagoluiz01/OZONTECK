-- Rollback isolado da extensão Web Push das notificações por interesse.
begin;

drop function if exists public.reserve_product_interest_channel_delivery(
  uuid, uuid, text, text, numeric, jsonb, integer, integer, boolean
);

drop table if exists public.customer_marketing_push_subscriptions;

delete from public.customer_notification_deliveries
where channel = 'web_push';

delete from public.customer_marketing_suppressions
where channel = 'web_push';

alter table public.customer_notification_deliveries
  drop constraint if exists customer_notification_deliveries_channel_chk;

alter table public.customer_notification_deliveries
  add constraint customer_notification_deliveries_channel_chk
  check (channel in ('email'));

alter table public.customer_marketing_suppressions
  drop constraint if exists customer_marketing_suppressions_channel_chk;

alter table public.customer_marketing_suppressions
  add constraint customer_marketing_suppressions_channel_chk
  check (channel in ('email'));

commit;
