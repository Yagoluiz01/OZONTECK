-- OZONTECK Admin - sessões opacas e revogáveis
-- Aplicar no Supabase ANTES de publicar a versão da API que cria cookies de sessão.

begin;

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  auth_user_id uuid null,
  token_hash text not null unique,
  csrf_token_hash text not null,
  ip_hash text null,
  user_agent_hash text null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  revoked_at timestamptz null,
  revoke_reason text null,

  constraint admin_sessions_token_hash_check
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_sessions_csrf_token_hash_check
    check (csrf_token_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_sessions_expiry_check
    check (expires_at > created_at),
  constraint admin_sessions_idle_expiry_check
    check (idle_expires_at > created_at and idle_expires_at <= expires_at)
);

create index if not exists idx_admin_sessions_admin_active
  on public.admin_sessions (admin_id, revoked_at, expires_at desc);

create index if not exists idx_admin_sessions_expiration
  on public.admin_sessions (expires_at)
  where revoked_at is null;

create index if not exists idx_admin_sessions_idle_expiration
  on public.admin_sessions (idle_expires_at)
  where revoked_at is null;

alter table public.admin_sessions enable row level security;

-- Nenhum cliente anon/authenticated acessa sessões diretamente.
-- A API usa a service role e bypassa RLS.
revoke all on table public.admin_sessions from anon, authenticated;
grant all on table public.admin_sessions to service_role;

commit;
