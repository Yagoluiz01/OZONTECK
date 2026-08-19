-- OZONTECK Admin - Etapa 5
-- Detecção de brute force / credential stuffing e alertas exclusivos ao admin master.
-- Execute no Supabase antes de ativar os arquivos da API desta etapa.

begin;

alter table public.admin_notifications
  add column if not exists recipient_admin_id uuid null
    references public.admins(id) on delete cascade;

create index if not exists idx_admin_notifications_recipient_created
  on public.admin_notifications (recipient_admin_id, created_at desc);

create table if not exists public.admin_login_security_attempts (
  id uuid primary key default gen_random_uuid(),
  identity_hash text not null,
  ip_hash text not null,
  user_agent_hash text not null,
  admin_id uuid null references public.admins(id) on delete set null,
  success boolean not null default false,
  reason text not null default 'unknown',
  rate_limited boolean not null default false,
  created_at timestamptz not null default now(),
  constraint admin_login_security_attempts_identity_hash_check
    check (identity_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_login_security_attempts_ip_hash_check
    check (ip_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_login_security_attempts_user_agent_hash_check
    check (user_agent_hash ~ '^[a-f0-9]{64}$')
);

create index if not exists idx_admin_login_security_identity_time
  on public.admin_login_security_attempts (identity_hash, created_at desc);

create index if not exists idx_admin_login_security_ip_time
  on public.admin_login_security_attempts (ip_hash, created_at desc);

create index if not exists idx_admin_login_security_failure_time
  on public.admin_login_security_attempts (created_at desc)
  where success = false;

create table if not exists public.admin_security_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  severity text not null,
  dedupe_key text not null unique,
  identity_hash text null,
  ip_hash text null,
  admin_id uuid null references public.admins(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  notified_at timestamptz null,
  resolved_at timestamptz null,
  constraint admin_security_events_severity_check
    check (severity in ('medium','high','critical')),
  constraint admin_security_events_status_check
    check (status in ('open','investigating','resolved','false_positive')),
  constraint admin_security_events_identity_hash_check
    check (identity_hash is null or identity_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_security_events_ip_hash_check
    check (ip_hash is null or ip_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_security_events_dedupe_key_check
    check (dedupe_key ~ '^[a-f0-9]{64}$')
);

create index if not exists idx_admin_security_events_created
  on public.admin_security_events (created_at desc);

create index if not exists idx_admin_security_events_open
  on public.admin_security_events (severity, created_at desc)
  where status in ('open','investigating');

alter table public.admin_login_security_attempts enable row level security;
alter table public.admin_security_events enable row level security;

revoke all on table public.admin_login_security_attempts from public, anon, authenticated;
revoke all on table public.admin_security_events from public, anon, authenticated;

grant all on table public.admin_login_security_attempts to service_role;
grant all on table public.admin_security_events to service_role;

commit;
