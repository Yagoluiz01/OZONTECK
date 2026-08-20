-- OZONTECK - Affiliate secure sessions / login guard / intrusion telemetry
-- Hardened revision. Idempotent and safe to re-run after the earlier local draft.

begin;

create extension if not exists pgcrypto;

create table if not exists public.affiliate_sessions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  session_version integer not null default 1,
  token_hash text not null unique,
  csrf_token_hash text not null,
  ip_hash text null,
  user_agent_hash text null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  revoked_at timestamptz null,
  revoke_reason text null
);

-- Constraints are NOT VALID so a pre-existing draft table cannot block deployment;
-- PostgreSQL still enforces them for every new/updated row.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'affiliate_sessions_session_version_check'
      and conrelid = 'public.affiliate_sessions'::regclass
  ) then
    alter table public.affiliate_sessions
      add constraint affiliate_sessions_session_version_check
      check (session_version >= 1) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'affiliate_sessions_token_hash_check'
      and conrelid = 'public.affiliate_sessions'::regclass
  ) then
    alter table public.affiliate_sessions
      add constraint affiliate_sessions_token_hash_check
      check (token_hash ~ '^[a-f0-9]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'affiliate_sessions_csrf_hash_check'
      and conrelid = 'public.affiliate_sessions'::regclass
  ) then
    alter table public.affiliate_sessions
      add constraint affiliate_sessions_csrf_hash_check
      check (csrf_token_hash ~ '^[a-f0-9]{64}$') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'affiliate_sessions_expiry_check'
      and conrelid = 'public.affiliate_sessions'::regclass
  ) then
    alter table public.affiliate_sessions
      add constraint affiliate_sessions_expiry_check
      check (
        expires_at > created_at
        and idle_expires_at > created_at
        and idle_expires_at <= expires_at
      ) not valid;
  end if;
end
$$;

create index if not exists idx_affiliate_sessions_affiliate_active
  on public.affiliate_sessions (affiliate_id, revoked_at, expires_at);
create index if not exists idx_affiliate_sessions_cleanup
  on public.affiliate_sessions (expires_at, revoked_at);

-- Defensive cleanup before enforcing the single-active-session invariant.
with ranked as (
  select
    id,
    row_number() over (
      partition by affiliate_id
      order by created_at desc, id desc
    ) as position
  from public.affiliate_sessions
  where revoked_at is null
)
update public.affiliate_sessions s
set revoked_at = now(),
    revoke_reason = 'migration_single_session_cleanup'
from ranked r
where s.id = r.id
  and r.position > 1;

create unique index if not exists uq_affiliate_sessions_one_active
  on public.affiliate_sessions (affiliate_id)
  where revoked_at is null;

alter table public.affiliate_sessions enable row level security;
revoke all on public.affiliate_sessions from public, anon, authenticated;
grant all on public.affiliate_sessions to service_role;

create or replace function public.create_affiliate_single_session(
  p_affiliate_id uuid,
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
  affiliate_id uuid,
  session_version integer,
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
  v_version integer;
  v_revoked integer := 0;
  v_id uuid;
begin
  if p_affiliate_id is null
     or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_csrf_token_hash, '') !~ '^[a-f0-9]{64}$'
     or p_created_at is null
     or p_expires_at <= p_created_at
     or p_idle_expires_at <= p_created_at
     or p_idle_expires_at > p_expires_at then
    raise exception 'Invalid affiliate session payload';
  end if;

  select greatest(coalesce(a.auth_token_version, 1), 1)
  into v_version
  from public.affiliates a
  where a.id = p_affiliate_id
  for update;

  if v_version is null then
    raise exception 'Affiliate not found';
  end if;

  update public.affiliate_sessions s
  set revoked_at = p_created_at,
      revoke_reason = 'concurrent_session_limit'
  where s.affiliate_id = p_affiliate_id
    and s.revoked_at is null;

  get diagnostics v_revoked = row_count;

  insert into public.affiliate_sessions (
    affiliate_id,
    session_version,
    token_hash,
    csrf_token_hash,
    ip_hash,
    user_agent_hash,
    created_at,
    last_seen_at,
    expires_at,
    idle_expires_at
  )
  values (
    p_affiliate_id,
    v_version,
    p_token_hash,
    p_csrf_token_hash,
    nullif(p_ip_hash, ''),
    nullif(p_user_agent_hash, ''),
    p_created_at,
    p_created_at,
    p_expires_at,
    p_idle_expires_at
  )
  returning public.affiliate_sessions.id into v_id;

  return query
  select
    s.id,
    s.affiliate_id,
    s.session_version,
    s.created_at,
    s.last_seen_at,
    s.expires_at,
    s.idle_expires_at,
    v_revoked
  from public.affiliate_sessions s
  where s.id = v_id;
end;
$$;

revoke all on function public.create_affiliate_single_session(
  uuid,text,text,timestamptz,timestamptz,timestamptz,text,text
) from public, anon, authenticated;
grant execute on function public.create_affiliate_single_session(
  uuid,text,text,timestamptz,timestamptz,timestamptz,text,text
) to service_role;

