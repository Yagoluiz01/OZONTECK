-- OZONTECK Admin - sessão única atômica por administrador
-- Etapa 4.1
-- O login mais recente vence: qualquer sessão anterior é revogada na mesma transação.

begin;

create or replace function public.create_admin_single_session(
  p_admin_id uuid,
  p_token_hash text,
  p_csrf_token_hash text,
  p_created_at timestamptz,
  p_expires_at timestamptz,
  p_idle_expires_at timestamptz,
  p_ip_hash text,
  p_user_agent_hash text
)
returns table (
  id uuid,
  admin_id uuid,
  auth_user_id uuid,
  session_version bigint,
  created_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz,
  idle_expires_at timestamptz,
  revoked_sessions integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_auth_user_id uuid;
  v_session_version bigint;
  v_new_session_id uuid;
  v_revoked integer := 0;
  v_now timestamptz := now();
begin
  if p_admin_id is null then
    raise exception 'admin id required';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid session token hash';
  end if;

  if p_csrf_token_hash is null or p_csrf_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid csrf token hash';
  end if;

  if p_created_at is null
     or p_expires_at is null
     or p_idle_expires_at is null
     or p_expires_at <= p_created_at
     or p_idle_expires_at <= p_created_at
     or p_idle_expires_at > p_expires_at then
    raise exception 'invalid session lifetime';
  end if;

  -- Serializa todos os logins do mesmo administrador, inclusive logins simultâneos.
  perform pg_advisory_xact_lock(hashtextextended(p_admin_id::text, 0));

  -- Também bloqueia a linha do admin para sincronizar com troca de senha/session_version.
  select a.auth_user_id, a.session_version
    into v_admin_auth_user_id, v_session_version
  from public.admins a
  where a.id = p_admin_id
  for update;

  if not found then
    raise exception 'admin not found';
  end if;

  if v_session_version is null or v_session_version < 1 then
    raise exception 'invalid admin session version';
  end if;

  -- Política de sessão única: revoga absolutamente todas as sessões anteriores.
  update public.admin_sessions s
  set revoked_at = coalesce(s.revoked_at, v_now),
      revoke_reason = case
        when s.revoked_at is null then 'concurrent_session_limit'
        else s.revoke_reason
      end
  where s.admin_id = p_admin_id
    and s.revoked_at is null;

  get diagnostics v_revoked = row_count;

  insert into public.admin_sessions (
    admin_id,
    auth_user_id,
    session_version,
    token_hash,
    csrf_token_hash,
    ip_hash,
    user_agent_hash,
    created_at,
    last_seen_at,
    expires_at,
    idle_expires_at
  ) values (
    p_admin_id,
    v_admin_auth_user_id,
    v_session_version,
    p_token_hash,
    p_csrf_token_hash,
    nullif(p_ip_hash, ''),
    nullif(p_user_agent_hash, ''),
    p_created_at,
    p_created_at,
    p_expires_at,
    p_idle_expires_at
  )
  returning public.admin_sessions.id into v_new_session_id;

  return query
  select
    s.id,
    s.admin_id,
    s.auth_user_id,
    s.session_version,
    s.created_at,
    s.last_seen_at,
    s.expires_at,
    s.idle_expires_at,
    v_revoked
  from public.admin_sessions s
  where s.id = v_new_session_id;
end;
$$;

revoke all on function public.create_admin_single_session(
  uuid, text, text, timestamptz, timestamptz, timestamptz, text, text
) from public, anon, authenticated;

grant execute on function public.create_admin_single_session(
  uuid, text, text, timestamptz, timestamptz, timestamptz, text, text
) to service_role;

commit;
