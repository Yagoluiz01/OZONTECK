-- Atualização necessária para a área de conta/login do cliente da loja.
-- Rode este SQL no Supabase antes de testar criação de conta real pelo site.

alter table public.customers
  add column if not exists password_hash text,
  add column if not exists cpf text,
  add column if not exists birth_date date,
  add column if not exists account_enabled boolean not null default false,
  add column if not exists newsletter_opt_in boolean not null default false,
  add column if not exists last_login_at timestamptz,
  add column if not exists updated_at timestamptz default now();

create index if not exists customers_email_lower_idx
  on public.customers (lower(email));

create index if not exists customers_account_enabled_idx
  on public.customers (account_enabled);