create table if not exists public.affiliate_login_guard (
  subject_hash text primary key,
  failed_attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_affiliate_login_guard_updated_at
  on public.affiliate_login_guard(updated_at);

alter table public.affiliate_login_guard enable row level security;
revoke all on public.affiliate_login_guard from public, anon, authenticated;
grant all on public.affiliate_login_guard to service_role;

create or replace function public.affiliate_login_guard_status(p_subject_hash text)
returns table(blocked boolean, failed_attempts integer, blocked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.affiliate_login_guard%rowtype;
begin
  select * into v
  from public.affiliate_login_guard
  where subject_hash = p_subject_hash;

  if not found then
    return query select false, 0, null::timestamptz;
    return;
  end if;

  return query
  select coalesce(v.blocked_until > now(), false), v.failed_attempts, v.blocked_until;
end;
$$;

create or replace function public.affiliate_login_guard_failure(
  p_subject_hash text,
  p_max_failures integer,
  p_window_minutes integer,
  p_block_minutes integer
)
returns table(blocked boolean, failed_attempts integer, blocked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.affiliate_login_guard%rowtype;
  v_now timestamptz := now();
begin
  if coalesce(p_subject_hash, '') !~ '^[a-f0-9]{64}$'
     or p_max_failures < 1
     or p_window_minutes < 1
     or p_block_minutes < 1 then
    raise exception 'Invalid affiliate login guard payload';
  end if;

  insert into public.affiliate_login_guard(
    subject_hash, failed_attempts, window_started_at, updated_at
  )
  values (p_subject_hash, 0, v_now, v_now)
  on conflict (subject_hash) do nothing;

  select * into v
  from public.affiliate_login_guard
  where subject_hash = p_subject_hash
  for update;

  if v.blocked_until is not null and v.blocked_until > v_now then
    return query select true, v.failed_attempts, v.blocked_until;
    return;
  end if;

  if v.window_started_at < v_now - make_interval(mins => p_window_minutes) then
    v.failed_attempts := 0;
    v.window_started_at := v_now;
    v.blocked_until := null;
  end if;

  v.failed_attempts := v.failed_attempts + 1;

  if v.failed_attempts >= p_max_failures then
    v.blocked_until := v_now + make_interval(mins => p_block_minutes);
  end if;

  update public.affiliate_login_guard
  set failed_attempts = v.failed_attempts,
      window_started_at = v.window_started_at,
      blocked_until = v.blocked_until,
      updated_at = v_now
  where subject_hash = p_subject_hash;

  return query
  select coalesce(v.blocked_until > v_now, false), v.failed_attempts, v.blocked_until;
end;
$$;

create or replace function public.affiliate_login_guard_success(p_subject_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.affiliate_login_guard where subject_hash = p_subject_hash;
$$;

revoke all on function public.affiliate_login_guard_status(text) from public, anon, authenticated;
revoke all on function public.affiliate_login_guard_failure(text,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.affiliate_login_guard_success(text) from public, anon, authenticated;
grant execute on function public.affiliate_login_guard_status(text) to service_role;
grant execute on function public.affiliate_login_guard_failure(text,integer,integer,integer) to service_role;
grant execute on function public.affiliate_login_guard_success(text) to service_role;

create table if not exists public.affiliate_login_security_attempts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid null references public.affiliates(id) on delete set null,
  identity_hash text not null,
  ip_hash text not null,
  user_agent_hash text null,
  success boolean not null,
  reason text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_affiliate_login_security_identity_time
  on public.affiliate_login_security_attempts(identity_hash, created_at desc);
create index if not exists idx_affiliate_login_security_ip_time
  on public.affiliate_login_security_attempts(ip_hash, created_at desc);
create index if not exists idx_affiliate_login_security_cleanup
  on public.affiliate_login_security_attempts(created_at);

alter table public.affiliate_login_security_attempts enable row level security;
revoke all on public.affiliate_login_security_attempts from public, anon, authenticated;
grant all on public.affiliate_login_security_attempts to service_role;

create table if not exists public.affiliate_security_events (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid null references public.affiliates(id) on delete set null,
  event_type text not null,
  severity text not null check (severity in ('high','critical')),
  dedupe_key text not null unique,
  identity_hash text null,
  ip_hash text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  notified_at timestamptz null
);

create index if not exists idx_affiliate_security_events_time
  on public.affiliate_security_events(created_at desc);

alter table public.affiliate_security_events enable row level security;
revoke all on public.affiliate_security_events from public, anon, authenticated;
grant all on public.affiliate_security_events to service_role;

-- Password-reset telemetry no longer stores raw IP/User-Agent for new requests.
alter table public.affiliate_password_resets
  add column if not exists ip_hash text null;
alter table public.affiliate_password_resets
  add column if not exists user_agent_hash text null;

alter table public.affiliate_password_resets enable row level security;
revoke all on public.affiliate_password_resets from public, anon, authenticated;
grant all on public.affiliate_password_resets to service_role;

create or replace function public.create_affiliate_password_reset_atomic(
  p_affiliate_id uuid,
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_ip_hash text default null,
  p_user_agent_hash text default null
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_id uuid;
begin
  if p_affiliate_id is null
     or nullif(trim(p_email), '') is null
     or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$'
     or p_expires_at <= v_now then
    raise exception 'Invalid affiliate password reset payload';
  end if;

  perform 1
  from public.affiliates a
  where a.id = p_affiliate_id
  for update;

  if not found then
    raise exception 'Affiliate not found';
  end if;

  update public.affiliate_password_resets r
  set used_at = v_now
  where r.affiliate_id = p_affiliate_id
    and r.used_at is null;

  insert into public.affiliate_password_resets (
    affiliate_id,
    email,
    token_hash,
    expires_at,
    ip_hash,
    user_agent_hash
  ) values (
    p_affiliate_id,
    lower(trim(p_email)),
    p_token_hash,
    p_expires_at,
    nullif(p_ip_hash, ''),
    nullif(p_user_agent_hash, '')
  )
  returning public.affiliate_password_resets.id into v_id;

  return query select v_id;
end;
$$;

revoke all on function public.create_affiliate_password_reset_atomic(
  uuid,text,text,timestamptz,text,text
) from public, anon, authenticated;
grant execute on function public.create_affiliate_password_reset_atomic(
  uuid,text,text,timestamptz,text,text
) to service_role;

-- Replaces the earlier reset RPC so password changes revoke active cookie sessions
-- inside the same transaction as auth_token_version increment.
create or replace function public.reset_affiliate_password_atomic(
  p_token_hash text,
  p_password_hash text
)
returns table (
  affiliate_id uuid,
  auth_token_version integer,
  password_changed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reset_id uuid;
  v_affiliate_id uuid;
  v_now timestamptz := now();
begin
  if coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$'
     or nullif(trim(p_password_hash), '') is null then
    return;
  end if;

  select r.id, r.affiliate_id
  into v_reset_id, v_affiliate_id
  from public.affiliate_password_resets r
  where r.token_hash = p_token_hash
    and r.used_at is null
    and r.expires_at > v_now
  order by r.created_at desc
  limit 1
  for update skip locked;

  if v_reset_id is null or v_affiliate_id is null then
    return;
  end if;

  -- Consume every outstanding token for the account, including the selected one.
  update public.affiliate_password_resets r
  set used_at = v_now
  where r.affiliate_id = v_affiliate_id
    and r.used_at is null;

  update public.affiliates a
  set
    password_hash = p_password_hash,
    auth_token_version = greatest(coalesce(a.auth_token_version, 1), 1) + 1,
    password_changed_at = v_now,
    updated_at = v_now
  where a.id = v_affiliate_id
  returning a.id, a.auth_token_version, a.password_changed_at
  into affiliate_id, auth_token_version, password_changed_at;

  if affiliate_id is null then
    raise exception 'Afiliado do token de redefinição não encontrado.';
  end if;

  update public.affiliate_sessions s
  set revoked_at = v_now,
      revoke_reason = 'password_reset'
  where s.affiliate_id = v_affiliate_id
    and s.revoked_at is null;

  return next;
end;
$$;

revoke all on function public.reset_affiliate_password_atomic(text, text)
  from public, anon, authenticated;
grant execute on function public.reset_affiliate_password_atomic(text, text)
  to service_role;

create or replace function public.cleanup_affiliate_security_telemetry(
  p_attempt_days integer default 7,
  p_event_days integer default 90,
  p_session_days integer default 30,
  p_guard_days integer default 30
)
returns table(
  deleted_attempts bigint,
  deleted_events bigint,
  deleted_sessions bigint,
  deleted_guard_rows bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts bigint := 0;
  v_events bigint := 0;
  v_sessions bigint := 0;
  v_guard bigint := 0;
begin
  delete from public.affiliate_login_security_attempts
  where created_at < now() - make_interval(days => greatest(p_attempt_days, 1));
  get diagnostics v_attempts = row_count;

  delete from public.affiliate_security_events
  where created_at < now() - make_interval(days => greatest(p_event_days, 1));
  get diagnostics v_events = row_count;

  delete from public.affiliate_sessions
  where (
    revoked_at is not null
    or expires_at < now()
  )
    and greatest(coalesce(revoked_at, expires_at), expires_at)
      < now() - make_interval(days => greatest(p_session_days, 1));
  get diagnostics v_sessions = row_count;

  delete from public.affiliate_login_guard
  where updated_at < now() - make_interval(days => greatest(p_guard_days, 1))
    and (blocked_until is null or blocked_until < now());
  get diagnostics v_guard = row_count;

  return query select v_attempts, v_events, v_sessions, v_guard;
end;
$$;

revoke all on function public.cleanup_affiliate_security_telemetry(integer,integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.cleanup_affiliate_security_telemetry(integer,integer,integer,integer)
  to service_role;

commit;
