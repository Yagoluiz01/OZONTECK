-- Exclusão administrativa e atômica de todas as campanhas de marketing.
-- Preserva produtos, clientes, inscrições Push e perfis de interesse.

begin;

create or replace function public.purge_marketing_campaign_data(
  p_confirmation text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_campaigns bigint := 0;
  v_jobs bigint := 0;
  v_recipients bigint := 0;
  v_attempts bigint := 0;
  v_click_links bigint := 0;
  v_events bigint := 0;
  v_attributions bigint := 0;
  v_promotions bigint := 0;
  v_redemptions bigint := 0;
begin
  if p_confirmation is distinct from 'EXCLUIR TODAS AS CAMPANHAS' then
    raise exception using
      errcode = '22023',
      message = 'Confirmação inválida para excluir todas as campanhas.';
  end if;

  lock table public.marketing_campaigns in share row exclusive mode;

  select count(*) into v_campaigns from public.marketing_campaigns;
  select count(*) into v_jobs from public.marketing_campaign_jobs;
  select count(*) into v_recipients from public.marketing_campaign_recipients;
  select count(*) into v_attempts from public.marketing_delivery_attempts;
  select count(*) into v_click_links from public.marketing_click_links;
  select count(*) into v_events from public.marketing_campaign_events;
  select count(*) into v_attributions
    from public.marketing_order_attributions
   where campaign_id in (select id from public.marketing_campaigns);
  select count(*) into v_promotions
    from public.marketing_promotions
   where campaign_id in (select id from public.marketing_campaigns);
  select count(*) into v_redemptions
    from public.marketing_promotion_redemptions
   where campaign_id in (select id from public.marketing_campaigns)
      or promotion_id in (
        select id
          from public.marketing_promotions
         where campaign_id in (select id from public.marketing_campaigns)
      );

  delete from public.marketing_promotion_redemptions
   where campaign_id in (select id from public.marketing_campaigns)
      or promotion_id in (
        select id
          from public.marketing_promotions
         where campaign_id in (select id from public.marketing_campaigns)
      );

  delete from public.marketing_order_attributions
   where campaign_id in (select id from public.marketing_campaigns);

  delete from public.marketing_promotions
   where campaign_id in (select id from public.marketing_campaigns);

  delete from public.marketing_campaigns;

  return jsonb_build_object(
    'campaigns', v_campaigns,
    'jobs', v_jobs,
    'recipients', v_recipients,
    'delivery_attempts', v_attempts,
    'click_links', v_click_links,
    'events', v_events,
    'order_attributions', v_attributions,
    'linked_promotions', v_promotions,
    'promotion_redemptions', v_redemptions
  );
end;
$$;

revoke all on function public.purge_marketing_campaign_data(text) from public;
revoke all on function public.purge_marketing_campaign_data(text) from anon;
revoke all on function public.purge_marketing_campaign_data(text) from authenticated;
grant execute on function public.purge_marketing_campaign_data(text) to service_role;

comment on function public.purge_marketing_campaign_data(text) is
  'Exclui atomicamente campanhas e histórico relacionado após confirmação explícita; uso exclusivo da API.';

commit;
