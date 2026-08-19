-- OZONTECK Admin - Etapa 4
-- Blindagem de brute force, invalidação global de sessões e versionamento de sessão.
-- Executar no Supabase ANTES de publicar os arquivos da API desta etapa.

begin;

alter table public.admins
  add column if not exists session_version bigint not null default 1;

alter table public.admin_sessions
  add column if not exists session_version bigint not null default 1;

alter table public.admins
  drop constraint if exists admins_session_version_check;
alter table public.admins
  add constraint admins_session_version_check check (session_version >= 1);

alter table public.admin_sessions
  drop constraint if exists admin_sessions_session_version_check;
alter table public.admin_sessions
  add constraint admin_sessions_session_version_check check (session_version >= 1);

create table if not exists public.admin_login_guard (
  identity_hash text primary key,
  failed_attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  last_failure_at timestamptz null,
  blocked_until timestamptz null,
  last_success_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint admin_login_guard_identity_hash_check
    check (identity_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_login_guard_failed_attempts_check
    check (failed_attempts >= 0)
);

create index if not exists idx_admin_login_guard_blocked_until
  on public.admin_login_guard (blocked_until)
  where blocked_until is not null;

create index if not exists idx_admin_login_guard_updated_at
  on public.admin_login_guard (updated_at);

alter table public.admin_login_guard enable row level security;
revoke all on table public.admin_login_guard from public, anon, authenticated;
grant all on table public.admin_login_guard to service_role;

create or replace function public.admin_login_guard_status(p_identity_hash text)
returns table (
  blocked boolean,
  retry_after_seconds integer,
  failed_attempts integer
)
language sql
security definer
set search_path = public
as $$
  select
    coalesce(g.blocked_until > now(), false) as blocked,
    case
      when g.blocked_until > now()
        then greatest(1, ceil(extract(epoch from (g.blocked_until - now())))::integer)
      else 0
    end as retry_after_seconds,
    coalesce(g.failed_attempts, 0) as failed_attempts
  from (select 1) seed
  left join public.admin_login_guard g
    on g.identity_hash = p_identity_hash;
$$;

create or replace function public.admin_login_guard_failure(
  p_identity_hash text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_block_seconds integer
)
returns table (
  blocked boolean,
  retry_after_seconds integer,
  failed_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.admin_login_guard%rowtype;
  v_failed integer;
  v_window_started timestamptz;
  v_blocked_until timestamptz;
begin
  if p_identity_hash is null
     or p_identity_hash !~ '^[a-f0-9]{64}$'
     or p_max_attempts < 2
     or p_window_seconds < 60
     or p_block_seconds < 60 then
    raise exception 'invalid admin login guard parameters';
  end if;

  insert into public.admin_login_guard (
    identity_hash,
    failed_attempts,
    window_started_at,
    updated_at
  ) values (
    p_identity_hash,
    0,
    v_now,
    v_now
  )
  on conflict (identity_hash) do nothing;

  select *
  into v_row
  from public.admin_login_guard
  where identity_hash = p_identity_hash
  for update;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    return query
      select
        true,
        greatest(1, ceil(extract(epoch from (v_row.blocked_until - v_now)))::integer),
        v_row.failed_attempts;
    return;
  end if;

  if v_row.window_started_at <= v_now - (p_window_seconds * interval '1 second') then
    v_failed := 1;
    v_window_started := v_now;
  else
    v_failed := v_row.failed_attempts + 1;
    v_window_started := v_row.window_started_at;
  end if;

  if v_failed >= p_max_attempts then
    v_blocked_until := v_now + (p_block_seconds * interval '1 second');
  else
    v_blocked_until := null;
  end if;

  update public.admin_login_guard
  set failed_attempts = v_failed,
      window_started_at = v_window_started,
      last_failure_at = v_now,
      blocked_until = v_blocked_until,
      updated_at = v_now
  where identity_hash = p_identity_hash;

  return query
    select
      v_blocked_until is not null,
      case
        when v_blocked_until is not null
          then greatest(1, ceil(extract(epoch from (v_blocked_until - v_now)))::integer)
        else 0
      end,
      v_failed;
end;
$$;

create or replace function public.admin_login_guard_success(p_identity_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_identity_hash is null or p_identity_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;

  update public.admin_login_guard
  set failed_attempts = 0,
      window_started_at = now(),
      blocked_until = null,
      last_success_at = now(),
      updated_at = now()
  where identity_hash = p_identity_hash;
end;
$$;

create or replace function public.bump_admin_session_version_by_auth_user(p_auth_user_id uuid)
returns table (
  admin_id uuid,
  new_session_version bigint,
  revoked_sessions integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_version bigint;
  v_revoked integer := 0;
begin
  update public.admins
  set session_version = greatest(1, coalesce(session_version, 1)) + 1
  where auth_user_id = p_auth_user_id
  returning id, session_version into v_admin_id, v_version;

  if v_admin_id is null then
    return;
  end if;

  update public.admin_sessions
  set revoked_at = coalesce(revoked_at, now()),
      revoke_reason = case
        when revoked_at is null then 'password_changed'
        else revoke_reason
      end
  where admin_id = v_admin_id
    and revoked_at is null;

  get diagnostics v_revoked = row_count;

  return query select v_admin_id, v_version, v_revoked;
end;
$$;

revoke all on function public.admin_login_guard_status(text) from public, anon, authenticated;
revoke all on function public.admin_login_guard_failure(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_login_guard_success(text) from public, anon, authenticated;
revoke all on function public.bump_admin_session_version_by_auth_user(uuid) from public, anon, authenticated;

grant execute on function public.admin_login_guard_status(text) to service_role;
grant execute on function public.admin_login_guard_failure(text, integer, integer, integer) to service_role;
grant execute on function public.admin_login_guard_success(text) to service_role;
grant execute on function public.bump_admin_session_version_by_auth_user(uuid) to service_role;

commit;
