-- Registra o evento e atualiza o contador do banner em uma única chamada.
-- A função roda com os privilégios do chamador e só pode ser usada pela API.
create or replace function public.record_banner_tracking_event(
  p_banner_id uuid,
  p_event_type text,
  p_click_type text,
  p_view_duration_ms integer,
  p_session_id text,
  p_timestamp timestamp without time zone,
  p_user_agent text,
  p_screen_width integer,
  p_screen_height integer,
  p_viewport_width integer,
  p_viewport_height integer,
  p_device_type text,
  p_browser text,
  p_os text,
  p_ip_address text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_banner_id is null or p_session_id is null or btrim(p_session_id) = '' then
    raise exception using
      errcode = '22023',
      message = 'banner_id e session_id são obrigatórios';
  end if;

  if p_event_type not in ('impression', 'click', 'view_duration') then
    raise exception using
      errcode = '22023',
      message = 'event_type inválido';
  end if;

  insert into public.banner_tracking (
    banner_id,
    event_type,
    click_type,
    view_duration_ms,
    session_id,
    "timestamp",
    user_agent,
    screen_width,
    screen_height,
    viewport_width,
    viewport_height,
    device_type,
    browser,
    os,
    ip_address
  ) values (
    p_banner_id,
    p_event_type,
    p_click_type,
    p_view_duration_ms,
    left(p_session_id, 255),
    coalesce(p_timestamp, now() at time zone 'UTC'),
    p_user_agent,
    p_screen_width,
    p_screen_height,
    p_viewport_width,
    p_viewport_height,
    p_device_type,
    p_browser,
    p_os,
    p_ip_address
  );

  if p_event_type = 'impression' then
    update public.banners
    set views_count = coalesce(views_count, 0) + 1
    where id = p_banner_id;
  elsif p_event_type = 'click' then
    update public.banners
    set clicks_count = coalesce(clicks_count, 0) + 1
    where id = p_banner_id;
  end if;
end;
$$;

revoke execute on function public.record_banner_tracking_event(
  uuid, text, text, integer, text, timestamp without time zone, text,
  integer, integer, integer, integer, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_banner_tracking_event(
  uuid, text, text, integer, text, timestamp without time zone, text,
  integer, integer, integer, integer, text, text, text, text
) to service_role;
