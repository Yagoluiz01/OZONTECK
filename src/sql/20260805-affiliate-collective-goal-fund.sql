-- Fundo coletivo de metas e proteção do ganho nominal do afiliado.
-- Execute antes de publicar a API/Admin desta entrega.

begin;

alter table public.product_pricing
  add column if not exists goal_funding_mode text not null default 'collective_fund',
  add column if not exists goal_fund_reserve_percent numeric(7,4) not null default 3,
  add column if not exists goal_fund_reserve_value numeric(14,2) not null default 0,
  add column if not exists goal_bonus_liability_value numeric(14,2) not null default 0,
  add column if not exists goal_fund_unfunded_gap_value numeric(14,2) not null default 0,
  add column if not exists commission_protection_mode text not null default 'value_floor',
  add column if not exists affiliate_commission_floor_value numeric(14,2) not null default 0,
  add column if not exists network_commission_floor_value numeric(14,2) not null default 0;

alter table public.product_pricing
  drop constraint if exists product_pricing_goal_funding_mode_check;
alter table public.product_pricing
  add constraint product_pricing_goal_funding_mode_check
  check (goal_funding_mode in ('collective_fund', 'legacy_unit_provision'));

alter table public.product_pricing
  drop constraint if exists product_pricing_commission_protection_mode_check;
alter table public.product_pricing
  add constraint product_pricing_commission_protection_mode_check
  check (commission_protection_mode in ('value_floor', 'percentage_only'));

alter table public.product_pricing
  drop constraint if exists product_pricing_goal_fund_reserve_percent_check;
alter table public.product_pricing
  add constraint product_pricing_goal_fund_reserve_percent_check
  check (goal_fund_reserve_percent >= 0 and goal_fund_reserve_percent <= 100);

alter table public.product_pricing_history
  add column if not exists goal_funding_mode text,
  add column if not exists goal_fund_reserve_percent numeric(7,4),
  add column if not exists goal_fund_reserve_value numeric(14,2),
  add column if not exists goal_bonus_liability_value numeric(14,2),
  add column if not exists goal_fund_unfunded_gap_value numeric(14,2),
  add column if not exists commission_protection_mode text,
  add column if not exists affiliate_commission_floor_value numeric(14,2),
  add column if not exists network_commission_floor_value numeric(14,2);

-- Mantém o valor nominal que já era exibido/pago ao afiliado antes de reduzir preços.
update public.product_pricing pp
set affiliate_commission_floor_value = greatest(
      coalesce(pp.affiliate_commission_floor_value, 0),
      coalesce(pp.direct_commission_value, 0),
      round(coalesce(p.price, 0) * coalesce(pp.affiliate_commission_percent, 0) / 100.0, 2)
    ),
    network_commission_floor_value = greatest(
      coalesce(pp.network_commission_floor_value, 0),
      coalesce(pp.network_commission_value, 0),
      round(coalesce(p.price, 0) * coalesce(pp.network_commission_percent, 0) / 100.0, 2)
    ),
    goal_funding_mode = coalesce(nullif(pp.goal_funding_mode, ''), 'collective_fund'),
    goal_fund_reserve_percent = coalesce(pp.goal_fund_reserve_percent, 3),
    commission_protection_mode = coalesce(nullif(pp.commission_protection_mode, ''), 'value_floor'),
    goal_bonus_liability_value = greatest(
      coalesce(pp.goal_bonus_liability_value, 0),
      coalesce(pp.goal_bonus_value, 0),
      coalesce(pp.goal_bonus_per_sale, 0)
    )
from public.products p
where p.id = pp.product_id;

