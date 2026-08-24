-- Garante a sessão e registra o evento em uma única chamada e transação.
-- A função roda com os privilégios do chamador e só pode ser usada pela API.
create or replace function public.record_lead_tracking_event(
  p_session_id text,
  p_visitor_id text,
  p_event_type text,
  p_page text,
  p_section text,
  p_duration_ms integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_session_id is null or btrim(p_session_id) = '' then
    raise exception using
      errcode = '22023',
      message = 'session_id é obrigatório';
  end if;

  if p_event_type is null or btrim(p_event_type) = '' then
    raise exception using
      errcode = '22023',
      message = 'event_type é obrigatório';
  end if;

  insert into public.lead_sessions (
    session_id,
    visitor_id,
    started_at,
    ended_at,
    last_page,
    last_section,
    duration_seconds
  ) values (
    left(p_session_id, 500),
    p_visitor_id,
    now() at time zone 'UTC',
    null,
    p_page,
    p_section,
    0
  )
  on conflict (session_id) do nothing;

  insert into public.lead_events (
    session_id,
    visitor_id,
    event_type,
    page,
    section,
    duration_ms
  ) values (
    left(p_session_id, 500),
    p_visitor_id,
    p_event_type,
    p_page,
    p_section,
    greatest(0, least(coalesce(p_duration_ms, 0), 86400000))
  );
end;
$$;

revoke execute on function public.record_lead_tracking_event(
  text, text, text, text, text, integer
) from public, anon, authenticated;

grant execute on function public.record_lead_tracking_event(
  text, text, text, text, text, integer
) to service_role;
