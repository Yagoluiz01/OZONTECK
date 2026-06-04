-- Solicitações de acesso ao painel administrativo OZONTECK
-- Rode este SQL no Supabase antes de subir a API.

create table if not exists public.admin_access_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  auth_user_id uuid,
  requested_role text not null default 'administrator',
  status text not null default 'pending',
  rejection_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  auth_user_created_by_request boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint admin_access_requests_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint admin_access_requests_email_check
    check (position('@' in email) > 1)
);

create index if not exists idx_admin_access_requests_email
  on public.admin_access_requests (lower(email));

create index if not exists idx_admin_access_requests_status_created
  on public.admin_access_requests (status, created_at desc);

create or replace function public.set_admin_access_requests_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_admin_access_requests_updated_at on public.admin_access_requests;
create trigger trg_admin_access_requests_updated_at
before update on public.admin_access_requests
for each row
execute function public.set_admin_access_requests_updated_at();

alter table public.admin_access_requests enable row level security;

-- A API usa SUPABASE_SERVICE_ROLE_KEY, então as policies abaixo deixam o acesso público bloqueado.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'admin_access_requests'
      and policyname = 'Bloquear leitura publica de solicitacoes admin'
  ) then
    create policy "Bloquear leitura publica de solicitacoes admin"
      on public.admin_access_requests
      for select
      using (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'admin_access_requests'
      and policyname = 'Bloquear escrita publica de solicitacoes admin'
  ) then
    create policy "Bloquear escrita publica de solicitacoes admin"
      on public.admin_access_requests
      for all
      using (false)
      with check (false);
  end if;
end $$;