create table if not exists public.affiliate_goal_fund_settings (
  id text primary key default 'global',
  reserve_percent numeric(7,4) not null default 3,
  minimum_coverage_percent numeric(7,4) not null default 120,
  monthly_marketing_budget numeric(14,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint affiliate_goal_fund_settings_singleton_check check (id = 'global'),
  constraint affiliate_goal_fund_settings_reserve_check check (reserve_percent >= 0 and reserve_percent <= 100),
  constraint affiliate_goal_fund_settings_coverage_check check (minimum_coverage_percent >= 0),
  constraint affiliate_goal_fund_settings_budget_check check (monthly_marketing_budget >= 0)
);

insert into public.affiliate_goal_fund_settings (
  id,
  reserve_percent,
  minimum_coverage_percent,
  monthly_marketing_budget,
  is_active
) values ('global', 3, 120, 0, true)
on conflict (id) do nothing;

create table if not exists public.affiliate_goal_fund_ledger (
  id uuid primary key default gen_random_uuid(),
  entry_type text not null,
  direction text not null,
  amount numeric(14,2) not null,
  order_id uuid null,
  affiliate_id uuid null,
  conversion_id uuid null,
  product_id uuid null,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint affiliate_goal_fund_ledger_amount_check check (amount > 0),
  constraint affiliate_goal_fund_ledger_direction_check check (direction in ('credit', 'debit')),
  constraint affiliate_goal_fund_ledger_entry_type_check check (
    entry_type in (
      'order_reserve',
      'goal_bonus_debit',
      'marketing_budget',
      'manual_adjustment_credit',
      'manual_adjustment_debit'
    )
  ),
  constraint affiliate_goal_fund_ledger_idempotency_key_key unique (idempotency_key)
);

create index if not exists idx_affiliate_goal_fund_ledger_created_at
  on public.affiliate_goal_fund_ledger (created_at desc);
create index if not exists idx_affiliate_goal_fund_ledger_order
  on public.affiliate_goal_fund_ledger (order_id)
  where order_id is not null;
create index if not exists idx_affiliate_goal_fund_ledger_conversion
  on public.affiliate_goal_fund_ledger (conversion_id)
  where conversion_id is not null;

alter table public.affiliate_goal_fund_settings enable row level security;
alter table public.affiliate_goal_fund_ledger enable row level security;
revoke all on table public.affiliate_goal_fund_settings from anon, authenticated;
revoke all on table public.affiliate_goal_fund_ledger from anon, authenticated;
grant select, insert, update, delete on table public.affiliate_goal_fund_settings to service_role;
grant select, insert, update, delete on table public.affiliate_goal_fund_ledger to service_role;

create or replace view public.affiliate_goal_fund_summary as
select
  coalesce(sum(case when l.direction = 'credit' then l.amount else 0 end), 0)::numeric(14,2) as total_credits,
  coalesce(sum(case when l.direction = 'debit' then l.amount else 0 end), 0)::numeric(14,2) as total_debits,
  coalesce(sum(case when l.direction = 'credit' then l.amount else -l.amount end), 0)::numeric(14,2) as balance,
  count(*) filter (where l.entry_type = 'order_reserve')::integer as funded_orders,
  count(*) filter (where l.entry_type = 'goal_bonus_debit')::integer as paid_goal_bonuses,
  coalesce(sum(l.amount) filter (where l.entry_type = 'order_reserve'), 0)::numeric(14,2) as order_reserves,
  coalesce(sum(l.amount) filter (where l.entry_type = 'goal_bonus_debit'), 0)::numeric(14,2) as goal_bonuses_paid,
  case
    when coalesce(sum(case when l.direction = 'credit' then l.amount else -l.amount end), 0) >= 0
      then 'healthy'
    else 'underfunded'
  end as status
from public.affiliate_goal_fund_ledger l;

grant select on public.affiliate_goal_fund_summary to service_role;

create or replace function public.oz_sync_affiliate_goal_fund_bonus_debit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(14,2);
  v_product_id uuid;
begin
  if lower(coalesce(new.conversion_type, '')) <> 'product_goal_bonus' then
    return new;
  end if;

  if lower(coalesce(new.status, '')) not in (
    'approved', 'aprovado', 'released', 'liberado', 'paid', 'pago'
  ) then
    return new;
  end if;

  v_amount := round(greatest(coalesce(new.commission_amount, 0), 0)::numeric, 2);

  if v_amount <= 0 then
    return new;
  end if;

  begin
    v_product_id := nullif(new.metadata ->> 'product_id', '')::uuid;
  exception when others then
    v_product_id := null;
  end;

  insert into public.affiliate_goal_fund_ledger (
    entry_type,
    direction,
    amount,
    order_id,
    affiliate_id,
    conversion_id,
    product_id,
    idempotency_key,
    metadata
  ) values (
    'goal_bonus_debit',
    'debit',
    v_amount,
    new.order_id,
    new.affiliate_id,
    new.id,
    v_product_id,
    'goal-bonus:' || new.id::text,
    jsonb_build_object(
      'source', 'affiliate_conversion_trigger',
      'conversion_type', new.conversion_type,
      'conversion_status', new.status,
      'original_metadata', coalesce(new.metadata, '{}'::jsonb)
    )
  )
  on conflict (idempotency_key) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_sync_affiliate_goal_fund_bonus_debit
  on public.affiliate_conversions;
create trigger trg_sync_affiliate_goal_fund_bonus_debit
after insert or update of status, commission_amount, metadata
on public.affiliate_conversions
for each row
execute function public.oz_sync_affiliate_goal_fund_bonus_debit();

-- Reconstrói no livro-caixa os bônus de metas que já haviam sido liberados.
insert into public.affiliate_goal_fund_ledger (
  entry_type,
  direction,
  amount,
  order_id,
  affiliate_id,
  conversion_id,
  product_id,
  idempotency_key,
  metadata,
  created_at
)
select
  'goal_bonus_debit',
  'debit',
  round(greatest(coalesce(c.commission_amount, 0), 0)::numeric, 2),
  c.order_id,
  c.affiliate_id,
  c.id,
  case
    when coalesce(c.metadata ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (c.metadata ->> 'product_id')::uuid
    else null
  end,
  'goal-bonus:' || c.id::text,
  jsonb_build_object(
    'source', 'migration_backfill',
    'conversion_type', c.conversion_type,
    'conversion_status', c.status,
    'original_metadata', coalesce(c.metadata, '{}'::jsonb)
  ),
  coalesce(c.released_at, c.approved_at, c.created_at, now())
from public.affiliate_conversions c
where lower(coalesce(c.conversion_type, '')) = 'product_goal_bonus'
  and lower(coalesce(c.status, '')) in (
    'approved', 'aprovado', 'released', 'liberado', 'paid', 'pago'
  )
  and coalesce(c.commission_amount, 0) > 0
on conflict (idempotency_key) do nothing;

-- Compatibilidade com os eventos adicionados ao histórico da precificação.
alter table public.product_pricing_history
  drop constraint if exists product_pricing_history_event_type_check;
alter table public.product_pricing_history
  add constraint product_pricing_history_event_type_check
  check (
    event_type in (
      'save_pricing',
      'apply_price',
      'affiliate_program_enabled',
      'affiliate_program_disabled'
    )
  );

comment on table public.affiliate_goal_fund_ledger is
  'Livro-caixa do fundo coletivo que financia bônus de metas sem reduzir a comissão nominal do afiliado.';
comment on column public.product_pricing.affiliate_commission_floor_value is
  'Valor mínimo nominal por unidade que protege o ganho do afiliado vendedor após reduções de preço.';
comment on column public.product_pricing.goal_fund_reserve_percent is
  'Percentual da base de produtos elegíveis reservado no fundo coletivo em pedidos pagos.';

commit;
