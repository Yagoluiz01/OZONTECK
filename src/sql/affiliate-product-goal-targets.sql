-- OZONTECK — Meta segura específica por produto (Etapa 1)
-- Cria somente a estrutura de configuração. Ainda não altera a contagem real do afiliado.

create extension if not exists pgcrypto;

create table if not exists public.affiliate_product_goal_targets (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  affiliate_level_id uuid not null references public.affiliate_levels(id) on delete cascade,
  required_units integer not null check (required_units > 0),
  global_required_conversions_snapshot integer not null check (global_required_conversions_snapshot > 0),
  accumulated_bonus_amount numeric(14,2) not null default 0 check (accumulated_bonus_amount >= 0),
  safe_contribution_per_unit numeric(14,2) not null default 0 check (safe_contribution_per_unit >= 0),
  reference_price numeric(14,2) not null default 0 check (reference_price >= 0),
  protected_margin_percent numeric(8,2) not null default 0 check (protected_margin_percent >= 0),
  safety_reserve_percent numeric(8,2) not null default 15 check (safety_reserve_percent >= 0),
  calculation_snapshot jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by text null,
  applied_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint affiliate_product_goal_targets_product_level_key
    unique (product_id, affiliate_level_id)
);

create index if not exists idx_affiliate_product_goal_targets_product
  on public.affiliate_product_goal_targets (product_id)
  where is_active = true;

create index if not exists idx_affiliate_product_goal_targets_level
  on public.affiliate_product_goal_targets (affiliate_level_id)
  where is_active = true;

alter table public.affiliate_product_goal_targets enable row level security;

revoke all on table public.affiliate_product_goal_targets from anon;
revoke all on table public.affiliate_product_goal_targets from authenticated;
grant select, insert, update, delete on table public.affiliate_product_goal_targets to service_role;

comment on table public.affiliate_product_goal_targets is
  'Metas seguras específicas por produto e nível. Etapa 1 salva configuração; a contagem real será integrada em etapa posterior.';
