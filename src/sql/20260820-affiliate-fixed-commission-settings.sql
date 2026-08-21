-- Configuração global opcional de comissão fixa para a precificação de afiliados.
-- A configuração nasce DESATIVADA para preservar integralmente o comportamento atual
-- até que um administrador habilite explicitamente a comissão fixa.

create table if not exists public.affiliate_commission_settings (
  id text primary key default 'global',
  fixed_commission_enabled boolean not null default false,
  fixed_commission_percent numeric(5,2),
  updated_by_admin_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint affiliate_commission_settings_singleton_check
    check (id = 'global'),
  constraint affiliate_commission_settings_percent_check
    check (fixed_commission_percent is null or (fixed_commission_percent >= 0 and fixed_commission_percent <= 100)),
  constraint affiliate_commission_settings_enabled_percent_check
    check (not fixed_commission_enabled or fixed_commission_percent is not null)
);

insert into public.affiliate_commission_settings (
  id,
  fixed_commission_enabled,
  fixed_commission_percent
)
values ('global', false, null)
on conflict (id) do nothing;

alter table public.affiliate_commission_settings enable row level security;

revoke all on table public.affiliate_commission_settings from anon, authenticated;
grant select, insert, update, delete on table public.affiliate_commission_settings to service_role;

comment on table public.affiliate_commission_settings is
  'Configuração administrativa global da comissão fixa usada pela precificação. Quando desativada, preserva a comissão configurada por produto.';

comment on column public.affiliate_commission_settings.fixed_commission_percent is
  'Percentual global aplicado ao campo affiliate_commission_percent durante cálculo, salvamento e aplicação da precificação quando fixed_commission_enabled=true.';
