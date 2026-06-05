-- OZONTECK | Histórico de atividades administrativas
-- Execute uma única vez no SQL Editor do Supabase.
-- A tabela não possui políticas públicas: somente a API com service_role acessa os dados.

create extension if not exists pgcrypto;

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid null,
  actor_user_id uuid null,
  actor_email text null,
  actor_name text null,
  actor_role text null,
  action text not null,
  module text not null,
  entity_type text null,
  entity_id text null,
  description text null,
  old_values jsonb null,
  new_values jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet null,
  user_agent text null,
  request_id text null,
  status text not null default 'success'
    check (status in ('success', 'failure')),
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_created_at_idx
  on public.admin_audit_logs (created_at desc);

create index if not exists admin_audit_logs_admin_id_idx
  on public.admin_audit_logs (admin_id, created_at desc);

create index if not exists admin_audit_logs_module_idx
  on public.admin_audit_logs (module, created_at desc);

create index if not exists admin_audit_logs_action_idx
  on public.admin_audit_logs (action, created_at desc);

create index if not exists admin_audit_logs_status_idx
  on public.admin_audit_logs (status, created_at desc);

alter table public.admin_audit_logs enable row level security;

revoke all on table public.admin_audit_logs from anon;
revoke all on table public.admin_audit_logs from authenticated;

grant select, insert on table public.admin_audit_logs to service_role;

comment on table public.admin_audit_logs is
  'Registro imutável das ações administrativas críticas da OZONTECK.';
