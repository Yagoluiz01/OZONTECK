-- OZONTECK: otimizações de escala da loja pública.
-- Revisar e aplicar em janela de manutenção. Não altera regras de pedido/pagamento.

-- Hot path da inteligência: visitor + event_type + janela temporal.
create index concurrently if not exists idx_lead_events_visitor_event_created_at_desc
  on public.lead_events (visitor_id, event_type, created_at desc);

-- Registra até 25 eventos em uma única viagem API -> Postgres.
create or replace function public.record_lead_tracking_events_batch(p_events jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted_count integer := 0;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception using errcode = '22023', message = 'p_events deve ser um array JSON';
  end if;

  if jsonb_array_length(p_events) > 25 then
    raise exception using errcode = '22023', message = 'máximo de 25 eventos por lote';
  end if;

  insert into public.lead_sessions (
    session_id, visitor_id, started_at, ended_at, last_page, last_section, duration_seconds
  )
  select distinct on (e.session_id)
    left(e.session_id, 500),
    nullif(e.visitor_id, ''),
    now() at time zone 'UTC',
    null,
    nullif(e.page, ''),
    nullif(e.section, ''),
    0
  from (
    select
      btrim(coalesce(item->>'session_id', '')) as session_id,
      btrim(coalesce(item->>'visitor_id', '')) as visitor_id,
      btrim(coalesce(item->>'page', '')) as page,
      btrim(coalesce(item->>'section', '')) as section
    from jsonb_array_elements(p_events) item
  ) e
  where e.session_id <> ''
  order by e.session_id
  on conflict (session_id) do nothing;

  insert into public.lead_events (
    session_id, visitor_id, event_type, page, section, duration_ms
  )
  select
    left(e.session_id, 500),
    nullif(e.visitor_id, ''),
    e.event_type,
    nullif(e.page, ''),
    nullif(e.section, ''),
    greatest(0, least(e.duration_ms, 86400000))
  from (
    select
      btrim(coalesce(item->>'session_id', '')) as session_id,
      btrim(coalesce(item->>'visitor_id', '')) as visitor_id,
      btrim(coalesce(item->>'event_type', '')) as event_type,
      btrim(coalesce(item->>'page', '')) as page,
      btrim(coalesce(item->>'section', '')) as section,
      coalesce(nullif(item->>'duration_ms', '')::integer, 0) as duration_ms
    from jsonb_array_elements(p_events) item
  ) e
  where e.session_id <> '' and e.event_type <> '';

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke execute on function public.record_lead_tracking_events_batch(jsonb)
  from public, anon, authenticated;
grant execute on function public.record_lead_tracking_events_batch(jsonb)
  to service_role;
